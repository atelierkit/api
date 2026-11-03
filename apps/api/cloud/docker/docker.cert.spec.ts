// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  CLIENT_CERT,
  CLIENT_KEY,
  OTHER_CERT,
  OTHER_KEY,
} from './docker.cert.fixture.js';
import {
  certificateErrorOf,
  certificateFormatErrorOf,
  keyPairErrorOf,
} from './docker.cert.js';

describe('certificateFormatErrorOf', () => {
  it('单张可解析的证书通过（CA 留空表示用系统根证书）', () => {
    expect(certificateFormatErrorOf('', CLIENT_CERT)).toBeNull();
    expect(certificateFormatErrorOf(CLIENT_CERT, CLIENT_CERT)).toBeNull();
  });

  it('证书框里拼了 CA / 多张证书时拒绝（Node 只用第一张，错得无声无息）', () => {
    /** 模拟「把 ca 拼在客户端证书前面」的典型误操作 */
    const merged = `${OTHER_CERT}\n${CLIENT_CERT}`;
    expect(certificateFormatErrorOf('', merged)).toContain('包含了 2 张证书');
    expect(certificateFormatErrorOf('', merged)).toContain('只能放客户端证书本身');
  });

  it('空值 / 非 PEM 都被挡住', () => {
    expect(certificateFormatErrorOf('', '')).toContain('不是合法的 PEM 格式');
    expect(certificateFormatErrorOf('', 'hello')).toContain('不是合法的 PEM 格式');
    expect(certificateFormatErrorOf('not-a-pem', CLIENT_CERT)).toContain(
      'CA 证书不是合法的 PEM 格式',
    );
  });

  it('PEM 头在但正文损坏时提示无法解析', () => {
    /** 头部正确、正文是垃圾 */
    const broken = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    expect(certificateFormatErrorOf('', broken)).toContain('无法解析');
  });
});

describe('keyPairErrorOf', () => {
  it('配对的证书与私钥通过', () => {
    expect(keyPairErrorOf(CLIENT_CERT, CLIENT_KEY)).toBeNull();
  });

  it('不同来源的证书与私钥被判定为不匹配', () => {
    expect(keyPairErrorOf(CLIENT_CERT, OTHER_KEY)).toContain('不匹配');
    expect(keyPairErrorOf(OTHER_CERT, CLIENT_KEY)).toContain('不匹配');
  });

  it('私钥为空或无法解析时给各自的提示', () => {
    expect(keyPairErrorOf(CLIENT_CERT, '')).toContain('必须提供客户端私钥');
    expect(keyPairErrorOf(CLIENT_CERT, 'not-a-key')).toContain('无法解析');
  });

  it('证书为空时先报证书问题', () => {
    expect(keyPairErrorOf('', CLIENT_KEY)).toContain('不是合法的 PEM 格式');
  });
});

describe('certificateErrorOf', () => {
  it('先校验形态，再校验配对（形态错了不必谈配对）', () => {
    expect(certificateErrorOf('', CLIENT_CERT, CLIENT_KEY)).toBeNull();
    // 证书与私钥不配对，但只要证书框里是两张，就应该先报「两张」这个更具体的原因
    expect(
      certificateErrorOf('', `${OTHER_CERT}\n${CLIENT_CERT}`, CLIENT_KEY),
    ).toContain('只能放客户端证书本身');
    expect(certificateErrorOf('', CLIENT_CERT, OTHER_KEY)).toContain('不匹配');
  });
});
