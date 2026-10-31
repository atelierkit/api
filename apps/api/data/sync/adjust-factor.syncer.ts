// 内部依赖
import { BaostockQueries } from '../source/baostock.query.js';
import { FIELD } from '../source/baostock.schema.js';
import type { ProgressSink } from './progress.js';
import { runDailyBatch, type DailyBatchDeps, type SyncResult } from './daily-batch.js';
import { SYNC_TARGET } from './sync.types.js';

/** 复权因子同步器所需的额外仓储 */
export interface AdjustFactorStore {
  upsertFactors(rows: AdjustFactorRow[]): Promise<number>;
}

/** adjust_factors 的一行 */
export interface AdjustFactorRow {
  code: string;
  operateDate: string;
  backFactor: string;
}

const REQUIRED_FIELDS: readonly string[] = [
  FIELD.ADJUST_FACTOR.CODE,
  FIELD.ADJUST_FACTOR.OPERATE_DATE,
  FIELD.ADJUST_FACTOR.FORE_FACTOR,
  FIELD.ADJUST_FACTOR.BACK_FACTOR,
  FIELD.ADJUST_FACTOR.SINGLE_FACTOR,
];

/**
 * 复权因子同步器（按交易日，当日除权除息证券的累计因子）
 *
 * ⚠ 交易日返回 0 条是正常（当天没有除权除息事件）⇒ 照常推进台账。
 * 只有 back_factor 落库（另两列读进来就丢）。
 */
export async function syncAdjustFactor(
  dataset: string,
  from: string | null,
  to: string | null,
  deps: DailyBatchDeps & { store: AdjustFactorStore },
  progress: ProgressSink,
): Promise<SyncResult> {
  return runDailyBatch(
    SYNC_TARGET.ADJUST_FACTOR,
    dataset,
    from,
    to,
    deps,
    (date) => BaostockQueries.adjustFactor('anonymous', date),
    REQUIRED_FIELDS,
    async (date, records) => {
      const points: AdjustFactorRow[] = [];
      for (const record of records) {
        const code = record.get(FIELD.ADJUST_FACTOR.CODE) ?? '';
        const operateDate =
          record.get(FIELD.ADJUST_FACTOR.OPERATE_DATE) ?? date;
        const backFactor = record.get(FIELD.ADJUST_FACTOR.BACK_FACTOR) ?? '';

        if (!code.trim() || operateDate !== date || !backFactor.trim()) {
          continue;
        }
        points.push({ code, operateDate: date, backFactor });
      }
      if (points.length === 0) {
        return 0;
      }
      return deps.store.upsertFactors(points);
    },
    { progressStage: '同步复权因子', emptyResponseIsNormal: true },
    progress,
  );
}
