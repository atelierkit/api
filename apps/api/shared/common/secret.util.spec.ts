// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  SECRET_PREFIX,
  decryptSecret,
  encryptSecret,
  isSecret,
} from './secret.util.js';

/** 测试用密钥口令 */
const KEY = 'unit-test-key';

describe('secret.util', () => {
  it('加密后可以原样解回，含中文与分隔符也不受影响', () => {
    /** 明文 */
    const plain = '授权码:abc$123 中文';
    /** 密文 */
    const secret = encryptSecret(plain, KEY);
    expect(secret.startsWith(SECRET_PREFIX)).toBe(true);
    expect(decryptSecret(secret, KEY)).toBe(plain);
  });

  it('同一明文两次加密结果不同（IV 随机），避免密文被拿来做等值比较', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('空值不加密，直接返回空串', () => {
    expect(encryptSecret('', KEY)).toBe('');
    expect(decryptSecret('', KEY)).toBe('');
  });

  it('isSecret 只认带版本前缀的值', () => {
    expect(isSecret(encryptSecret('x', KEY))).toBe(true);
    expect(isSecret('plain-text')).toBe(false);
    expect(isSecret(undefined)).toBe(false);
    expect(isSecret(123)).toBe(false);
  });

  it('换密钥后解密失败，不返回乱码', () => {
    /** 密文 */
    const secret = encryptSecret('payload', KEY);
    expect(() => decryptSecret(secret, 'another-key')).toThrow(
      '密文解密失败',
    );
  });

  it('密文被篡改时认证标签校验失败', () => {
    /** 密文分段，注：前缀 `enc:v1:` 自身占两段，故从这里切掉再拆 */
    const [, , iv, tag, body] = encryptSecret('payload', KEY).split(':');
    /** 改掉认证标签首字符，注：改末位可能落在 base64 填充位上而不生效 */
    const brokenTag = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    expect(() =>
      decryptSecret(`${SECRET_PREFIX}${iv}:${brokenTag}:${body}`, KEY),
    ).toThrow('密文解密失败');
  });

  it('缺少前缀或分段缺失时按格式错误报出', () => {
    expect(() => decryptSecret('abc', KEY)).toThrow('缺少 enc:v1: 前缀');
    expect(() => decryptSecret(`${SECRET_PREFIX}only-iv`, KEY)).toThrow(
      '分段缺失',
    );
  });

  it('密钥为空时拒绝加解密', () => {
    expect(() => encryptSecret('payload', '')).toThrow('密钥不能为空');
    expect(() => decryptSecret(encryptSecret('payload', KEY), '')).toThrow(
      '密钥不能为空',
    );
  });
});
