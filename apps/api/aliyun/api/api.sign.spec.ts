// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  SIGNATURE_METHOD,
  SIGNATURE_VERSION,
  canonicalize,
  percentEncode,
  signatureOf,
  stringToSignOf,
} from './api.sign.js';

/**
 * 签名向量
 *
 * 注 1：**不要**拿官方文档《API 参考（2018-07-13）》第 7 页的示例当基准 —— 那份示例自相矛盾：
 * 按它自己给出的 `stringToSign` 复算得到 `Eo6r0wrahmpSMVb0Z6OxRrgrRLk=`，
 * 与文档声称的 `CT9X0VtwR86fNWSnsc6v8YGOjuE=` 并不相等（示例漏了对 `&` / `=` 的二次编码）。
 * 注 2：下面的期望值按《签名机制》规范独立推导，且同一套实现在真机（`cloud_keys.id=3`）
 * 上跑通了几十个接口，可作为回归基准。
 */
const VECTOR_PARAMS = {
  AccessKeyId: 'testid',
  Action: 'DescribeUserCertificateList',
  Format: 'JSON',
  SignatureMethod: SIGNATURE_METHOD,
  SignatureNonce: 'nonce',
  SignatureVersion: SIGNATURE_VERSION,
  Timestamp: '2016-02-23T12:46:24Z',
  Version: '2018-07-13',
};

/** 期望的规范查询串 */
const EXPECTED_CANONICAL =
  'AccessKeyId=testid&Action=DescribeUserCertificateList&Format=JSON' +
  '&SignatureMethod=HMAC-SHA1&SignatureNonce=nonce&SignatureVersion=1.0' +
  '&Timestamp=2016-02-23T12%3A46%3A24Z&Version=2018-07-13';

/** 期望的待签名字符串，注：`%3A` 会被二次编码成 `%253A` */
const EXPECTED_STRING_TO_SIGN =
  'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeUserCertificateList%26Format%3DJSON' +
  '%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3Dnonce%26SignatureVersion%3D1.0' +
  '%26Timestamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2018-07-13';

describe('percentEncode', () => {
  it('字母数字与 - _ . ~ 保持原样', () => {
    expect(percentEncode('aZ09-_.~')).toBe('aZ09-_.~');
  });

  it('通配符 `*` 必须编码成 %2A（通配符域名参与签名时必踩）', () => {
    expect(percentEncode('*.example.com')).toBe('%2A.example.com');
  });

  it('空格编码成 %20 而不是 +', () => {
    expect(percentEncode('a b')).toBe('a%20b');
  });

  it("编码 encodeURIComponent 会放过的 ! ' ( ) 五个字符", () => {
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('中文按 UTF-8 逐字节编码', () => {
    expect(percentEncode('中')).toBe('%E4%B8%AD');
  });

  it('四字节字符（emoji）也按 UTF-8 编码', () => {
    expect(percentEncode('😀')).toBe('%F0%9F%98%80');
  });
});

describe('canonicalize', () => {
  it('按键名升序并用 & 连接', () => {
    expect(canonicalize({ b: '2', a: '1', c: '3' })).toBe('a=1&b=2&c=3');
  });

  it('剔除 undefined 与 null（阿里云不认空值参数）', () => {
    expect(canonicalize({ a: '1', b: undefined, c: null })).toBe('a=1');
  });

  it('数字与布尔按字符串处理', () => {
    expect(canonicalize({ n: 10, f: false, t: true })).toBe('f=false&n=10&t=true');
  });

  it('空对象得到空串', () => {
    expect(canonicalize({})).toBe('');
  });
});

describe('stringToSignOf', () => {
  it('按 `方法&编码路径&编码后的规范查询串` 拼接', () => {
    expect(stringToSignOf('GET', VECTOR_PARAMS)).toBe(EXPECTED_STRING_TO_SIGN);
  });

  it('方法名原样保留（POST 与 GET 的签名不同）', () => {
    expect(stringToSignOf('POST', VECTOR_PARAMS)).toBe(
      EXPECTED_STRING_TO_SIGN.replace(/^GET/, 'POST'),
    );
  });
});

describe('signatureOf', () => {
  it('与独立推导的向量一致', () => {
    expect(signatureOf('testsecret', 'GET', VECTOR_PARAMS)).toBe(
      'ZKi43AM6XtW4PhS4K5eO5q4MGD4%3D',
    );
  });

  it('签名结果对 Secret 敏感', () => {
    expect(signatureOf('othersecret', 'GET', VECTOR_PARAMS)).not.toBe(
      signatureOf('testsecret', 'GET', VECTOR_PARAMS),
    );
  });

  it('签名结果对参数敏感（少一个参数就变）', () => {
    /** 去掉 Action 的参数集 */
    const { Action: _action, ...rest } = VECTOR_PARAMS;
    expect(signatureOf('testsecret', 'GET', rest)).not.toBe(
      signatureOf('testsecret', 'GET', VECTOR_PARAMS),
    );
  });
});

describe('canonicalize 与 stringToSignOf', () => {
  it('向量里的规范查询串与签名器实际使用的一致', () => {
    expect(canonicalize(VECTOR_PARAMS)).toBe(EXPECTED_CANONICAL);
  });
});
