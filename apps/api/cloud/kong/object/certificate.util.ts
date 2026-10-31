// 外部依赖
import { X509Certificate } from 'node:crypto';

/** 证书解析结果 */
export interface CertificateInfo {
  /** 证书覆盖的域名（Subject Alternative Name 里的 DNS 项） */
  snis: string[];
  /** 生效时间（秒级时间戳，与 Kong 其它时间字段口径一致） */
  start: number;
  /** 失效时间（秒级时间戳） */
  end: number;
}

/**
 * 解析 PEM 证书，取出域名与有效期
 *
 * 注 1：Kong 的证书对象本身不带 `snis` / `start` / `end`（域名在 `/certificates/{id}/snis` 上，
 * 有效期只能从 PEM 读），旧私有项目是在浏览器里用 `node-forge` 解析的；本仓库改用 Node 自带的
 * `X509Certificate`，后端解析后随列表下发，前端不再引 node-forge（省掉数百 KB 打包体积）
 * 注 2：解析失败返回 `null` 而不是抛错 —— 列表里只要有一张脏证书，也不该让整页打不开
 *
 * @param pem PEM 格式的证书文本
 * @returns 解析结果，无法解析时为 `null`
 */
export function parseCertificate(pem: string): CertificateInfo | null {
  if (pem.trim() === '') {
    return null;
  }
  /** 证书对象 */
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    // 不是合法 PEM / DER，或缺少 CERTIFICATE 段落
    return null;
  }
  /** 生效时间 */
  const start = Math.floor(cert.validFromDate.getTime() / 1000);
  /** 失效时间 */
  const end = Math.floor(cert.validToDate.getTime() / 1000);
  // 注：极少数证书两个时间都读不出来（getTime() 为 NaN），这种也按解析失败处理
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  return { snis: snisOf(cert), start, end };
}

/**
 * 取出证书里的 DNS 域名
 *
 * 注：`subjectAltName` 是 `"DNS:a.com, DNS:b.com, IP Address:1.2.3.4"` 这样的字符串，
 * 这里只保留 `DNS:` 项（Kong 的 snis 只接受域名，IP 走 `ips` 字段，不在本次迁移范围）
 *
 * @param cert 证书对象
 * @returns 域名清单，没有 SAN 时为空数组
 */
function snisOf(cert: X509Certificate): string[] {
  /** 扩展项文本 */
  const san = cert.subjectAltName ?? '';
  return san
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('DNS:'))
    .map((item) => item.slice(4));
}
