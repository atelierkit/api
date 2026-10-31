// 外部依赖
import { getMetadataArgsStorage } from 'typeorm';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UpdateEntity } from '../../shared/common/common.entity.js';
import { KongEntity, KongLogEntity } from './kong.entity.js';

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

describe('KongEntity', () => {
  it('主表与日志表分别落到 kongs / kongs_logs', () => {
    expect(tableOf(KongEntity)).toBe('kongs');
    expect(tableOf(KongLogEntity)).toBe('kongs_logs');
  });

  it('日志表按实例ID建索引（变更历史按 id 查）', () => {
    /** 日志表上的索引 */
    const indexes = getMetadataArgsStorage().indices.filter(
      (index) => index.target === KongLogEntity,
    );
    expect(indexes.map((index) => index.columns)).toContainEqual(['id']);
  });

  it('update_at / update_operate_id / update_req_id 加载时转成数字（前端时间列与增量同步依赖）', () => {
    /** 站点 */
    const kong = new KongEntity();
    kong.update = new UpdateEntity();
    kong.update.at = '1700000000001' as unknown as number;
    kong.update.operateId = '12' as unknown as number;
    kong.update.reqId = '34' as unknown as number;
    kong.update.updateLoad();
    expect(kong.update.at).toBe(1700000000001);
    expect(kong.update.operateId).toBe(12);
    expect(kong.update.reqId).toBe(34);
  });
});
