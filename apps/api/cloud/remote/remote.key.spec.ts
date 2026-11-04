// 外部依赖
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  fingerprintOf,
  isPkcs8Key,
  isPuttyKey,
  normalizePrivateKey,
  privateKeyErrorOf,
} from './remote.key.js';

/** 测试口令 */
const PASSPHRASE = 'test-passphrase';

// 注：合法私钥的样本一律用 **ssh2 自带的生成器** 产出 —— 它输出的就是 `ssh-keygen` 的默认形态
// （`-----BEGIN OPENSSH PRIVATE KEY-----`；2026-11-04 用 `ssh-keygen -t ed25519 -N ""` 实测对齐）。
// ⚠️ 不能用 Node 的 `generateKeyPairSync` 当「合法私钥」的样本：它只会产出 PKCS#8，
// 而 PKCS#8 恰恰是 ssh2 解析不了的格式 —— 旧测试正是用它，把真机上的错判盖住了
const PLAIN_PAIR = ssh2.utils.generateKeyPairSync('ed25519');

/** 未加密的 OpenSSH 私钥（`ssh-keygen` 默认产出） */
const PLAIN_KEY = PLAIN_PAIR.private;

/** 加密的 OpenSSH 私钥（口令为 PASSPHRASE） */
const ENCRYPTED_KEY = ssh2.utils.generateKeyPairSync('ed25519', {
  passphrase: PASSPHRASE,
  cipher: 'aes256-ctr',
}).private;

/** 未加密的 RSA 私钥（传统 PEM，`ssh-keygen -t rsa -m PEM` 的产出） */
const PLAIN_PEM_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/**
 * Ed25519 的 PKCS#8 私钥
 *
 * 注：Ed25519 没有传统 PEM 形态（`KeyObject.export` 只支持 pkcs8），
 * 故它只能被拒并给 `ssh-keygen -p` 的转换命令
 */
const PKCS8_KEY = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** PKCS#8 的 RSA 私钥（OpenSSL 3 / Java 默认导出形态），注：可被转换成传统 PEM */
const PKCS8_RSA_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** PKCS#8 的 EC 私钥，注：转成 SEC1（`BEGIN EC PRIVATE KEY`） */
const PKCS8_EC_KEY = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** 带口令的 PKCS#8 私钥（口令为 PASSPHRASE） */
const PKCS8_ENCRYPTED_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: PASSPHRASE,
  },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** 公钥内容（`ssh-ed25519 AAAA…`），注：用来验证「拿公钥当私钥填」会被拒 */
const PUBLIC_KEY = PLAIN_PAIR.public;

/** 有 PEM 头但内容损坏的私钥 */
const BROKEN_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'Zm9vYmFy',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('isPuttyKey', () => {
  it('识别 PuTTY 私钥（v2 与 v3 都算）', () => {
    expect(isPuttyKey('PuTTY-User-Key-File-3: ssh-rsa')).toBe(true);
    expect(isPuttyKey('PuTTY-User-Key-File-2: ssh-rsa')).toBe(true);
  });

  it('OpenSSH 与 PEM 私钥不当成 ppk', () => {
    expect(isPuttyKey(PLAIN_KEY)).toBe(false);
    expect(isPuttyKey(PLAIN_PEM_KEY)).toBe(false);
  });
});

describe('isPkcs8Key', () => {
  it('识别 PKCS#8（明文与加密两种头）', () => {
    expect(isPkcs8Key(PKCS8_KEY)).toBe(true);
    expect(isPkcs8Key('-----BEGIN ENCRYPTED PRIVATE KEY-----')).toBe(true);
  });

  it('OpenSSH 与传统 PEM 不算 PKCS#8', () => {
    // 注：`BEGIN OPENSSH PRIVATE KEY` 与 `BEGIN RSA PRIVATE KEY` 都不带裸的 PRIVATE KEY 前缀
    expect(isPkcs8Key(PLAIN_KEY)).toBe(false);
    expect(isPkcs8Key(PLAIN_PEM_KEY)).toBe(false);
  });
});

describe('privateKeyErrorOf', () => {
  it('未加密的 OpenSSH 私钥通过（回归：不得再提示「已加密，请填写口令」）', () => {
    // 注：这是 2026-11-04 用户报的那个错 —— `ssh-keygen` 默认产出的明文私钥，
    // 旧实现用 `node:crypto` 的 `createPrivateKey` 解析，OpenSSL 不认 OpenSSH 格式，
    // 抛 `DECODER routines::unsupported`，被归成「私钥已加密」的错判
    expect(privateKeyErrorOf(PLAIN_KEY)).toBeNull();
  });

  it('未加密的传统 PEM 私钥通过', () => {
    expect(privateKeyErrorOf(PLAIN_PEM_KEY)).toBeNull();
  });

  it('加密私钥配对口令时通过', () => {
    expect(privateKeyErrorOf(ENCRYPTED_KEY, PASSPHRASE)).toBeNull();
  });

  it('空私钥被拒', () => {
    expect(privateKeyErrorOf('   ')).toContain('不能为空');
  });

  it('PuTTY 的 ppk 给出转换命令，而不是让用户去猜解析错误', () => {
    /** 校验结果 */
    const error = privateKeyErrorOf('PuTTY-User-Key-File-3: ssh-rsa');
    expect(error).toContain('.ppk');
    expect(error).toContain('puttygen');
  });

  it('Ed25519 的 PKCS#8 给出转换命令（该类型没有传统 PEM 形态）', () => {
    /** 校验结果 */
    const error = privateKeyErrorOf(PKCS8_KEY);
    expect(error).toContain('PKCS#8');
    expect(error).toContain('ssh-keygen -p');
  });

  it('不是 PEM 的内容被拒（例如把公钥填进私钥框）', () => {
    expect(privateKeyErrorOf(PUBLIC_KEY)).toContain('格式不正确');
  });

  it('加密私钥不给口令时提示补口令', () => {
    expect(privateKeyErrorOf(ENCRYPTED_KEY)).toBe(
      '该私钥已加密，请填写私钥口令！',
    );
  });

  it('口令错时明确说口令不对（而不是笼统的解析失败）', () => {
    expect(privateKeyErrorOf(ENCRYPTED_KEY, 'wrong-passphrase')).toBe(
      '私钥口令不正确！',
    );
  });

  it('内容损坏时给出解析原文，便于排查', () => {
    expect(privateKeyErrorOf(BROKEN_KEY)).toContain('私钥无法解析');
  });
});

describe('normalizePrivateKey', () => {
  it('PKCS#8 的 RSA 私钥转成传统 PEM（落库的必须是 ssh2 能解析的形态）', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PKCS8_RSA_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.info.format).toBe('pkcs8');
    expect(result.info.converted).toBe(true);
    expect(result.info.privateKey.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(
      true,
    );
    // 注：判据不是「转换函数没报错」，而是**转换产物能被 ssh2 解析** —— 那才是连接时的真实口径
    expect(ssh2.utils.parseKey(result.info.privateKey)).not.toBeInstanceOf(Error);
  });

  it('PKCS#8 的 EC 私钥转成 SEC1', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PKCS8_EC_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.info.privateKey.startsWith('-----BEGIN EC PRIVATE KEY-----')).toBe(
      true,
    );
    expect(ssh2.utils.parseKey(result.info.privateKey)).not.toBeInstanceOf(Error);
  });

  it('带口令的 PKCS#8 在口令正确时也能转换，且标记为加密', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PKCS8_ENCRYPTED_KEY, PASSPHRASE);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.info.encrypted).toBe(true);
    // 注：转换产物是明文 PEM，连接时再传口令不影响解析（2026-11-04 实测）
    expect(
      ssh2.utils.parseKey(result.info.privateKey, PASSPHRASE),
    ).not.toBeInstanceOf(Error);
  });

  it('带口令的 PKCS#8 不给口令时提示补口令', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PKCS8_ENCRYPTED_KEY);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('不该通过');
    }
    expect(result.message).toBe('该私钥已加密，请填写私钥口令！');
  });

  it('带口令的 PKCS#8 口令错时明确说口令不对', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PKCS8_ENCRYPTED_KEY, 'wrong-passphrase');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('不该通过');
    }
    expect(result.message).toBe('私钥口令不正确！');
  });

  it('Ed25519 的 PKCS#8 说明「没有传统 PEM 形态」并给 ssh-keygen 命令', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PKCS8_KEY);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('不该通过');
    }
    expect(result.message).toContain('ed25519');
    expect(result.message).toContain('ssh-keygen -p');
  });

  it('OpenSSH 私钥原样通过（不做无谓的改写）', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PLAIN_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.info.format).toBe('openssh');
    expect(result.info.converted).toBe(false);
    expect(result.info.encrypted).toBe(false);
    expect(result.info.privateKey).toBe(PLAIN_KEY.trim());
  });

  it('传统 PEM 原样通过，且标记为 pem', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PLAIN_PEM_KEY);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.info.format).toBe('pem');
    expect(result.info.converted).toBe(false);
  });

  it('带 BOM / CRLF / 首尾空白的文件内容被归一（从本地文件读出来就是这样）', () => {
    /** 模拟 Windows 记事本保存过的私钥文件 */
    const raw = `\uFEFF${PLAIN_KEY.replace(/\n/g, '\r\n')}\r\n`;
    /** 规范化结果 */
    const result = normalizePrivateKey(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.info.privateKey).toBe(PLAIN_KEY.trim());
  });

  it('指纹取自私钥对应的公钥 blob（与本机 ssh-keygen -l 同一口径）', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PLAIN_KEY);
    if (!result.ok) {
      throw new Error(result.message);
    }
    /** 用独立路径（ssh2 直接解析原文）再算一遍，防止指纹取错字段 */
    const parsed = ssh2.utils.parseKey(PLAIN_KEY);
    if (parsed instanceof Error) {
      throw parsed;
    }
    expect(result.info.fingerprint).toBe(fingerprintOf(parsed.getPublicSSH()));
    expect(result.info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('超过 16 KB 的内容被判为选错文件', () => {
    /** 超长内容 */
    const result = normalizePrivateKey(`-----BEGIN ${'A'.repeat(17000)}`);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('不该通过');
    }
    expect(result.message).toContain('过大');
  });

  it('公钥内容被拒（没有私钥 PEM 头）', () => {
    /** 规范化结果 */
    const result = normalizePrivateKey(PUBLIC_KEY);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('不该通过');
    }
    expect(result.message).toContain('格式不正确');
  });
});

describe('fingerprintOf', () => {
  it('与 ssh-keygen -E sha256 的口径一致（SHA256: + base64，去掉填充）', () => {
    // 注：固定输入 → 固定输出，防止「用同一个算法算两遍」这种自证式断言
    expect(fingerprintOf(Buffer.from('abc'))).toBe(
      'SHA256:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0',
    );
  });

  it('不含 base64 的 = 填充', () => {
    expect(fingerprintOf(Buffer.from('a'))).not.toContain('=');
  });

  it('不同公钥得到不同指纹', () => {
    expect(fingerprintOf(Buffer.from('one'))).not.toBe(
      fingerprintOf(Buffer.from('two')),
    );
  });
});
