// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { RoleSortDto, RoleUpdateDto } from './role.dto.js';

/**
 * 校验入参
 *
 * @param cls DTO 类型
 * @param value 原始入参
 * @returns 出错的字段名清单
 */
async function fieldsOf(
  cls: new () => object,
  value: Record<string, unknown>,
): Promise<string[]> {
  /** DTO 实例 */
  const dto = plainToInstance(cls, value);
  /** 校验结果 */
  const errors = await validate(dto, { whitelist: true });
  return errors.map((error) => error.property);
}

describe('role.dto', () => {
  describe('RoleUpdateDto', () => {
    it('四个字段都必填', async () => {
      expect(await fieldsOf(RoleUpdateDto, {})).toEqual(
        expect.arrayContaining(['id', 'name', 'description', 'status']),
      );
    });

    it('字段齐备时通过校验', async () => {
      expect(
        await fieldsOf(RoleUpdateDto, {
          id: 'admin',
          name: '管理员',
          description: '超级管理员',
          status: true,
        }),
      ).toEqual([]);
    });

    it('status 为 false 时同样通过（禁用角色不能被判成「空」）', async () => {
      expect(
        await fieldsOf(RoleUpdateDto, {
          id: 'ops',
          name: '运维',
          description: '维护服务器',
          status: false,
        }),
      ).toEqual([]);
    });

    it('status 非布尔时报错', async () => {
      expect(
        await fieldsOf(RoleUpdateDto, {
          id: 'ops',
          name: '运维',
          description: '维护服务器',
          status: 'false',
        }),
      ).toEqual(['status']);
    });
  });

  describe('RoleSortDto', () => {
    it('排序号缺省时报错', async () => {
      expect(await fieldsOf(RoleSortDto, { id: 'admin' })).toEqual(['sort']);
    });

    it('id 与排序号齐备时通过校验', async () => {
      expect(await fieldsOf(RoleSortDto, { id: 'admin', sort: 1 })).toEqual([]);
    });

    it('排序号 0 合法，小数与非数字报错', async () => {
      expect(await fieldsOf(RoleSortDto, { id: 'admin', sort: 0 })).toEqual([]);
      expect(await fieldsOf(RoleSortDto, { id: 'admin', sort: 1.5 })).toEqual(['sort']);
      expect(await fieldsOf(RoleSortDto, { id: 'admin', sort: '2' })).toEqual(['sort']);
    });
  });
});
