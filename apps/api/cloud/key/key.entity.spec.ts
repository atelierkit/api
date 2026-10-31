// 外部依赖
import { getMetadataArgsStorage } from 'typeorm';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UpdateEntity } from '../../shared/common/common.entity.js';
import { KeyEntity, KeyLogEntity } from './key.entity.js';

/**
 * 取实体对应的表名
 *
 * @param target 实体类
 * @returns 表名，未登记时为 undefined
 */
function tableOf(target: unknown): string | undefined {
  return getMetadataArgsStorage().tables.find(
    (table) => table.target === target,
  )?.name;
}

describe('KeyEntity', () => {
  it('主表与日志表分别落到 cloud_keys / cloud_keys_logs', () => {
    expect(tableOf(KeyEntity)).toBe('cloud_keys');
    expect(tableOf(KeyLogEntity)).toBe('cloud_keys_logs');
  });

  it('日志表按密钥ID建索引（变更历史按 id 查）', () => {
    /** 日志表上的索引 */
    const indexes = getMetadataArgsStorage().indices.filter(
      (index) => index.target === KeyLogEntity,
    );
    expect(indexes.map((index) => index.columns)).toContainEqual(['id']);
  });

  it('update_at / update_operate_id / update_req_id 加载时转成数字（前端时间列与增量同步依赖）', () => {
    /** 密钥 */
    const key = new KeyEntity();
    key.update = new UpdateEntity();
    key.update.at = '1700000000001' as unknown as number;
    key.update.operateId = '12' as unknown as number;
    key.update.reqId = '34' as unknown as number;
    key.update.updateLoad();
    expect(key.update.at).toBe(1700000000001);
    expect(key.update.operateId).toBe(12);
    expect(key.update.reqId).toBe(34);
  });
});
