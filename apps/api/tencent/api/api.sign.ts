// 外部依赖
import { createHash, createHmac } from 'node:crypto';

/** 签名算法，注：腾讯云 API 3.0 只有这一种 */
export const ALGORITHM = 'TC3-HMAC-SHA256';

/** 内容类型，注：签名值与实际发送必须逐字一致（少写 `charset=utf-8` 就会签名不一致） */
export const CONTENT_TYPE = 'application/json; charset=utf-8';

/** 缺省参与签名的头部，注：与旧私有项目一致，只签 `content-type;host` */
export const DEFAULT_SIGNED_HEADERS = ['content-type', 'host'];

/** 签名信息 */
export interface SignInput {
  /** 访问密钥 ID */
  secretId: string;
  /** 访问密钥 Secret，注：只在服务端内存里出现 */
  secretKey: string;
  /** 服务名，如 `cdn` / `ssl` / `dnspod` */
  service: string;
  /** 请求域名，如 `cdn.tencentcloudapi.com` */
  host: string;
  /** 接口名，如 `DescribeCertificates` */
  action: string;
  /** 接口版本，如 `2019-12-05` */
  version: string;
  /** 请求正文（已序列化的 JSON 字符串） */
  payload: string;
  /** 秒级时间戳 */
  timestamp: number;
  /** 地域，注：部分接口不需要（如 CDN、SSL、DNSPod） */
  region?: string;
  /** 参与签名的头部名称，缺省 `content-type;host` */
  signedHeaders?: string[];
}

/**
 * 计算 SHA-256 十六进制摘要
 *
 * @param text 待摘要的文本
 * @returns 小写十六进制摘要
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 取参与签名头部的取值
 *
 * 注：只支持本模块真正会签的三个头部 —— 多签一个不发送的头、或少签一个发送了的头都会被服务端拒绝
 *
 * @param name 头部名称（小写）
 * @param input 签名信息
 * @returns 头部取值
 */
function headerValueOf(name: string, input: SignInput): string {
  switch (name) {
    case 'content-type':
      return CONTENT_TYPE;
    case 'host':
      return input.host;
    case 'x-tc-action':
      // 注：`X-TC-Action` 按规范转小写后入签名
      return input.action.toLowerCase();
    default:
      throw new Error(`不支持的签名头部：${name}`);
  }
}

/**
 * 取签名日期（UTC）
 *
 * 注：必须用 UTC 日期，不能取本地时区 —— 北京时间 00:00-08:00 之间两者相差一天，
 * 会导致签名直接失效（腾讯云官方文档专门强调过这一点）
 *
 * @param timestamp 秒级时间戳
 * @returns `yyyy-MM-dd`
 */
export function dateOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

/**
 * 构造规范请求串（CanonicalRequest）
 *
 * @param input 签名信息
 * @returns 规范请求串
 */
export function canonicalRequestOf(input: SignInput): string {
  /** 参与签名的头部 */
  const names = input.signedHeaders ?? DEFAULT_SIGNED_HEADERS;
  /** 规范头部块，注：每行以换行结尾，块本身再作为一个段参与拼接（故段间会出现一个空行） */
  const canonicalHeaders = `${names.map((name) => `${name}:${headerValueOf(name, input)}`).join('\n')}\n`;
  return [
    'POST',
    '/',
    '',
    canonicalHeaders,
    names.join(';'),
    sha256Hex(input.payload),
  ].join('\n');
}

/**
 * 构造待签名字符串（StringToSign）
 *
 * @param input 签名信息
 * @param canonicalRequestHash 规范请求串的摘要
 * @returns 待签名字符串
 */
export function stringToSignOf(
  input: SignInput,
  canonicalRequestHash: string,
): string {
  return [
    ALGORITHM,
    String(input.timestamp),
    `${dateOf(input.timestamp)}/${input.service}/tc3_request`,
    canonicalRequestHash,
  ].join('\n');
}

/**
 * 计算签名
 *
 * 注：派生密钥链路为 `HMAC("TC3"+SecretKey, Date)` → `HMAC(·, Service)` → `HMAC(·, "tc3_request")`，
 * 再用派生出的密钥对 StringToSign 做 HMAC
 *
 * @param input 签名信息
 * @returns 签名（十六进制）
 */
export function signatureOf(input: SignInput): string {
  /** 规范请求串摘要 */
  const canonicalRequestHash = sha256Hex(canonicalRequestOf(input));
  /** 待签名字符串 */
  const stringToSign = stringToSignOf(input, canonicalRequestHash);
  /** 按日期派生的密钥 */
  const secretDate = createHmac('sha256', `TC3${input.secretKey}`)
    .update(dateOf(input.timestamp))
    .digest();
  /** 按服务派生的密钥 */
  const secretService = createHmac('sha256', secretDate)
    .update(input.service)
    .digest();
  /** 最终用于签名的密钥 */
  const secretSigning = createHmac('sha256', secretService)
    .update('tc3_request')
    .digest();
  return createHmac('sha256', secretSigning)
    .update(stringToSign)
    .digest('hex');
}

/**
 * 构造 Authorization 头部
 *
 * @param input 签名信息
 * @returns Authorization 取值
 */
export function authorizationOf(input: SignInput): string {
  /** 参与签名的头部 */
  const names = input.signedHeaders ?? DEFAULT_SIGNED_HEADERS;
  return (
    `${ALGORITHM} ` +
    `Credential=${input.secretId}/${dateOf(input.timestamp)}/${input.service}/tc3_request, ` +
    `SignedHeaders=${names.join(';')}, ` +
    `Signature=${signatureOf(input)}`
  );
}

/**
 * 构造请求头部
 *
 * @param input 签名信息
 * @returns 可直接交给 `fetch` 的头部
 */
export function headersOf(input: SignInput): Record<string, string> {
  /** 请求头 */
  const headers: Record<string, string> = {
    Authorization: authorizationOf(input),
    'Content-Type': CONTENT_TYPE,
    Host: input.host,
    'X-TC-Action': input.action,
    'X-TC-Timestamp': String(input.timestamp),
    'X-TC-Version': input.version,
  };
  // 注：部分接口没有地域（CDN / SSL / DNSPod），此时不能带 X-TC-Region
  if (input.region) {
    headers['X-TC-Region'] = input.region;
  }
  return headers;
}
