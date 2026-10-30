// 外部依赖
import { randomBytes, randomInt } from 'crypto';

/**
 * 生成指定长度的随机字符串
 *
 * 注：基于 CSPRNG（crypto）生成，验证码与序列码不可预测
 *
 * @param length 随机字符串长度
 * @param type 随机字符串类型，默认字符串型
 * @returns 指定长度的随机字符串
 */
export function random(
  length: number,
  type: 'string' | 'number' = 'string',
): string {
  /** 可选字符集 */
  const chars =
    type === 'string'
      ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890'
      : '1234567890';
  /** 字符集长度 */
  const maxPos = chars.length;
  if (type === 'number') {
    // 验证码场景：randomInt 生成均匀分布的随机下标
    /** 随机字符串 */
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[randomInt(0, maxPos)];
    }
    return result;
  }
  // 序列码场景：randomBytes + 拒绝采样，消除取模偏差
  /** 无偏差字节上限，注：256 内不能被 maxPos 整除的尾部字节直接丢弃 */
  const limit = Math.floor(256 / maxPos) * maxPos;
  /** 随机字符串 */
  let result = '';
  while (result.length < length) {
    /** 随机字节缓冲区 */
    const bytes = randomBytes((length - result.length) * 2);
    for (const byte of bytes) {
      if (byte < limit) {
        result += chars[byte % maxPos];
        if (result.length === length) {
          break;
        }
      }
    }
  }
  return result;
}
