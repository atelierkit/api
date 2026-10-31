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
}

/** 一次同步的执行结果 */
export type SyncResult =
  | { ok: true; rowsWritten: number; stage: string }
  | { ok: false; code: string; message: string };

/** 单条记录映射写入（由子类实现） */
type Writer = (date: string, records: BaostockRecord[]) => Promise<number>;

/**
 * 「按交易日」同步器的公共流程
 *
 * 流程骨架：读台账 → 定起点与上界（不可变量）→ 取区间内交易日清单 → 逐日串行：
 * 请求 → 校验 → 映射写入 → 当天结束即推进台账 → 报确定进度。
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
      }
      if (
        options.warnOnCountDrop &&
        previousCount !== null &&
        records.length < (previousCount * 7) / 10
      ) {
        // 条数骤降哨兵：只告警不阻塞
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
  }

  if (writtenTotal === 0) {
    return {
      ok: true,
      rowsWritten: 0,
      stage: `段 ${dataset} 无新增数据（覆盖至 ${currentWatermark.lastDate}）`,
    };
  }

  return { ok: true, rowsWritten: writtenTotal, stage: '完成' };
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
