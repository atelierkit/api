// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { maskData } from './mask.util.js';

describe('mask.util', () => {
  describe('maskData', () => {
    it('空值原样返回', () => {
      expect(maskData(null)).toBeNull();
      expect(maskData(undefined)).toBeUndefined();
    });

    it('按字段名掩码，长度不同掩码形态不同', () => {
      /** 掩码结果 */
      const result = maskData({
        password: 'abcdefgh',
        pwd: 'abcdef',
        secret: 'abc',
        token: 'ab',
      }) as Record<string, string>;
      // 长度 8：保留前 2 位与后 2 位
      expect(result.password).toBe('ab****gh');
      // 长度 6：保留首尾各 1 位
      expect(result.pwd).toBe('a****f');
      // 长度 3：保留首尾各 1 位
      expect(result.secret).toBe('a*c');
      // 长度 2 及以下：全掩码
      expect(result.token).toBe('***');
    });

    it('非字符串的敏感字段统一替换为 ***，空值保持空', () => {
      /** 掩码结果 */
      const result = maskData({
        token: 12345,
        email: null,
        phone: undefined,
      }) as Record<string, unknown>;
      expect(result.token).toBe('***');
      expect(result.email).toBeNull();
      expect(result.phone).toBeUndefined();
    });

    it('递归掩码嵌套对象与数组，非敏感字段原样保留', () => {
      /** 掩码结果 */
      const result = maskData({
        username: 'admin',
        profile: { mobile: '13800138000', nickname: '管理员' },
        list: [{ password: 'abcdefgh' }, 'plain'],
      }) as Record<string, unknown>;
      expect(result.username).toBe('admin');
      /** 嵌套对象 */
      const profile = result.profile as Record<string, string>;
      expect(profile.nickname).toBe('管理员');
      // 长度 11：保留前 2 位与后 2 位
      expect(profile.mobile).toBe('13*******00');
      /** 数组元素 */
      const list = result.list as Array<Record<string, string>>;
      expect(list[0].password).toBe('ab****gh');
      expect(list[1]).toBe('plain');
    });

    it('字符串正文中的密码片段被就地掩码', () => {
      expect(maskData('password=abc123&page=1')).toContain('***');
      expect(maskData('password=abc123&page=1')).not.toContain('abc123');
      expect(maskData('secret: s3cr3t')).not.toContain('s3cr3t');
      // 未列入替换模式的键不误伤
      expect(maskData('page=1&size=20')).toBe('page=1&size=20');
    });

    it('数字与布尔等标量原样返回', () => {
      expect(maskData(200)).toBe(200);
      expect(maskData(true)).toBe(true);
    });
  });
});
