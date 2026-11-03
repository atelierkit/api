// 外部依赖
import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';

/** PEM 里的单张证书块 */
const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/**
 * 取 PEM 里的证书块
 *
 * @param pem PEM 文本
 * @returns 证书块清单
 */
function blocksOf(pem: string): string[] {
  return (pem ?? '').match(CERT_BLOCK) ?? [];
}

/**
 * 校验证书的形态（不需要私钥）
 *
 * 注 1：**客户端证书里只允许一张证书** —— 常见误操作是把 `ca.pem` 拼在 `cert.pem` 前面
 * 一起粘进来，Node 只会用第一张，于是握手时报「证书与私钥不匹配」，而这个错在界面上
 * 完全看不出来（本模块上线首日就踩到了）
 * 注 2：CA 可以为空（用系统根证书），非空时必须是合法 PEM
 *
 * @param ca CA 证书 PEM
 * @param cert 客户端证书 PEM
 * @returns 错误文案，通过时返回 null
 */
export function certificateFormatErrorOf(
  ca: string,
  cert: string,
): string | null {
  /** 客户端证书块 */
  const certs = blocksOf(cert);
  if (certs.length === 0) {
    return '客户端证书不是合法的 PEM 格式（应以 -----BEGIN CERTIFICATE----- 开头）！';
  }
  if (certs.length > 1) {
    return `客户端证书里包含了 ${certs.length} 张证书，这里只能放客户端证书本身，不要拼接 CA 或服务端证书！`;
  }
  if ((ca ?? '').trim() !== '' && blocksOf(ca).length === 0) {
    return 'CA 证书不是合法的 PEM 格式（应以 -----BEGIN CERTIFICATE----- 开头）！';
  }
  try {
    // 注：只验证能否解析 —— 解析失败的证书交给用户重贴，不要让它走到握手阶段才报 OpenSSL 错误
    new X509Certificate(certs[0]);
  } catch {
    return '客户端证书无法解析，请确认粘贴的是证书本身的 PEM！';
  }
  return null;
}

/**
 * 校验证书与私钥是否配对
 *
 * 注：私钥必须是**明文** PEM（带口令的私钥请先解密），这里比较两者的公钥指纹
 *
 * @param cert 客户端证书 PEM
 * @param key 客户端私钥 PEM（明文）
 * @returns 错误文案，通过时返回 null
 */
export function keyPairErrorOf(cert: string, key: string): string | null {
  /** 客户端证书块 */
  const certs = blocksOf(cert);
  if (certs.length === 0) {
    return '客户端证书不是合法的 PEM 格式！';
  }
  if ((key ?? '').trim() === '') {
    return '启用 TLS 时必须提供客户端私钥！';
  }
  /** 证书里的公钥指纹 */
  let certPublic: string;
  try {
    certPublic = publicOf(certs[0]);
  } catch {
    return '客户端证书无法解析，请确认粘贴的是证书本身的 PEM！';
  }
  /** 私钥里的公钥指纹 */
  let keyPublic: string;
  try {
    keyPublic = publicOf(key);
  } catch {
    return '客户端私钥无法解析（如果是带口令的私钥，请先解密成明文 PEM）！';
  }
  if (certPublic !== keyPublic) {
    return '客户端证书与私钥不匹配，请确认两者来自同一对密钥（常见原因：粘贴了另一套证书，或证书框里混进了 CA）！';
  }
  return null;
}

/**
 * 完整校验（形态 + 配对）
 *
 * @param ca CA 证书 PEM
 * @param cert 客户端证书 PEM
 * @param key 客户端私钥 PEM（明文）
 * @returns 错误文案，通过时返回 null
 */
export function certificateErrorOf(
  ca: string,
  cert: string,
  key: string,
): string | null {
  return (
    certificateFormatErrorOf(ca, cert) ?? keyPairErrorOf(cert, key)
  );
}

/**
 * 取公钥指纹
 *
 * 注：证书与私钥都归一到 SPKI DER 再比 base64 —— 两者的原始编码不同，不能直接比文本
 *
 * @param pem 证书或私钥 PEM
 * @returns 公钥指纹
 */
function publicOf(pem: string): string {
  /** 解析结果，注：证书与私钥走不同入口 */
  const parsed = pem.includes('BEGIN CERTIFICATE')
    ? new X509Certificate(pem).publicKey
    : createPublicKey(createPrivateKey(pem));
  return parsed.export({ type: 'spki', format: 'der' }).toString('base64');
}
