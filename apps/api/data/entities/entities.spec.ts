// 外部依赖
import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
// 内部依赖
import { SecurityEntity } from './security.entity.js';
import { TradeCalendarEntity } from './trade-calendar.entity.js';
import { BarEntity } from './bar.entity.js';
import { AdjustFactorEntity } from './adjust-factor.entity.js';
import { DataCoverageEntity } from './data-coverage.entity.js';
import { SyncTaskEntity } from './sync-task.entity.js';
import { SyncRunEntity } from './sync-run.entity.js';

/**
 * 实体列名 ↔ DDL 契约测试
 *
 * ⚠ 项目踩过「单测走内存替身、真连 PG 才 `42703 column does not exist`」的坑：
 * 实体与 DDL 的列名两半都要断言。这里把每个实体的数据库列名（databaseName）与
 * 权威 DDL 的列清单逐字比对，缺一列或多一列都会红。
 */

/** 取实体的数据库列名清单 */
function columnsOf(entity: unknown): string[] {
  const storage = getMetadataArgsStorage();
  const columns = storage.columns.filter((c) => c.target === entity);
  return columns.map((c) => c.options.name ?? '').sort();
}

describe('数据模型实体列名契约', () => {
  it('securities 列名与 DDL 一致', () => {
    expect(columnsOf(SecurityEntity)).toEqual(
      [
        'code',
        'name',
        'type',
        'market',
        'list_date',
        'delist_date',
        'status',
        'updated_at',
      ].sort(),
    );
  });

  it('trade_calendar 只存两列业务字段', () => {
    expect(columnsOf(TradeCalendarEntity)).toEqual(
      ['calendar_date', 'is_open', 'updated_at'].sort(),
    );
  });

  it('bars 列名与 DDL 一致（含 4 个可空估值列）', () => {
    expect(columnsOf(BarEntity)).toEqual(
      [
        'code',
        'date',
        'open',
        'high',
        'low',
        'close',
        'pre_close',
        'volume',
        'amount',
        'turnover_rate',
        'change_percent',
        'pe_ttm',
        'pb_mrq',
        'ps_ttm',
        'pcf_ncf_ttm',
        'trade_status',
        'is_st',
        'updated_at',
      ].sort(),
    );
  });

  it('adjust_factors 只有 back_factor 一列因子（物理防呆）', () => {
    expect(columnsOf(AdjustFactorEntity)).toEqual(
      ['code', 'operate_date', 'back_factor', 'updated_at'].sort(),
    );
  });

  it('data_coverage 列名与 DDL 一致', () => {
    expect(columnsOf(DataCoverageEntity)).toEqual(
      ['scope', 'dataset', 'parameters', 'last_date', 'record_count', 'updated_at'].sort(),
    );
  });

  it('sync_tasks 列名与 DDL 一致', () => {
    expect(columnsOf(SyncTaskEntity)).toEqual(
      ['id', 'target', 'code', 'enabled', 'created_at'].sort(),
    );
  });

  it('sync_runs 列名与 DDL 一致', () => {
    expect(columnsOf(SyncRunEntity)).toEqual(
      [
        'id',
        'task_id',
        'target',
        'code',
        'state',
        'source',
        'plan_date',
        'from_date',
        'to_date',
        'done',
        'total',
        'rows_written',
        'stage',
        'message',
        'attempts',
        'created_at',
        'started_at',
        'finished_at',
      ].sort(),
    );
  });
});
