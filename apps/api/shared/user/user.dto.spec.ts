// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { PASSWORD_MAX } from './user.constant.js';
import {
  CheckDto,
  LoginDto,
  PasswordDto,
  RegisterDto,
  ResetCodeDto,
  ResetDto,
  TokenValidDto,
  UnlockDto,
  UserUpdateDto,
} from './user.dto.js';

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

describe('user.dto', () => {
  describe('RegisterDto', () => {
    it('用户名与密码必填', async () => {
      expect(await fieldsOf(RegisterDto, {})).toEqual(
        expect.arrayContaining(['username', 'password']),
      );
    });

    it('可选资料缺省时通过校验', async () => {
      expect(
        await fieldsOf(RegisterDto, {
          username: 'admin',
          password: 'abc12345',
        }),
      ).toHaveLength(0);
    });

    it('密码超过上限被拦截（防止 scrypt 被超长入参拖死）', async () => {
      /** 超长密码 */
      const password = 'a1'.repeat(PASSWORD_MAX);
      expect(
        await fieldsOf(RegisterDto, { username: 'admin', password }),
      ).toContain('password');
    });

    it('邮箱格式错误被拦截，空串同样视为格式错误', async () => {
      expect(
        await fieldsOf(RegisterDto, {
          username: 'admin',
          password: 'abc12345',
          email: 'not-an-email',
        }),
      ).toContain('email');
    });

    it('注：DTO 只做粗筛，用户名与密码的完整规则由 UserService 校验', async () => {
      // 'A' 不合规（大写/过短），但 DTO 层不拦，避免两处规则各写一份后走偏
      expect(
        await fieldsOf(RegisterDto, { username: 'A', password: '1' }),
      ).toHaveLength(0);
    });
  });

  describe('LoginDto / CheckDto', () => {
    it('用户名与密码必填', async () => {
      expect(await fieldsOf(LoginDto, { username: '' })).toEqual(
        expect.arrayContaining(['username', 'password']),
      );
    });

    it('查重只要求用户名', async () => {
      expect(await fieldsOf(CheckDto, { username: 'admin' })).toHaveLength(0);
      expect(await fieldsOf(CheckDto, {})).toContain('username');
    });
  });

  describe('PasswordDto', () => {
    it('原密码与新密码必填，新密码受长度上限约束', async () => {
      expect(await fieldsOf(PasswordDto, {})).toEqual(
        expect.arrayContaining(['oldPassword', 'newPassword']),
      );
      expect(
        await fieldsOf(PasswordDto, {
          oldPassword: 'abc12345',
          newPassword: 'a1'.repeat(PASSWORD_MAX),
        }),
      ).toContain('newPassword');
    });
  });

  describe('UnlockDto', () => {
    it('只要求密码必填', async () => {
      expect(await fieldsOf(UnlockDto, {})).toContain('password');
      expect(await fieldsOf(UnlockDto, { password: 'abc12345' })).toHaveLength(
        0,
      );
    });
  });

  describe('ResetCodeDto / ResetDto', () => {
    it('重置验证码只要求合法邮箱', async () => {
      expect(await fieldsOf(ResetCodeDto, { email: 'a@b.com' })).toHaveLength(
        0,
      );
      expect(await fieldsOf(ResetCodeDto, { email: 'a@b' })).toContain('email');
    });

    it('提交重置要求邮箱、验证码与新密码', async () => {
      expect(await fieldsOf(ResetDto, {})).toEqual(
        expect.arrayContaining(['email', 'code', 'password']),
      );
      expect(
        await fieldsOf(ResetDto, {
          email: 'a@b.com',
          code: '123456',
          password: 'abc12345',
        }),
      ).toHaveLength(0);
    });
  });

  describe('UserUpdateDto', () => {
    it('昵称与头像必填（允许为空串以外的任何值）', async () => {
      expect(await fieldsOf(UserUpdateDto, {})).toEqual(
        expect.arrayContaining(['name', 'avatar']),
      );
    });
  });

  describe('TokenValidDto', () => {
    it('只接受白名单内的有效期档位', async () => {
      expect(await fieldsOf(TokenValidDto, { valid: 1440 })).toHaveLength(0);
      // 0 表示长期有效，同样在白名单内
      expect(await fieldsOf(TokenValidDto, { valid: 0 })).toHaveLength(0);
      expect(await fieldsOf(TokenValidDto, { valid: 15 })).toContain('valid');
      expect(await fieldsOf(TokenValidDto, {})).toContain('valid');
    });
  });

  it('未声明校验装饰器的字段会被白名单剥掉（与全局 ValidationPipe 行为一致）', async () => {
    /** DTO 实例 */
    const dto = plainToInstance(RegisterDto, {
      username: 'admin',
      password: 'abc12345',
      isAdmin: true,
    });
    await validate(dto, { whitelist: true });
    expect((dto as unknown as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});
