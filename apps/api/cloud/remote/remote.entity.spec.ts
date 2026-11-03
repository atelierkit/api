// 外部依赖
import { getMetadataArgsStorage } from 'typeorm';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UpdateEntity } from '../../shared/common/common.entity.js';
import { RemoteEntity, RemoteLogEntity } from './remote.entity.js';

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

/**
 * 取某列的数据库列名
 *
 * 注：继承来的列，元数据登记的 `target` 是基类（`RemoteBaseEntity`），故这里只按属性名找
 *
 * @param property 属性名
 * @returns 列名，未登记时为 undefined
 */
function columnOf(property: string): string | undefined {
  return getMetadataArgsStorage().columns.find(
    (column) => column.propertyName === property,
  )?.options.name;
}

describe('RemoteEntity', () => {
  it('主表与日志表分别落到 remotes / remotes_logs', () => {
    expect(tableOf(RemoteEntity)).toBe('remotes');
    expect(tableOf(RemoteLogEntity)).toBe('remotes_logs');
  });

  it('日志表按主机ID建索引（变更历史按 id 查）', () => {
    /** 日志表上的索引 */
    const indexes = getMetadataArgsStorage().indices.filter(
      (index) => index.target === RemoteLogEntity,
    );
    expect(indexes.map((index) => index.columns)).toContainEqual(['id']);
  });

  it('凭据与指纹用带下划线的列名（与库里的 DDL 对齐）', () => {
    expect(columnOf('authType')).toBe('auth_type');
    expect(columnOf('password')).toBe('password');
    expect(columnOf('privateKey')).toBe('private_key');
    expect(columnOf('passphrase')).toBe('passphrase');
    expect(columnOf('charset')).toBe('charset');
    expect(columnOf('fingerprint')).toBe('fingerprint');
    expect(columnOf('rootPath')).toBe('root_path');
  });

  it('update_at / update_operate_id / update_req_id 加载时转成数字（前端时间列与增量同步依赖）', () => {
    /** 主机 */
    const remote = new RemoteEntity();
    remote.update = new UpdateEntity();
    remote.update.at = '1700000000001' as unknown as number;
    remote.update.operateId = '12' as unknown as number;
    remote.update.reqId = '34' as unknown as number;
    remote.update.updateLoad();
    expect(remote.update.at).toBe(1700000000001);
    expect(remote.update.operateId).toBe(12);
    expect(remote.update.reqId).toBe(34);
  });
});
