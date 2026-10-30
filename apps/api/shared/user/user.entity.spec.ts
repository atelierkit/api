// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UserEntity } from './user.entity.js';

describe('UserEntity', () => {
  it('四个 bigint 时间戳在加载时统一转成数字（前端时间列依赖）', () => {
    /** 用户 */
    const user = new UserEntity();
    user.firstLoginAt = '1700000000001' as unknown as number;
    user.lastLoginAt = '1700000000002' as unknown as number;
    user.lastSessionAt = '1700000000003' as unknown as number;
    user.passwordAt = '1700000000004' as unknown as number;
    user.userLoad();
    expect(user.firstLoginAt).toBe(1700000000001);
    expect(user.lastLoginAt).toBe(1700000000002);
    expect(user.lastSessionAt).toBe(1700000000003);
    expect(user.passwordAt).toBe(1700000000004);
  });

  it('0 值（从未登录 / 从未设置密码）保持 0', () => {
    /** 用户 */
    const user = new UserEntity();
    user.userLoad();
    expect([user.firstLoginAt, user.lastLoginAt, user.lastSessionAt]).toEqual([
      0, 0, 0,
    ]);
    expect(user.passwordAt).toBe(0);
  });
});
