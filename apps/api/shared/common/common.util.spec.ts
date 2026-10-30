// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { random } from './common.util.js';

describe('common.util', () => {
  describe('random', () => {
    it('按指定长度生成字符串型随机串，字符集仅含字母与数字', () => {
      /** 随机串 */
      const value = random(32);
      expect(value).toHaveLength(32);
      expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
    });

    it('数字型只包含 0-9，长度与入参一致', () => {
      /** 验证码 */
      const value = random(6, 'number');
      expect(value).toHaveLength(6);
      expect(value).toMatch(/^\d{6}$/);
    });

    it('长度超出单次随机字节覆盖范围时仍能取满（拒绝采样会回收尾部字节）', () => {
      /** 长随机串 */
      const value = random(2000);
      // 单次 randomBytes 只取 length*2 字节，被拒绝采样的字节必须补齐而不是截断
      expect(value).toHaveLength(2000);
      expect(value).toMatch(/^[A-Za-z0-9]{2000}$/);
    });

    it('长度为 0 时返回空串', () => {
      expect(random(0)).toBe('');
      expect(random(0, 'number')).toBe('');
    });

    it('两次生成的结果不同（不可预测）', () => {
      expect(random(60)).not.toBe(random(60));
    });
  });
});
