// 内部依赖
import type { BaostockRecord } from '../source/baostock.record.js';
import type { BaostockQuery } from '../source/baostock.query.js';
import type { BaostockClient } from '../source/baostock.client.js';
import type { ProgressSink } from './progress.js';
import type { SyncTarget } from './sync.types.js';
import { coverageScopeOf } from './sync.types.js';
import { advanceWatermark, type Watermark } from './watermark.js';

/** 同步器仓储依赖（按交易日） */
export interface DailyBatchDeps {
  /** 读台账 */
  findWatermark(scope: string, dataset: string): Promise<Watermark | null>;
  /** 写台账 */
  saveWatermark(watermark: Watermark): Promise<void>;
  /** 取日历覆盖末日 */
  latestCalendarDate(): Promise<string | null>;
  /** 取区间内的日历日（isOpen 标记） */
  calendarRange(from: string, to: string): Promise<{ date: string; isOpen: boolean }[]>;
  /** 数据源客户端 */
  client: BaostockClient;
  /** 告警出口（条数骤降这类「不阻塞但要留痕」的情况走这里） */
  warn?: (message: string) => void;
  /**
   * 取消检查（每天走完之后问一次）；缺省 = 不检查
   *
   * ⚠ 只在「一天完整走完、台账已落库」之后问：中途停会让当天写了一半的数据失去台账保护。
   */
  shouldAbort?: () => Promise<boolean>;
  /**
   * 重算该数据集在库里的总行数；缺省 = 按本次写入条数累加
   *
   * ⚠ 累加口径有洞：`upsert` 返回的是「提交的行数」而不是「新增的行数」，重跑同一区间
   *    （显式指定 from/to）会把同一批行重复计入。有它就以库为准。
   */
  countRows?: () => Promise<number>;
}

/** 一次同步的执行结果 */
export type SyncResult =
  | {
      ok: true;
      rowsWritten: number;
      stage: string;
      /** 是否因被暂停而提前收尾（沿用成功语义，但台账停在断点上） */
      aborted?: true;
    }
  | { ok: false; code: string; message: string };

/** 单条记录映射写入（由子类实现） */
type Writer = (date: string, records: BaostockRecord[]) => Promise<number>;

/**
 * 「按交易日」同步器的公共流程
 *
 * 流程骨架：读台账 → 定起点与上界（不可变量）→ 取区间内交易日清单 → 逐日串行：
 * 请求 → 校验 → 映射写入 → 当天结束即推进台账 → 报确定进度 → 问一次是否该停。
 *
 * ⚠ 逐日提交是断点续传的唯一保证；循环变量是请求时算好的清单，循环内不改写；
 * 取消令牌只在「一天完整走完之后」检查。
 */
export async function runDailyBatch(
  target: SyncTarget,
  dataset: string,
  scopeFrom: string | null,
  scopeTo: string | null,
  deps: DailyBatchDeps,
  buildQuery: (date: string) => BaostockQuery,
  requiredFields: readonly string[],
  write: Writer,
  options: {
    /** 交易日返回 0 条是否为正常（true = 照常推进台账） */
    emptyResponseIsNormal?: boolean;
    /** 进度阶段名 */
    progressStage: string;
    /** 是否启用条数骤降哨兵 */
    warnOnCountDrop?: boolean;
  },
  progress: ProgressSink,
): Promise<SyncResult> {
  const scope = coverageScopeOf(target);
  const watermark =
    (await deps.findWatermark(scope, dataset)) ??
    ({ scope, dataset, parameters: '', lastDate: null, rows: 0 } as Watermark);

  // 起点：台账是「已覆盖到哪」的唯一权威
  const start = watermark.lastDate
    ? addDays(watermark.lastDate, 1)
    : scopeFrom;
  if (start === null) {
    return {
      ok: false,
      code: 'sync.bydate_missing_start',
      message: `段 ${dataset} 既没有台账也没有显式起点 —— 首次同步请带上起始日期。`,
    };
  }

  // 上界：min(请求上界, 日历覆盖末日)
  const calendarLatest = await deps.latestCalendarDate();
  let upper = scopeTo ?? calendarLatest;
  if (upper !== null && calendarLatest !== null && upper > calendarLatest) {
    upper = calendarLatest;
  }
  if (upper === null) {
    return {
      ok: false,
      code: 'sync.calendar_not_covered',
      message: '交易日历为空 —— 按交易日同步强依赖日历，请先同步交易日历再重试。',
    };
  }

  if (start > upper) {
    return { ok: true, rowsWritten: 0, stage: '已是最新' };
  }

  // 日历覆盖检查：区间内一条日历记录都没有 = 没覆盖 ⇒ 失败
  const days = await deps.calendarRange(start, upper);
  if (days.length === 0) {
    return {
      ok: false,
      code: 'sync.calendar_not_covered',
      message: `交易日历没有覆盖 [${start} ~ ${upper}] —— 请先同步交易日历再重试。`,
    };
  }

  const tradeDays = days.filter((d) => d.isOpen).map((d) => d.date);
  if (tradeDays.length === 0) {
    return { ok: true, rowsWritten: 0, stage: '区间内没有交易日（长假段）' };
  }

  progress.report({
    stage: options.progressStage,
    done: 0,
    total: tradeDays.length,
    fact: null,
  });

  let currentWatermark = watermark;
  let writtenTotal = 0;
  let previousCount: number | null = null;

  for (let index = 0; index < tradeDays.length; index++) {
    const day = tradeDays[index];

    const dayStart = Date.now();
    const records = await deps.client.query(buildQuery(day));

    if (records.length === 0 && !options.emptyResponseIsNormal) {
      // 数据源未发布该日 ⇒ 停本段、台账不动
      currentWatermark = await refreshRows(currentWatermark, deps);
      return {
        ok: true,
        rowsWritten: writtenTotal,
        stage: `数据源未发布 ${day} 的数据，本段停止于断点 ${currentWatermark.lastDate ?? '（无）'}`,
      };
    }

    let writtenToday = 0;
    if (records.length > 0) {
      if (previousCount === null) {
        ensureRequiredFields(target, day, records[0], requiredFields);
      } else if (
        options.warnOnCountDrop === true &&
        records.length < (previousCount * 7) / 10
      ) {
        // 条数骤降哨兵：只告警不阻塞（停段会掩盖「数据源发布不全」与「列名错位丢行」的区别，
        // 但完全不提示就等于没有哨兵）
        deps.warn?.(
          `${options.progressStage}：${day} 只返回 ${records.length} 条，前一交易日为 ${previousCount} 条 —— ` +
            '降幅超过 30%，请核对数据源是否发布完整或列名是否错位。',
        );
      }
      writtenToday = await write(day, records);
      writtenTotal += writtenToday;
      previousCount = records.length;
    }

    const dayElapsed = Date.now() - dayStart;

    // 写成功之后才推进台账，粒度 1 天；累计 = 既有 + 当天写入
    currentWatermark = advanceWatermark(currentWatermark, day, writtenToday);
    await deps.saveWatermark(currentWatermark);

    progress.report({
      stage: options.progressStage,
      done: index + 1,
      total: tradeDays.length,
      fact: { date: day, page: null, count: records.length, elapsedMs: dayElapsed, label: null },
    });

    // 取消检查放在「一天完整走完」之后：此时台账已推进，下次从下一天继续
    if (deps.shouldAbort !== undefined && (await deps.shouldAbort())) {
      currentWatermark = await refreshRows(currentWatermark, deps);
      return {
        ok: true,
        rowsWritten: writtenTotal,
        stage: `已暂停，断点停在 ${currentWatermark.lastDate ?? '（无）'}`,
        aborted: true,
      };
    }
  }

  currentWatermark = await refreshRows(currentWatermark, deps);

  if (writtenTotal === 0) {
    return {
      ok: true,
      rowsWritten: 0,
      stage: `段 ${dataset} 无新增数据（覆盖至 ${currentWatermark.lastDate}）`,
    };
  }

  return { ok: true, rowsWritten: writtenTotal, stage: '完成' };
}

/** 以库为准校正台账的记录数（没有 countRows 就原样返回） */
async function refreshRows(
  watermark: Watermark,
  deps: DailyBatchDeps,
): Promise<Watermark> {
  if (deps.countRows === undefined) {
    return watermark;
  }
  const next = { ...watermark, rows: await deps.countRows() };
  await deps.saveWatermark(next);
  return next;
}

/** 在第一条记录上校验响应列名齐全 */
function ensureRequiredFields(
  target: SyncTarget,
  day: string,
  record: BaostockRecord,
  requiredFields: readonly string[],
): void {
  const missing = requiredFields.filter((field) => !record.has(field));
  if (missing.length > 0) {
    throw new Error(
      `${target} 在 ${day} 的响应缺少字段：${missing.join(', ')} —— 疑似列名错位或数据源接口变更。`,
    );
  }
}

/** 日期加一天（YYYY-MM-DD） */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
