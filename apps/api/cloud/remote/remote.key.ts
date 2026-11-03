// 外部依赖
import { createHash, createPrivateKey } from 'node:crypto';

/** 私钥 PEM 的起始标记，注：OpenSSH 与 PEM 两种格式都以此开头 */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * 判断是否为 PuTTY 的私钥
 *
 * 注：ssh2 只认 OpenSSH 与 PEM，`.ppk` 会得到一句难以理解的解析错误，
 * 故在保存时就识别出来并给出转换命令
 *
 * @param pem 私钥文本
 * @returns 是 `.ppk` 时为 true
 */
export function isPuttyKey(pem: string): boolean {
  return /PuTTY-User-Key-File/i.test(pem ?? '');
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
 * 注 1：在**保存时**就解析一遍，而不是等到连接时 —— 连接阶段的报错是 OpenSSL 原文
 * （`bad decrypt` / `DECODER routines::unsupported`），用户根本不知道是哪个框填错了
 * 注 2：`createPrivateKey` 对公钥、证书、乱码都会抛错，正好当作「是不是一张可用的私钥」的判据
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
  if (!PRIVATE_KEY_HEADER.test(text)) {
    return '私钥格式不正确：内容必须以 -----BEGIN ... PRIVATE KEY----- 开头（OpenSSH 或 PEM 格式）！';
  }
  try {
    createPrivateKey({
      key: text,
      passphrase: passphrase === '' ? undefined : passphrase,
    });
    return null;
  } catch (err) {
    /** 原始错误信息 */
    const message = err instanceof Error ? err.message : String(err);
    // 注：口令错与「格式不认识」必须分开报 —— 前者改一个字就能连上，后者要重新导出私钥
    if (/bad decrypt|bad password|wrong final block|BAD_PASSWORDS/i.test(message)) {
      return '私钥口令不正确！';
    }
    // 注：加密私钥但没给口令时，OpenSSL 报的是「需要口令」——
    // Node 下具体是 `interrupted or cancelled`（它去要交互输入却被取消了），
    // 不同版本措辞不一，故这里多认几种
    if (
      /passphrase|password|interrupted or cancelled|DECODER routines::unsupported/i.test(
        message,
      )
    ) {
      return '该私钥已加密，请填写私钥口令！';
    }
    return `私钥无法解析：${message}`;
  }
}
