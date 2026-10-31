// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  authorizationOf,
  canonicalRequestOf,
  dateOf,
  headersOf,
  sha256Hex,
  signatureOf,
  stringToSignOf,
  type SignInput,
} from './api.sign.js';

/**
 * 腾讯云官方签名示例的入参
 *
 * 注 1：取自官方文档《签名方法 v3》的示例（CVM `DescribeInstances`），文档里的 SecretId / SecretKey
 * 是打码的，故**最终签名无法复算** —— 但文档给出了 `HashedRequestPayload`、`HashedCanonicalRequest`
 * 与完整的 CanonicalRequest 正文，这三者足以守住本模块最容易写错的构造逻辑
 * 注 2：`payload` 里的 `\u672a\u547d\u540d` 是**字面转义**（JSON 里的六个字符），不是中文 —— 官方示例
 * 的 payload 摘要正是建立在这个形状上的
 */
const OFFICIAL: SignInput = {
  secretId: 'AKIDEXAMPLE',
  secretKey: 'SECRETEXAMPLE',
  service: 'cvm',
  host: 'cvm.tencentcloudapi.com',
  action: 'DescribeInstances',
  version: '2017-03-12',
  payload:
    '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
  timestamp: 1551113065,
  region: 'ap-guangzhou',
  signedHeaders: ['content-type', 'host', 'x-tc-action'],
};

/** 官方示例的规范请求串（逐字） */
const OFFICIAL_CANONICAL_REQUEST = [
  'POST',
  '/',
  '',
  'content-type:application/json; charset=utf-8',
  'host:cvm.tencentcloudapi.com',
  'x-tc-action:describeinstances',
  '',
  'content-type;host;x-tc-action',
  '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064',
].join('\n');

describe('api.sign', () => {
  it('规范请求串与官方示例逐字一致（含头部块后的空行）', () => {
    expect(canonicalRequestOf(OFFICIAL)).toBe(OFFICIAL_CANONICAL_REQUEST);
  });

  it('规范请求串的摘要与官方给出的 HashedCanonicalRequest 一致', () => {
    expect(sha256Hex(OFFICIAL_CANONICAL_REQUEST)).toBe(
      '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
    );
  });

  it('待签名字符串的日期取 UTC（示例时间戳在东八区已是 02-26）', () => {
    expect(dateOf(OFFICIAL.timestamp)).toBe('2019-02-25');
    expect(stringToSignOf(OFFICIAL, sha256Hex(OFFICIAL_CANONICAL_REQUEST))).toBe(
      [
        'TC3-HMAC-SHA256',
        '1551113065',
        '2019-02-25/cvm/tc3_request',
        '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84',
      ].join('\n'),
    );
  });

  it('缺省只签 content-type;host（与旧私有项目一致，不签 x-tc-action）', () => {
    /** 缺省签名头的规范请求串 */
    const canonical = canonicalRequestOf({
      ...OFFICIAL,
      signedHeaders: undefined,
    });
    expect(canonical.split('\n').at(-2)).toBe('content-type;host');
    expect(canonicalRequestOf(OFFICIAL)).not.toBe(canonical);
  });

  it('Authorization 按规范拼接，签名为 64 位十六进制', () => {
    /** 签名 */
    const signature = signatureOf(OFFICIAL);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(authorizationOf(OFFICIAL)).toBe(
      `TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/cvm/tc3_request, ` +
        `SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    );
  });

  it('任一处输入变化都会改变签名（防止漏参进签名）', () => {
    /** 基准签名 */
    const base = signatureOf(OFFICIAL);
    expect(signatureOf({ ...OFFICIAL, payload: '{}' })).not.toBe(base);
    expect(signatureOf({ ...OFFICIAL, service: 'ssl' })).not.toBe(base);
    expect(signatureOf({ ...OFFICIAL, secretKey: 'OTHER' })).not.toBe(base);
    expect(signatureOf({ ...OFFICIAL, timestamp: 1551113066 })).not.toBe(base);
  });

  it('请求头带齐 X-TC-*，地域为空时不发 X-TC-Region', () => {
    /** 带地域的请求头 */
    const headers = headersOf(OFFICIAL);
    expect(headers['X-TC-Action']).toBe('DescribeInstances');
    expect(headers['X-TC-Version']).toBe('2017-03-12');
    expect(headers['X-TC-Timestamp']).toBe('1551113065');
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
    expect(headers['Content-Type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(headers['Host']).toBe('cvm.tencentcloudapi.com');

    // CDN / SSL / DNSPod 这类无地域的接口不该带该头
    expect(headersOf({ ...OFFICIAL, region: '' })).not.toHaveProperty(
      'X-TC-Region',
    );
  });

  it('不支持的签名头直接抛错（多签一个不发出去的头会被服务端拒绝）', () => {
    expect(() =>
      canonicalRequestOf({ ...OFFICIAL, signedHeaders: ['x-tc-region'] }),
    ).toThrow(/不支持的签名头部/);
  });
});
