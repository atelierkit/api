// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { SetupDto } from './setup.dto.js';

describe('SetupDto', () => {
  it('继承 RegisterDto 的必填校验（防止子类丢校验导致字段被白名单剥光）', async () => {
    /** 空入参 */
    const dto = plainToInstance(SetupDto, {});
    /** 校验结果 */
    const errors = await validate(dto, { whitelist: true });
    /** 出错的字段 */
    const fields = errors.map((error) => error.property);
    expect(fields).toContain('username');
    expect(fields).toContain('password');
  });

  it('合法入参通过校验，可选字段缺省不影响', async () => {
    /** 合法入参 */
    const dto = plainToInstance(SetupDto, {
      username: 'admin',
      password: 'abc12345',
    });
    expect(await validate(dto, { whitelist: true })).toHaveLength(0);
  });

  it('邮箱格式错误被拦截（选填但填了就要合法）', async () => {
    /** 非法邮箱入参 */
    const dto = plainToInstance(SetupDto, {
      username: 'admin',
      password: 'abc12345',
      email: 'not-an-email',
    });
    /** 校验结果 */
    const errors = await validate(dto, { whitelist: true });
    expect(errors.map((error) => error.property)).toContain('email');
  });
});
