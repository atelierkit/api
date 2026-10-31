// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { TEST_CERT_PEM as PEM } from './certificate.fixture.js';
import { parseCertificate } from './certificate.util.js';

describe('parseCertificate', () => {
  it('取出 SAN 里的域名', () => {
    expect(parseCertificate(PEM)?.snis).toEqual([
      'example.com',
      'www.example.com',
    ]);
  });

  it('有效期按秒级时间戳返回（与 Kong 其它时间字段口径一致）', () => {
    /** 解析结果 */
    const info = parseCertificate(PEM);
    expect(info?.start).toBe(Date.UTC(2026, 9, 31, 1, 58, 22) / 1000);
    expect(info?.end).toBe(Date.UTC(2036, 9, 28, 1, 58, 22) / 1000);
  });

  it('不是证书时返回 null，而不是抛错（一张脏证书不该让整页打不开）', () => {
    expect(parseCertificate('不是证书')).toBeNull();
    expect(parseCertificate('')).toBeNull();
    expect(parseCertificate('   ')).toBeNull();
  });

  it('只有私钥的 PEM 也按解析失败处理', () => {
    expect(
      parseCertificate(
        '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      ),
    ).toBeNull();
  });
});
