// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { PASSWORD_MAX } from './user.constant.js';
import { UserManageCreateDto, UserManageUpdateDto } from './user.dto.js';

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

describe('user.dto 管理端', () => {
  describe('UserManageCreateDto', () => {
    it('用户名与密码必填（没密码的账号登录不上）', async () => {
      expect(await fieldsOf(UserManageCreateDto, {})).toEqual(
        expect.arrayContaining(['username', 'password']),
      );
    });

    it('只给用户名与密码即可建号（其余字段都有默认值）', async () => {
      expect(
        await fieldsOf(UserManageCreateDto, {
          username: 'dev_01',
          password: 'abc12345',
        }),
      ).toEqual([]);
    });

    it('邮箱为空串视为未填写，不报格式错误', async () => {
      expect(
        await fieldsOf(UserManageCreateDto, {
          username: 'dev_01',
          password: 'abc12345',
          email: '',
        }),
      ).toEqual([]);
    });

    it('邮箱格式错误时拒绝', async () => {
      expect(
        await fieldsOf(UserManageCreateDto, {
          username: 'dev_01',
          password: 'abc12345',
          email: 'not-a-mail',
        }),
      ).toEqual(['email']);
    });

    it('密码超过长度上限时拒绝', async () => {
      expect(
        await fieldsOf(UserManageCreateDto, {
          username: 'dev_01',
          password: 'a'.repeat(PASSWORD_MAX + 1),
        }),
      ).toEqual(['password']);
    });

    it('状态与角色必须是布尔与字符串数组', async () => {
      expect(
        await fieldsOf(UserManageCreateDto, {
          username: 'dev_01',
          password: 'abc12345',
          status: 'yes',
          roles: [1],
        }),
      ).toEqual(expect.arrayContaining(['status', 'roles']));
    });
  });

  describe('UserManageUpdateDto', () => {
    it('所有字段都可选（用于局部修改）', async () => {
      expect(await fieldsOf(UserManageUpdateDto, {})).toEqual([]);
    });

    it('禁用只提交 status 即可', async () => {
      expect(await fieldsOf(UserManageUpdateDto, { status: false })).toEqual(
        [],
      );
    });

    it('状态类型不对时拒绝', async () => {
      expect(await fieldsOf(UserManageUpdateDto, { status: 0 })).toEqual([
        'status',
      ]);
    });

    it('清空邮箱（空串）不报格式错误', async () => {
      expect(await fieldsOf(UserManageUpdateDto, { email: '' })).toEqual([]);
    });

    it('不含改密字段（改密走用户自己或邮箱重置）', async () => {
      /** 白名单生效后的实例 */
      const dto = plainToInstance(UserManageUpdateDto, {
        name: '开发',
        password: 'abc12345',
      });
      await validate(dto, { whitelist: true });
      expect('password' in dto).toBe(false);
    });
  });
});
