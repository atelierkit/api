// 外部依赖
import { createHmac } from 'node:crypto';

/** 签名方式，注：阿里云 RPC 风格 API 只支持这一种 */
export const SIGNATURE_METHOD = 'HMAC-SHA1';

/** 签名算法版本 */
export const SIGNATURE_VERSION = '1.0';

/** 不参与编码的字符集（RFC 3986 的 unreserved），注：其余一律百分号编码 */
const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;

/**
 * 阿里云规范的百分号编码
 *
 * 注 1：`encodeURIComponent` 会放过 `!` `'` `(` `)` `*` 五个字符，而阿里云要求它们参与编码 ——
 * **通配符域名（`*.example.com`）参与签名时这是必踩项**，漏掉就返回 `SignatureDoesNotMatch`
 * 注 2：空格必须编码成 `%20`（不是 `+`），`~` 保持原样
 *
 * @param value 待编码的字符串
 * @returns 编码后的字符串
 */
export function percentEncode(value: string): string {
  /** 逐字符编码结果 */
  const encoded: string[] = [];
  for (const char of value) {
    if (UNRESERVED.test(char)) {
      encoded.push(char);
      continue;
    }
    // 注：先按 UTF-8 取字节再逐字节编码，保证中文与 emoji 也符合规范
    for (const byte of Buffer.from(char, 'utf8')) {
      encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
  return encoded.join('');
}

/**
 * 把参数序列化为阿里云规范的规范查询串
 *
 * 规则：剔除 `undefined` / `null` → 键名升序 → 键值分别编码后以 `&` 连接
 *
 * @param params 待序列化的参数
 * @returns 规范查询串
 */
export function canonicalize(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(String(params[key]))}`)
    .join('&');
}

/**
 * 构造待签名字符串（StringToSign）
 *
 * 格式：`${method}&${编码后的路径}&${编码后的规范查询串}`
 *
 * @param method 请求方法（GET / POST）
 * @param params 参与签名的全部参数（公共参数 + 业务参数）
 * @returns 待签名字符串
 */
export function stringToSignOf(
  method: string,
  params: Record<string, unknown>,
): string {
  return `${method}&${percentEncode('/')}&${percentEncode(canonicalize(params))}`;
}

/**
 * 计算签名
 *
 * 注：密钥取 `AccessKeySecret + '&'`，再对 StringToSign 做 HMAC-SHA1，最后对 **Base64 结果**再编码一次
 * （这一步漏掉，含 `+` `/` `=` 的签名会被服务端当成另一个值）
 *
 * @param secret 访问密钥 Secret
 * @param method 请求方法
 * @param params 参与签名的全部参数
 * @returns 编码后的签名
 */
export function signatureOf(
  secret: string,
  method: string,
  params: Record<string, unknown>,
): string {
  /** 原始签名的 Base64 */
  const raw = createHmac('sha1', `${secret}&`)
    .update(stringToSignOf(method, params))
    .digest('base64');
  return percentEncode(raw);
}
