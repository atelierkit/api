// 外部依赖
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  fingerprintOf,
  isPkcs8Key,
  isPuttyKey,
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

/** PKCS#8 私钥，注：Node 只产这一种；ssh2 不认，应当被拦下并给转换命令 */
const PKCS8_KEY = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
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

  it('PKCS#8 私钥给出转换命令（ssh2 解析不了这种格式）', () => {
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
