// 外部依赖
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * 密文前缀
 *
 * 注：`v1` 是算法与格式版本（AES-256-GCM + 12 字节 IV + 16 字节认证标签 + base64 密文），
 * 换算法时递增版本号，旧密文仍可按前缀分派解密，不必一次性重写库里的历史数据
 */
export const SECRET_PREFIX = 'enc:v1:';

/** IV 字节数，注：GCM 推荐 12 字节，密文段之间用 `:` 分隔（base64 不含该字符） */
const IV_LENGTH = 12;

/**
 * 由任意长度的密钥口令派生 32 字节密钥
 *
 * @param key 密钥口令（取 `SETTING_KEY` 环境变量）
 * @returns 32 字节密钥
 * @throws Error 密钥为空时抛出
 */
function digestKey(key: string): Buffer {
  if (!key) {
    throw new Error('加解密密钥不能为空！');
  }
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * 判断字符串是否为密文
 *
 * @param value 待判断的值
 * @returns 带 `enc:v1:` 前缀时为 true
 */
export function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/**
 * 加密敏感字符串
 *
 * 注 1：空字符串原样返回空串 —— 未填写与「填了空值」在业务上都表示没有值，不必加密成密文
 * 注 2：同一明文每次加密结果都不同（IV 随机），调用方不要拿密文做等值比较
 *
 * @param plain 明文
 * @param key 密钥口令
 * @returns 密文（`enc:v1:<iv>:<tag>:<body>`）；明文为空时返回空串
 */
export function encryptSecret(plain: string, key: string): string {
  if (!plain) {
    return '';
  }
  /** 随机 IV */
  const iv = randomBytes(IV_LENGTH);
  /** 加密器 */
  const cipher = createCipheriv('aes-256-gcm', digestKey(key), iv);
  /** 密文正文 */
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  /** 认证标签 */
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
}

/**
 * 解密敏感字符串
 *
 * @param value 密文，注：空串原样返回空串
 * @param key 密钥口令
 * @returns 明文
 * @throws Error 密文格式不正确、密钥口令不匹配或密文被篡改时抛出
 */
export function decryptSecret(value: string, key: string): string {
  if (!value) {
    return '';
  }
  if (!isSecret(value)) {
    throw new Error('密文格式不正确，缺少 enc:v1: 前缀！');
  }
  /** 密文分段（IV / 认证标签 / 正文） */
  const [ivText, tagText, bodyText] = value
    .slice(SECRET_PREFIX.length)
    .split(':');
  if (!ivText || !tagText || typeof bodyText !== 'string') {
    throw new Error('密文格式不正确，分段缺失！');
  }
  // 注：密钥为空要在 try 之外抛出，否则会被下面的「解密失败」掩盖成密钥不匹配
  /** 派生密钥 */
  const keyBuffer = digestKey(key);
  try {
    /** 解密器 */
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyBuffer,
      Buffer.from(ivText, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyText, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // 注：GCM 的认证标签校验失败与密钥不匹配都落到这里，不向上暴露底层信息
    throw new Error('密文解密失败，请检查 SETTING_KEY 是否被更换！');
  }
}
