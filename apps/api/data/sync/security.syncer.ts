// 内部依赖
import type { BaostockRecord } from '../source/baostock.record.js';
import { BaostockQueries } from '../source/baostock.query.js';
import { FIELD, SECURITY_TYPE, SECURITY_STATUS } from '../source/baostock.schema.js';
import type { ProgressSink } from './progress.js';
import type { DailyBatchDeps } from './daily-batch.js';
import type { SyncResult } from './daily-batch.js';
import { COVERAGE_SCOPE, WHOLE_MARKET } from './sync.types.js';
import type { Watermark } from './watermark.js';

/** 证券同步器仓储 */
export interface SecurityStore {
  upsertSecurities(rows: SecurityRow[]): Promise<number>;
}

/** securities 的一行 */
export interface SecurityRow {
  code: string;
  name: string;
  type: string;
  market: string;
  listDate: string | null;
  delistDate: string | null;
  status: string;
}

/** 证券同步器依赖（整份快照 + 台账） */
export interface SecuritySyncerDeps {
  client: DailyBatchDeps['client'];
  store: SecurityStore;
  /** 写台账（整份快照：`lastDate` 记本次同步日，语义是「这份快照是哪天的」） */
  saveWatermark(watermark: Watermark): Promise<void>;
  /** 今天（业务时区） */
  today(): string;
  /** 重算 securities 总行数；缺省按本次提交条数累计 */
  countSecurities?: () => Promise<number>;
  /** 取消检查（每页结束问一次）；缺省 = 不检查 */
  shouldAbort?: () => Promise<boolean>;
}

const PAGE_SIZE = 500;

/**
 * 证券基础信息同步器（整份快照，逐页提交）
 *
 * ⚠ 退市证券必须写进库（回测按历史时点判定），不做「只保留上市证券」的过滤。
 * 类型/状态/交易所落库为枚举名（与 almanac 一致，可读）。
 * ⚠ 必须写台账：这张卡片的「覆盖至 / 记录数」只读台账，不读 securities 表 ——
 *   不写就会永远显示空，即使库里有几千条。
 */
export async function syncSecurities(
  deps: SecuritySyncerDeps,
  progress: ProgressSink,
): Promise<SyncResult> {
  const stage = '拉取证券基础信息';
  let page = 1;
  let writtenTotal = 0;
  let fetched = 0;

  while (true) {
    const records = await deps.client.query(
      BaostockQueries.stockBasic('anonymous', page, PAGE_SIZE, ''),
    );
    if (records.length === 0) {
      break;
    }

    const rows = records
      .map(toSecurityRow)
      .filter((r): r is SecurityRow => r !== null);

    writtenTotal += await deps.store.upsertSecurities(rows);
    fetched += records.length;

    progress.report({
      stage,
      done: fetched,
      total: 0, // 总量未知
      fact: { date: null, page, count: rows.length, elapsedMs: 0, label: null },
    });

    if (deps.shouldAbort !== undefined && (await deps.shouldAbort())) {
      await writeWatermark(deps, fetched);
      return {
        ok: true,
        rowsWritten: writtenTotal,
        stage: `已暂停（已拉取 ${fetched} 条）`,
        aborted: true,
      };
    }

    if (records.length < PAGE_SIZE) {
      break;
    }
    page++;
  }

  if (fetched === 0) {
    return {
      ok: false,
      code: 'sync.security_empty',
      message: '数据源没有返回任何证券记录 —— 请核对请求参数与字段位。',
    };
  }

  await writeWatermark(deps, fetched);
  return { ok: true, rowsWritten: writtenTotal, stage: '完成' };
}

/** 写证券台账：快照日期 + 以库为准的记录数 */
async function writeWatermark(
  deps: SecuritySyncerDeps,
  fetched: number,
): Promise<void> {
  const rows =
    deps.countSecurities === undefined
      ? fetched
      : await deps.countSecurities();
  await deps.saveWatermark({
    scope: COVERAGE_SCOPE.SECURITY,
    dataset: WHOLE_MARKET,
    parameters: '',
    lastDate: deps.today(),
    rows,
  });
}

/** 记录 → securities 行；代码缺失时为 null */
function toSecurityRow(record: BaostockRecord): SecurityRow | null {
  const code = record.get(FIELD.SECURITY.CODE) ?? '';
  if (!code.trim()) {
    return null;
  }
  const type = parseInt(record.get(FIELD.SECURITY.TYPE) ?? '0', 10);
  const status = parseInt(record.get(FIELD.SECURITY.STATUS) ?? '0', 10);

  return {
    code,
    name: record.get(FIELD.SECURITY.NAME) ?? '',
    type: typeName(type),
    market: marketOf(code),
    listDate: dateOrNull(record.get(FIELD.SECURITY.LIST_DATE)),
    delistDate: dateOrNull(record.get(FIELD.SECURITY.DELIST_DATE)),
    status: statusName(status),
  };
}

/** 数据源类型取值 → 落库枚举名（1 股票 / 2 指数 / 4 可转债 / 5 ETF/基金；其余 Unknown） */
function typeName(type: number): string {
  switch (type) {
    case SECURITY_TYPE.STOCK:
      return 'Stock';
    case SECURITY_TYPE.INDEX:
      return 'Index';
    case SECURITY_TYPE.BOND:
      return 'Bond';
    case SECURITY_TYPE.FUND:
      return 'Fund';
    default:
      return 'Unknown';
  }
}

/** 数据源状态取值 → 落库枚举名（1 上市 / 0 退市；其余 Unknown） */
function statusName(status: number): string {
  switch (status) {
    case SECURITY_STATUS.LISTED:
      return 'Listed';
    case SECURITY_STATUS.DELISTED:
      return 'Delisted';
    default:
      return 'Unknown';
  }
}

/** 从代码前缀推断交易所（落库用 almanac 枚举名，不是前缀本身） */
function marketOf(code: string): string {
  if (code.startsWith('sh.')) {
    return 'Shanghai';
  }
  if (code.startsWith('sz.')) {
    return 'Shenzhen';
  }
  if (code.startsWith('bj.')) {
    return 'Beijing';
  }
  return 'Unknown';
}

function dateOrNull(value: string | undefined): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  return value;
}
