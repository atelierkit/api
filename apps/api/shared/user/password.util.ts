// 外部依赖
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import type { ScryptOptions } from 'crypto';
// 内部依赖
import {
  SCRYPT_KEYLEN,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SCRYPT_SALT_BYTES,
} from './user.constant.js';

/**
 * 异步派生密钥
 *
 * 注：使用回调形式的 scrypt 包一层 Promise，避免 promisify 在重载签名下丢失类型
 *
 * @param plain 明文密码
 * @param salt 盐
 * @param keylen 派生密钥长度（字节）
 * @param options scrypt 参数
 * @returns 派生密钥
 */
function derive(
  plain: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, keylen, options, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

/**
 * 生成密码哈希
 *
 * 注：输出为自描述格式 `scrypt$N$r$p$salt$hash`，便于将来调整参数后就地升级
 *
 * @param plain 明文密码
 * @returns 密码哈希串
 */
export async function hashPassword(plain: string): Promise<string> {
  /** 随机盐 */
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  /** 派生密钥 */
  const key = await derive(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * 校验密码
 *
 * 注：任何格式异常一律返回 false（不抛异常），避免脏数据把登录流程打成 500
 *
 * @param plain 明文密码
 * @param stored 库中的密码哈希串
 * @returns 校验结果
 */
export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  if (!plain || !stored) {
    return false;
  }
  /** 哈希串分段 */
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 参数合法性校验，注：防止被写入超大参数的脏数据拖死进程
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 1024 ||
    N > 1048576 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    return false;
  }
  /** 盐 */
  const salt = Buffer.from(parts[4], 'base64');
  /** 期望的派生密钥 */
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) {
    return false;
  }
  /** 实际派生密钥 */
  const actual = await derive(plain, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 占位哈希串
 *
 * 注：用户不存在时也跑一次同等开销的校验，让「账号不存在」与「密码错误」在耗时上不可区分。
 * 该串的期望值本身无意义（固定全零），校验结果必然为 false，只要保证派生过程真实发生即可。
 */
export const DUMMY_HASH = [
  'scrypt',
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  Buffer.alloc(SCRYPT_SALT_BYTES).toString('base64'),
  Buffer.alloc(SCRYPT_KEYLEN).toString('base64'),
].join('$');
