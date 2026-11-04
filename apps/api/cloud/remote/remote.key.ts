// 外部依赖
import { createHash, createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import ssh2 from 'ssh2';

/** 私钥 PEM 的起始标记，注：OpenSSH 与 PEM 两种格式都以此开头 */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** OpenSSH 私钥的起始标记，注：`ssh-keygen` 自 7.8 起默认产出这种格式 */
const OPENSSH_HEADER = /^-----BEGIN OPENSSH PRIVATE KEY-----/m;

/** PKCS#8 私钥的起始标记，注：传统 PEM 是 `BEGIN RSA / EC / DSA PRIVATE KEY`，与它不冲突 */
const PKCS8_HEADER = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/;

/** 加密 PKCS#8 的起始标记，注：正文已被加密，没有口令时不能交给 OpenSSL 解析 */
const PKCS8_ENCRYPTED_HEADER = /^-----BEGIN ENCRYPTED PRIVATE KEY-----/m;

/** 私钥内容上限（字符数），注：2048 位 RSA 的 PEM 约 1.7 KB，16 KB 足够任何合法私钥 */
const MAX_KEY_CHARS = 16 * 1024;

/**
 * PuTTY 私钥的处置提示
 *
 * 注：ssh2 只认 PPK v2，现代 PuTTY 默认导出 v3，且 v3 的加密封包用 Argon2（纯 JS 侧没有现成实现），
 * 故不在本模块解析，直接给一条能照抄的命令
 */
const PUTTY_HINT =
  '不支持 PuTTY 的 .ppk 私钥，请先转换为 OpenSSH 格式：puttygen key.ppk -O private-openssh -o id_rsa！';

/** 私钥的原始格式 */
export type RemoteKeyFormat = 'openssh' | 'pem' | 'pkcs8';

/** 私钥识别与规范化结果 */
export interface RemoteKeyInfo {
  /** 可直接交给 ssh2 的私钥文本（OpenSSH 或传统 PEM） */
  privateKey: string;
  /**
   * 原始格式
   *
   * 注：`pkcs8` 只是**录入时**的形态 —— 它会被转换成 PEM 再落库，
   * 因此库里存的值只会是 `openssh` 或 `pem`
   */
  format: RemoteKeyFormat;
  /** 是否发生了格式转换（PKCS#8 → PEM） */
  converted: boolean;
  /** 私钥自身是否带口令 */
  encrypted: boolean;
  /** 私钥对应公钥的指纹，形如 `SHA256:…`，供用户与自己本机 `ssh-keygen -l` 的结果对照 */
  fingerprint: string;
}

/**
 * 规范化结果
 *
 * 注：本模块是纯函数，不抛 HTTP 异常 —— 服务层把它转成 422、控制器把它转成响应，形态由调用方决定
 */
export type RemoteKeyResult =
  | { ok: true; info: RemoteKeyInfo }
  | { ok: false; message: string };

/**
 * 判断是否为 PuTTY 的私钥
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
 * 而 Java / OpenSSL 3 / 部分云厂商导出的私钥默认就是它 ⇒ 录入时要先转成传统 PEM
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
 * 规范化私钥文本
 *
 * 注 1：用户是从本地文件读出来的内容，可能带 BOM、CRLF 或尾部空行，
 * 这些都先归一，否则后续的正则与 OpenSSL 解析会各自失败在不同地方
 * 注 2：口令不在这里处理（由调用方按需传入），空串与 `undefined` 等价
 *
 * @param content 私钥原文
 * @returns 归一后的文本
 */
function cleanKeyText(content: string): string {
  return (content ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * 把 PKCS#8 私钥转成 ssh2 认得的形式
 *
 * 注 1：RSA 转 PKCS#1（`BEGIN RSA PRIVATE KEY`）、EC 转 SEC1（`BEGIN EC PRIVATE KEY`）——
 * 这两种就是 `ssh-keygen -m PEM` 的产出形态，ssh2 直接可解析
 * 注 2：Ed25519 没有传统 PEM 形态，`KeyObject.export` 只支持 pkcs8，故明确拒绝并给命令
 * 注 3：转换产物是**明文** PEM（口令已用于解开原文件）；连接时再传口令对明文私钥无副作用 ——
 * `ssh2.utils.parseKey(明文, 口令)` 实测正常，故库里保留口令不影响后续连接
 *
 * @param text 已归一的 PKCS#8 私钥文本
 * @param passphrase 私钥口令，空串表示无口令
 * @returns 转换后的 PEM，或可读的错误文案
 */
function pkcs8ToPem(
  text: string,
  passphrase: string,
): { pem: string } | { message: string } {
  // 注：加密的 PKCS#8 在没口令时 OpenSSL 只会给一句
  // `common libcrypto routines::interrupted or cancelled`，不如直接自己给文案
  if (PKCS8_ENCRYPTED_HEADER.test(text) && passphrase === '') {
    return { message: '该私钥已加密，请填写私钥口令！' };
  }
  /** 解析出的密钥对象 */
  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: text,
      format: 'pem',
      passphrase: passphrase === '' ? undefined : passphrase,
    });
  } catch (err) {
    /** 原始错误信息 */
    const message = err instanceof Error ? err.message : String(err);
    // 注：口令错在 OpenSSL 3 上是 `Provider routines::bad decrypt`，
    // 在旧的 `RSA PRIVATE KEY` 解包路径上是 `wrong final block length`
    if (/bad decrypt|bad passphrase|wrong final block length/i.test(message)) {
      return { message: '私钥口令不正确！' };
    }
    return {
      message: `私钥无法解析：${message}（支持 OpenSSH / PEM / PKCS#8 格式）`,
    };
  }
  if (key.asymmetricKeyType === 'rsa') {
    return { pem: String(key.export({ type: 'pkcs1', format: 'pem' })) };
  }
  if (key.asymmetricKeyType === 'ec') {
    return { pem: String(key.export({ type: 'sec1', format: 'pem' })) };
  }
  return {
    message: `不支持 ${key.asymmetricKeyType ?? '该类型'} 的 PKCS#8 私钥（Ed25519 等没有传统 PEM 形态），请先转换为 OpenSSH 格式：ssh-keygen -p -f 私钥文件（按提示输入原口令，新口令留空即可）！`,
  };
}

/**
 * ssh2 的解析错误 → 可读文案
 *
 * 注：ssh2 只给一句英文，且不同格式措辞不同，故多认几种；认不出时保留原文，
 * 排查时那句英文就是唯一线索
 *
 * @param message ssh2 的原始错误
 * @returns 面向用户的文案
 */
function parseMessageOf(message: string): string {
  if (/no passphrase given/i.test(message)) {
    return '该私钥已加密，请填写私钥口令！';
  }
  if (/bad passphrase|integrity check failed/i.test(message)) {
    return '私钥口令不正确！';
  }
  return `私钥无法解析：${message}（支持 OpenSSH / PEM / PKCS#8 格式；PuTTY 的 .ppk 请先转换）`;
}

/**
 * 判断私钥是否带口令
 *
 * 注 1：先看头部标记（加密 PKCS#8 与加密的传统 PEM 都有明确标记），
 * 再看「不给口令能否解析成功」—— OpenSSH 格式的加密标记在二进制头里，只能这么判
 * 注 2：这里只回答「私钥自身是否加密」，与「口令填得对不对」是两件事：
 * 后者由调用方的解析结果决定
 *
 * @param text 已归一的私钥原文
 * @returns 带口令时为 true
 */
function isEncryptedKey(text: string): boolean {
  if (PKCS8_ENCRYPTED_HEADER.test(text)) {
    return true;
  }
  if (/^Proc-Type:\s*4,\s*ENCRYPTED/mi.test(text)) {
    return true;
  }
  /** 不带口令的解析结果 */
  const parsed = ssh2.utils.parseKey(text);
  return (
    parsed instanceof Error &&
    /no passphrase given|Encrypted .*private key/i.test(parsed.message)
  );
}

/**
 * 读取并规范化私钥
 *
 * 注 1：这是私钥录入的唯一入口 —— 保存、预检、连接前校验都走它，
 * 保证「什么格式能过」只有一个口径；校验用的是 **ssh2 自己的解析器**
 * （`ssh2.utils.parseKey`），与连接时同一套代码，避免「保存通过、连接才发现解析不了」
 * 注 2：**不要用 `node:crypto` 的 `createPrivateKey` 当格式判据**：它不认 OpenSSH 格式
 * （`ssh-keygen` 默认产出、现实中绝大多数私钥），对明文私钥也抛
 * `DECODER routines::unsupported`，会被误判成「私钥已加密」——
 * 2026-11-04 用户报的「私钥明明没设口令却提示已加密」就是这个错判。
 * 它在本模块的唯一用途是把 PKCS#8 **转换**掉（转换后照样回到 ssh2 校验）
 * 注 3：PuTTY 的 `.ppk`（v2/v3）与 Ed25519 的 PKCS#8 给的是「怎么转」的命令，
 * 因为纯 JS 侧没有对应的解密实现（v3 用 Argon2）
 *
 * @param content 私钥原文（本地文件内容或粘贴的文本）
 * @param passphrase 私钥口令，空串表示无口令
 * @returns 规范化结果
 */
export function normalizePrivateKey(
  content: string,
  passphrase = '',
): RemoteKeyResult {
  /** 归一后的私钥原文 */
  const text = cleanKeyText(content);
  if (text === '') {
    return { ok: false, message: '私钥不能为空！' };
  }
  if (text.length > MAX_KEY_CHARS) {
    return {
      ok: false,
      message: '私钥内容过大（超过 16 KB），请确认选择的是私钥文件本身！',
    };
  }
  if (isPuttyKey(text)) {
    return { ok: false, message: PUTTY_HINT };
  }
  /** 原始格式 */
  const format: RemoteKeyFormat = isPkcs8Key(text)
    ? 'pkcs8'
    : OPENSSH_HEADER.test(text)
      ? 'openssh'
      : 'pem';
  if (format === 'pem' && !PRIVATE_KEY_HEADER.test(text)) {
    return {
      ok: false,
      message:
        '私钥格式不正确：内容必须以 -----BEGIN ... PRIVATE KEY----- 开头（OpenSSH 或 PEM 格式）！',
    };
  }
  /** 待交给 ssh2 的私钥 */
  let privateKey = text;
  if (format === 'pkcs8') {
    /** 转换结果 */
    const converted = pkcs8ToPem(text, passphrase);
    if ('message' in converted) {
      return { ok: false, message: converted.message };
    }
    privateKey = converted.pem;
  }
  /** ssh2 的解析结果 */
  const parsed = ssh2.utils.parseKey(
    privateKey,
    passphrase === '' ? undefined : passphrase,
  );
  if (parsed instanceof Error) {
    return { ok: false, message: parseMessageOf(parsed.message) };
  }
  // 注：公钥内容（`ssh-ed25519 AAAA…`）走不到这里（它没有 PEM 头，上面就被拦住了）；
  // 这一句是防线，防止将来放开格式后被「公钥当私钥填」蒙过去
  if (!parsed.isPrivateKey()) {
    return {
      ok: false,
      message: '这不是私钥：内容是公钥或证书，请填写私钥文件（无 .pub 后缀）的内容！',
    };
  }
  return {
    ok: true,
    info: {
      privateKey,
      format,
      converted: format === 'pkcs8',
      encrypted: isEncryptedKey(text),
      fingerprint: fingerprintOf(parsed.getPublicSSH()),
    },
  };
}

/**
 * 校验私钥形态
 *
 * 注：只用得到「对不对」，不需要规范化产物时的便捷包装（如连接前的兜底校验）；
 * 需要落库时请直接用 `normalizePrivateKey` 拿转换后的内容
 *
 * @param pem 私钥文本
 * @param passphrase 私钥口令，无口令时传空串
 * @returns 错误文案，校验通过时为 null
 */
export function privateKeyErrorOf(pem: string, passphrase = ''): string | null {
  /** 规范化结果 */
  const result = normalizePrivateKey(pem, passphrase);
  return result.ok ? null : result.message;
}
