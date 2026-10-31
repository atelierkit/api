// 内部依赖
import type { BaostockRecord } from '../source/baostock.record.js';
import { BaostockQueries } from '../source/baostock.query.js';
import { FIELD } from '../source/baostock.schema.js';
import type { ProgressSink } from './progress.js';
import { runDailyBatch, type DailyBatchDeps, type SyncResult } from './daily-batch.js';
import { SYNC_TARGET } from './sync.types.js';

/** 按交易日同步器所需的额外仓储（写 bars） */
export interface BarByDateStore {
  upsertBars(rows: BarRow[]): Promise<number>;
}

/** bars 的一行 */
export interface BarRow {
  code: string;
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  preClose: string | null;
  volume: string;
  amount: string | null;
  turnoverRate: string | null;
  changePercent: string | null;
  tradeStatus: string;
  isSt: boolean;
  peTtm: string | null;
  pbMrq: string | null;
  psTtm: string | null;
  pcfNcfTtm: string | null;
}

const REQUIRED_FIELDS: readonly string[] = [
  FIELD.BAR.DATE,
  FIELD.BAR.CODE,
  FIELD.BAR.OPEN,
  FIELD.BAR.HIGH,
  FIELD.BAR.LOW,
  FIELD.BAR.CLOSE,
  FIELD.BAR.PRE_CLOSE,
  FIELD.BAR.VOLUME,
  FIELD.BAR.AMOUNT,
  FIELD.BAR.ADJUST_FLAG,
  FIELD.BAR.TURNOVER_RATE,
  FIELD.BAR.TRADE_STATUS,
  FIELD.BAR.CHANGE_PERCENT,
  FIELD.BAR.PE_TTM,
  FIELD.BAR.PB_MRQ,
  FIELD.BAR.PS_TTM,
  FIELD.BAR.PCF_NCF_TTM,
  FIELD.BAR.IS_ST,
];

/**
 * A 股日 K 同步器（按交易日，一次请求取当日全市场）
 *
 * ⚠ 交易日返回 0 条 = 数据源未发布 ⇒ 停本段、不推进台账（默认语义）。
 */
export async function syncBarByDate(
  dataset: string,
  from: string | null,
  to: string | null,
  deps: DailyBatchDeps & { store: BarByDateStore },
  progress: ProgressSink,
): Promise<SyncResult> {
  return runDailyBatch(
    SYNC_TARGET.BAR_BY_DATE,
    dataset,
    from,
    to,
    deps,
    (date) => BaostockQueries.aStockDaily('anonymous', date),
    REQUIRED_FIELDS,
    async (date, records) => {
      const bars: BarRow[] = [];
      for (const record of records) {
        const code = record.get(FIELD.BAR.CODE) ?? '';
        const recordDate = record.get(FIELD.BAR.DATE) ?? date;
        if (!code.trim() || recordDate !== date) {
          continue;
        }
        const status = parseInt(record.get(FIELD.BAR.TRADE_STATUS) ?? '0', 10);
        bars.push({
          code,
          date: recordDate,
          open: decimalOrNull(record, FIELD.BAR.OPEN),
          high: decimalOrNull(record, FIELD.BAR.HIGH),
          low: decimalOrNull(record, FIELD.BAR.LOW),
          close: decimalOrNull(record, FIELD.BAR.CLOSE),
          preClose: decimalOrNull(record, FIELD.BAR.PRE_CLOSE),
          volume: (record.get(FIELD.BAR.VOLUME) ?? '0') || '0',
          amount: decimalOrNull(record, FIELD.BAR.AMOUNT),
          turnoverRate: decimalOrNull(record, FIELD.BAR.TURNOVER_RATE),
          changePercent: decimalOrNull(record, FIELD.BAR.CHANGE_PERCENT),
          tradeStatus: status === 1 ? 'Normal' : 'Suspended',
          isSt: (record.get(FIELD.BAR.IS_ST) ?? '0') === '1',
          peTtm: decimalOrNull(record, FIELD.BAR.PE_TTM),
          pbMrq: decimalOrNull(record, FIELD.BAR.PB_MRQ),
          psTtm: decimalOrNull(record, FIELD.BAR.PS_TTM),
          pcfNcfTtm: decimalOrNull(record, FIELD.BAR.PCF_NCF_TTM),
        });
      }
      if (bars.length === 0) {
        return 0;
      }
      return deps.store.upsertBars(bars);
    },
    { progressStage: '同步全市场日线', warnOnCountDrop: true },
    progress,
  );
}

/** 空串或无法解析 → null（「无值」与 0 是两件事） */
function decimalOrNull(record: BaostockRecord, field: string): string | null {
  const raw = record.get(field) ?? '';
  if (!raw.trim()) {
    return null;
  }
  return raw;
}
