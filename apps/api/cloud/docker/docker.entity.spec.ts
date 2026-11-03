// 外部依赖
import { getMetadataArgsStorage } from 'typeorm';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UpdateEntity } from '../../shared/common/common.entity.js';
import { DockerEntity, DockerLogEntity } from './docker.entity.js';

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
 * 注：继承来的列，元数据登记的 `target` 是基类（`DockerBaseEntity`），故这里只按属性名找
 *
 * @param property 属性名
 * @returns 列名，未登记时为 undefined
 */
function columnOf(property: string): string | undefined {
  return getMetadataArgsStorage().columns.find(
    (column) => column.propertyName === property,
  )?.options.name;
}

describe('DockerEntity', () => {
  it('主表与日志表分别落到 dockers / dockers_logs', () => {
    expect(tableOf(DockerEntity)).toBe('dockers');
    expect(tableOf(DockerLogEntity)).toBe('dockers_logs');
  });

  it('日志表按实例ID建索引（变更历史按 id 查）', () => {
    /** 日志表上的索引 */
    const indexes = getMetadataArgsStorage().indices.filter(
      (index) => index.target === DockerLogEntity,
    );
    expect(indexes.map((index) => index.columns)).toContainEqual(['id']);
  });

  it('TLS 私钥与 API 版本用带下划线的列名（与库里的 DDL 对齐）', () => {
    expect(columnOf('ca')).toBe('ca');
    expect(columnOf('cert')).toBe('cert');
    expect(columnOf('key')).toBe('key');
    expect(columnOf('apiVersion')).toBe('api_version');
  });

  it('update_at / update_operate_id / update_req_id 加载时转成数字（前端时间列与增量同步依赖）', () => {
    /** 宿主机 */
    const docker = new DockerEntity();
    docker.update = new UpdateEntity();
    docker.update.at = '1700000000001' as unknown as number;
    docker.update.operateId = '12' as unknown as number;
    docker.update.reqId = '34' as unknown as number;
    docker.update.updateLoad();
    expect(docker.update.at).toBe(1700000000001);
    expect(docker.update.operateId).toBe(12);
    expect(docker.update.reqId).toBe(34);
  });
});
