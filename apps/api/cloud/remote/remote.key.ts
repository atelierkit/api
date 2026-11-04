// 外部依赖
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

/** 私钥 PEM 的起始标记，注：OpenSSH 与 PEM 两种格式都以此开头 */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** PKCS#8 私钥的起始标记，注：传统 PEM 是 `BEGIN RSA / EC / DSA PRIVATE KEY`，与它不冲突 */
const PKCS8_HEADER = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/;

/**
 * 判断是否为 PuTTY 的私钥
 *
 * 注：ssh2 只认 PPK 的 v2，现代 PuTTY 默认导出 v3，解析会得到一句难以理解的错误，
 * 故在保存时就识别出来并给出转换命令
 *
 * @param pem 私钥文本
 * @returns 是 `.ppk` 时为 true
 */
export function isPuttyKey(pem: string): boolean {
  return /PuTTY-User-Key-File/i.test(pem ?? '');
}

/**
 * 判断是否为 PKCS#8 私钥
 *
 * 注：`ssh2` 的解析器不认 PKCS#8（明文也一样报 `Unsupported key format`），
 * 而 Java / 部分云厂商导出的私钥默认就是它，故单独识别并给转换命令
 *
 * @param pem 私钥文本
 * @returns 是 PKCS#8 时为 true
 */
export function isPkcs8Key(pem: string): boolean {
  return PKCS8_HEADER.test(pem ?? '');
}

/**
 * 计算主机公钥指纹
 *
 * 注：与 `ssh-keygen -l -E sha256` 的口径一致 —— `SHA256:` + base64(sha256(公钥原始 blob))，
 * 去掉 base64 的 `=` 填充。ssh2 的 `hostVerifier` 给的就是这个原始 blob，
 * 故两边可以直接比对
 *
 * @param key 公钥原始字节
 * @returns 形如 `SHA256:abc…`
 */
export function fingerprintOf(key: Buffer): string {
  /** 摘要的 base64 */
  const digest = createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * 校验私钥形态
 *
 * 注 1：解析交给 **ssh2 自己的解析器**（`ssh2.utils.parseKey`），与连接时用的是同一套代码 ——
 * 校验口径与连接口径必须一致，否则会出现「保存通过、连接才发现解析不了」这种更难查的问题
 * 注 2：**不要改用 `node:crypto` 的 `createPrivateKey`**：它不认 OpenSSH 格式
 * （`-----BEGIN OPENSSH PRIVATE KEY-----`，即 `ssh-keygen` 默认产出、现实中绝大多数私钥），
 * 对明文私钥也会抛 `DECODER routines::unsupported`，正好被当成「私钥已加密」——
 * 2026-11-04 用户报的「私钥明明没设口令却提示已加密」就是这个错判
 * 注 3：反过来，`createPrivateKey` 认 PKCS#8 而 ssh2 不认，故 PKCS#8 单独拦在解析之前
 *
 * @param pem 私钥文本
 * @param passphrase 私钥口令，无口令时传空串
 * @returns 错误文案，校验通过时为 null
 */
export function privateKeyErrorOf(pem: string, passphrase = ''): string | null {
  /** 去掉首尾空白后的私钥 */
  const text = (pem ?? '').trim();
  if (text === '') {
    return '私钥不能为空！';
  }
  if (isPuttyKey(text)) {
    return '不支持 PuTTY 的 .ppk 私钥，请先转换为 OpenSSH 格式：puttygen key.ppk -O private-openssh -o id_rsa！';
  }
  if (isPkcs8Key(text)) {
    return '不支持 PKCS#8 格式的私钥（-----BEGIN PRIVATE KEY-----），请先转换：ssh-keygen -p -f 私钥文件（按提示输入原口令，新口令留空即可）！';
  }
  if (!PRIVATE_KEY_HEADER.test(text)) {
    return '私钥格式不正确：内容必须以 -----BEGIN ... PRIVATE KEY----- 开头（OpenSSH 或 PEM 格式）！';
  }
  /** 解析结果，注：ssh2 不抛异常，失败时返回 Error */
  const parsed = ssh2.utils.parseKey(
    text,
    passphrase === '' ? undefined : passphrase,
  );
  if (parsed instanceof Error) {
    /** 原始错误信息，注：ssh2 只有一句英文，且不同格式措辞不同，故多认几种 */
    const message = parsed.message;
    if (/no passphrase given/i.test(message)) {
      return '该私钥已加密，请填写私钥口令！';
    }
    if (/bad passphrase|integrity check failed/i.test(message)) {
      return '私钥口令不正确！';
    }
    return `私钥无法解析：${message}（支持 OpenSSH 与 PEM 格式；PKCS#8 与 PuTTY 的 .ppk 请先转换）`;
  }
  // 注：公钥内容（`ssh-ed25519 AAAA…`）走不到这里，它没有 PEM 头，上面就被拦住了；
  // 这一句是防线，防止将来放开格式后被「公钥当私钥填」蒙过去
  if (!parsed.isPrivateKey()) {
    return '这不是私钥：内容是公钥或证书，请填写私钥文件（无 .pub 后缀）的内容！';
  }
  return null;
}
