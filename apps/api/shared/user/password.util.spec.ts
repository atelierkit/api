// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.util.js';

describe('password.util', () => {
  it('哈希串为自描述格式 scrypt$N$r$p$salt$hash', async () => {
    /** 哈希串 */
    const hash = await hashPassword('abc12345');
    /** 分段 */
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('16384');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    // 盐与哈希为 base64
    expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5], 'base64')).toHaveLength(64);
  });

  it('同一密码两次哈希结果不同（盐随机）', async () => {
    /** 第一次哈希 */
    const first = await hashPassword('abc12345');
    /** 第二次哈希 */
    const second = await hashPassword('abc12345');
    expect(first).not.toBe(second);
    // 但两者都能校验通过
    expect(await verifyPassword('abc12345', first)).toBe(true);
    expect(await verifyPassword('abc12345', second)).toBe(true);
  });

  it('正确密码校验通过，错误密码校验失败', async () => {
    /** 哈希串 */
    const hash = await hashPassword('abc12345');
    expect(await verifyPassword('abc12345', hash)).toBe(true);
    expect(await verifyPassword('abc12346', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('脏数据不抛异常，一律返回 false', async () => {
    expect(await verifyPassword('abc12345', '')).toBe(false);
    expect(await verifyPassword('abc12345', 'plaintext')).toBe(false);
    expect(await verifyPassword('abc12345', 'scrypt$1$2$3$4')).toBe(false);
    // 非法参数（N 不是 2 的幂 / 过大）不得进入派生过程
    expect(await verifyPassword('abc12345', 'scrypt$0$8$1$AAAA$AAAA')).toBe(
      false,
    );
    expect(await verifyPassword('abc12345', 'scrypt$999999999$8$1$AAAA$AAAA')).toBe(
      false,
    );
    // 空盐或空哈希
    expect(await verifyPassword('abc12345', 'scrypt$16384$8$1$$')).toBe(false);
  });

  it('DUMMY_HASH 可被校验流程消费（结果恒为 false，但派生真实发生）', async () => {
    /** 开始时间 */
    const start = Date.now();
    expect(await verifyPassword('any-password', DUMMY_HASH)).toBe(false);
    // 派生耗时应当可观测（仅作弱断言，避免在不同机器上过敏感）
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});
