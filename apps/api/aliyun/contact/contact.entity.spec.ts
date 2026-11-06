// 外部依赖
import { getMetadataArgsStorage } from 'typeorm';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UpdateEntity } from '../../shared/common/common.entity.js';
import {
  AliyunContactEntity,
  AliyunContactLogEntity,
  ContactBaseEntity,
} from './contact.entity.js';

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
 * 取实体某一列在库里的列名
 *
 * @param target 实体类
 * @param property 属性名
 * @returns 列名，未登记时为 undefined
 */
function columnOf(target: unknown, property: string): string | undefined {
  return getMetadataArgsStorage().columns.find(
    (column) => column.target === target && column.propertyName === property,
  )?.options.name;
}

describe('AliyunContactEntity', () => {
  it('主表与日志表分别落到 aliyun_contacts / aliyun_contacts_logs', () => {
    expect(tableOf(AliyunContactEntity)).toBe('aliyun_contacts');
    expect(tableOf(AliyunContactLogEntity)).toBe('aliyun_contacts_logs');
  });

  it('日志表按联系人ID建索引（变更历史按 id 查）', () => {
    /** 日志表上的索引 */
    const indexes = getMetadataArgsStorage().indices.filter(
      (index) => index.target === AliyunContactLogEntity,
    );
    expect(indexes.map((index) => index.columns)).toContainEqual(['id']);
  });

  it('列名与约定一致（默认项是 is_default，不是驼峰列）', () => {
    // 注：`@Column` 写在抽象基类上，故元数据的 target 是 `ContactBaseEntity` 而不是子类
    expect(columnOf(ContactBaseEntity, 'isDefault')).toBe('is_default');
    expect(columnOf(ContactBaseEntity, 'username')).toBe('username');
    expect(columnOf(ContactBaseEntity, 'phone')).toBe('phone');
    expect(columnOf(ContactBaseEntity, 'province')).toBe('province');
    expect(columnOf(ContactBaseEntity, 'city')).toBe('city');
  });

  it('默认项与启用状态是布尔列（前端直接拿 true / false 渲染标签）', () => {
    /** 列定义 */
    const columns = getMetadataArgsStorage().columns.filter(
      (column) => column.target === ContactBaseEntity,
    );
    /** 取某列的选项 */
    const optionsOf = (property: string) =>
      columns.find((column) => column.propertyName === property)?.options;
    expect(optionsOf('isDefault')?.type).toBe('bool');
    expect(optionsOf('status')?.type).toBe('bool');
    expect(optionsOf('isDefault')?.default).toBe(false);
    expect(optionsOf('status')?.default).toBe(true);
  });

  it('update 嵌入列加载时把大整型转成数字', () => {
    /** 联系人 */
    const contact = new AliyunContactEntity();
    contact.update = new UpdateEntity();
    contact.update.at = '1700000000001' as unknown as number;
    contact.update.operateId = '12' as unknown as number;
    contact.update.reqId = '34' as unknown as number;
    contact.update.updateLoad();
    expect(contact.update.at).toBe(1700000000001);
    expect(contact.update.operateId).toBe(12);
    expect(contact.update.reqId).toBe(34);
  });
});
