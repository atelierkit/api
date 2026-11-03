// 外部依赖
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { fingerprintOf, isPuttyKey, privateKeyErrorOf } from './remote.key.js';

/** 测试口令 */
const PASSPHRASE = 'test-passphrase';

/** 未加密的 RSA 私钥（PKCS#8） */
const PLAIN_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** 加密的 RSA 私钥（PKCS#8，口令为 PASSPHRASE） */
const ENCRYPTED_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: PASSPHRASE,
  },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** 公钥，注：用来验证「拿公钥当私钥填」会被拒 */
const PUBLIC_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).publicKey;

describe('isPuttyKey', () => {
  it('识别 PuTTY 私钥', () => {
    expect(isPuttyKey('PuTTY-User-Key-File-3: ssh-rsa')).toBe(true);
  });

  it('OpenSSH 与 PEM 私钥不当成 ppk', () => {
    expect(isPuttyKey(PLAIN_KEY)).toBe(false);
  });
});

describe('privateKeyErrorOf', () => {
  it('合法私钥通过', () => {
    expect(privateKeyErrorOf(PLAIN_KEY)).toBeNull();
  });

  it('加密私钥配对口令时通过', () => {
    expect(privateKeyErrorOf(ENCRYPTED_KEY, PASSPHRASE)).toBeNull();
  });

  it('空私钥被拒', () => {
    expect(privateKeyErrorOf('   ')).toContain('不能为空');
  });

  it('PuTTY 的 ppk 给出转换命令，而不是让用户去猜 OpenSSL 报错', () => {
    /** 校验结果 */
    const error = privateKeyErrorOf('PuTTY-User-Key-File-3: ssh-rsa');
    expect(error).toContain('.ppk');
    expect(error).toContain('puttygen');
  });

  it('不是 PEM 的内容被拒（例如把公钥或证书填进私钥框）', () => {
    expect(privateKeyErrorOf(PUBLIC_KEY)).toContain('格式不正确');
  });

  it('加密私钥不给口令时提示补口令', () => {
    expect(privateKeyErrorOf(ENCRYPTED_KEY)).toContain('口令');
  });

  it('口令错时明确说口令不对（而不是笼统的解析失败）', () => {
    expect(privateKeyErrorOf(ENCRYPTED_KEY, 'wrong-passphrase')).toContain(
      '口令不正确',
    );
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
