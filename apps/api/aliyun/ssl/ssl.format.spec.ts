// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  certItemOf,
  dnsRecordOf,
  dnsStatusOf,
  domainLevelsOf,
  orderItemOf,
  sansOf,
  timeOf,
} from './ssl.format.js';

/** 实测的证书条目形状（`OrderType=CERT`，2026-11-06 签发后真机返回） */
const CERT_RAW = {
  Status: 'ISSUED',
  Sha2: '4562399580BE23B',
  SerialNo: '0f5c7b46560d360c3027b58071fc835c',
  Fingerprint: '812699237ADF9CD0B82E0D84D24E8AA5341FAAF0',
  ResourceGroupId: 'rg-acfmyht4tprdvly',
  InstanceId: 'cas-cn-45912b2nt0wd',
  Issuer: 'DigiCert Inc',
  CertEndTime: 1801699199000,
  CertificateId: 28334622,
  Upload: false,
  OrgName: '',
  Expired: false,
  City: '',
  CertStartTime: 1793923200000,
  EndDate: '2027-02-03',
  Province: '',
  Name: 'cert-1851806',
  StartDate: '2026-11-06',
  Sans: 'kong.marbleqi.top,www.kong.marbleqi.top',
  Country: '',
  CommonName: 'kong.marbleqi.top',
};

/** 实测的订单条目形状（不传 OrderType / BUY） */
const ORDER_RAW = {
  Status: 'EXPIRED',
  ProductName: 'EEFreeSSL',
  InstanceId: 'cas-cn-45912cyfl19k',
  ProductCode: 'digicert-free-1-free',
  CertEndTime: 1736524799000,
  SourceType: 'buy',
  CertType: 'FREE',
  WildDomainCount: 0,
  PartnerOrderId: 'DD-2024-10-12-255a12',
  CertStartTime: 1728662400000,
  OrderId: 1855371,
  Algorithm: 'RSA',
  RootBrand: 'DigiCert',
  AliyunOrderId: 203445964250086,
  DomainType: 'ONE',
  TrusteeStatus: 'untrustee',
  Domain: 'center.xmslol.cn',
  BuyDate: 1553937109000,
  DomainCount: 1,
};

describe('sansOf', () => {
  it('拆半角逗号分隔串（阿里云证书条目的实际形状）', () => {
    expect(sansOf('a.com,www.a.com')).toEqual(['a.com', 'www.a.com']);
  });

  it('吃掉数组形状', () => {
    expect(sansOf(['a.com', 'b.com'])).toEqual(['a.com', 'b.com']);
  });

  it('去空白、去重并保留顺序', () => {
    expect(sansOf(' a.com , a.com ,b.com ')).toEqual(['a.com', 'b.com']);
  });

  it('空串 / 非字符串一律得到空数组', () => {
    expect(sansOf('')).toEqual([]);
    expect(sansOf(undefined)).toEqual([]);
    expect(sansOf(123)).toEqual([]);
  });
});

describe('timeOf', () => {
  it('毫秒时间戳转 ISO', () => {
    expect(timeOf(1793923200000)).toBe('2026-11-06T00:00:00.000Z');
  });

  it('纯日期按 UTC 零点补齐（不按本地时区）', () => {
    expect(timeOf('2027-02-03')).toBe('2027-02-03T00:00:00.000Z');
  });

  it('ISO 字符串原样归一', () => {
    expect(timeOf('2026-11-06T08:00:00.000Z')).toBe('2026-11-06T08:00:00.000Z');
  });

  it('空值与 0 得到空串（0 表示「未设置」，不是 1970 年）', () => {
    expect(timeOf(0)).toBe('');
    expect(timeOf('')).toBe('');
    expect(timeOf(undefined)).toBe('');
  });

  it('无法解析的文本得到空串', () => {
    expect(timeOf('not-a-date')).toBe('');
  });
});

describe('certItemOf', () => {
  it('把证书条目归一成前端契约', () => {
    expect(certItemOf(CERT_RAW)).toEqual({
      certId: 28334622,
      instanceId: 'cas-cn-45912b2nt0wd',
      name: 'cert-1851806',
      domain: 'kong.marbleqi.top',
      sans: ['kong.marbleqi.top', 'www.kong.marbleqi.top'],
      issuer: 'DigiCert Inc',
      startAt: '2026-11-06T00:00:00.000Z',
      endAt: '2027-02-03T00:00:00.000Z',
      expired: false,
      uploaded: false,
    });
  });

  it('Sans 缺失时退回主域名（前端列表不留空列）', () => {
    /** 去掉 Sans 的条目 */
    const { Sans: _sans, ...rest } = CERT_RAW;
    expect(certItemOf(rest).sans).toEqual(['kong.marbleqi.top']);
  });

  it('日期字段缺失时退回毫秒时间戳', () => {
    /** 去掉日期字符串的条目 */
    const { StartDate: _s, EndDate: _e, ...rest } = CERT_RAW;
    expect(certItemOf(rest).startAt).toBe('2026-11-06T00:00:00.000Z');
    expect(certItemOf(rest).endAt).toBe('2027-02-03T23:59:59.000Z');
  });

  it('空对象不抛错，字段退化为空值', () => {
    expect(certItemOf({})).toEqual({
      certId: 0,
      instanceId: '',
      name: '',
      domain: '',
      sans: [],
      issuer: '',
      startAt: '',
      endAt: '',
      expired: false,
      uploaded: false,
    });
  });

  it('上传证书的 Upload 标记为 true', () => {
    expect(certItemOf({ ...CERT_RAW, Upload: true }).uploaded).toBe(true);
  });
});

describe('orderItemOf', () => {
  it('把订单条目归一成前端契约', () => {
    expect(orderItemOf(ORDER_RAW)).toEqual({
      instanceId: 'cas-cn-45912cyfl19k',
      orderId: 1855371,
      status: 'EXPIRED',
      certType: 'FREE',
      product: 'EEFreeSSL',
      domain: 'center.xmslol.cn',
      boughtAt: '2019-03-30T09:11:49.000Z',
      endAt: '2025-01-10T15:59:59.000Z',
    });
  });

  it('未使用额度（Domain 为空串）如实保留', () => {
    expect(orderItemOf({ ...ORDER_RAW, Domain: '' }).domain).toBe('');
  });
});

describe('dnsRecordOf', () => {
  it('待验证状态返回 TXT 记录', () => {
    expect(
      dnsRecordOf({
        Type: 'domain_verify',
        RecordType: 'TXT',
        RecordDomain: '_dnsauth.a.com',
        RecordValue: 'v1',
      }),
    ).toEqual({ type: 'TXT', domain: '_dnsauth.a.com', value: 'v1' });
  });

  it('FILE 验证没有 DNS 记录', () => {
    expect(
      dnsRecordOf({ Type: 'domain_verify', ValidateType: 'FILE', Uri: '/x' }),
    ).toBeNull();
  });

  it('已签发 / 待申请状态下没有验证记录', () => {
    expect(dnsRecordOf({ Type: 'certificate' })).toBeNull();
    expect(dnsRecordOf({ Type: 'payed' })).toBeNull();
  });

  it('缺记录名或记录值时返回 null（宁可不下发，也不下发半条）', () => {
    expect(
      dnsRecordOf({ Type: 'domain_verify', RecordType: 'TXT', RecordDomain: '_x' }),
    ).toBeNull();
  });
});

describe('domainLevelsOf', () => {
  it('从最具体逐级上推到注册域', () => {
    expect(domainLevelsOf('_dnsauth.kong.example.com')).toEqual([
      '_dnsauth.kong.example.com',
      'kong.example.com',
      'example.com',
    ]);
  });

  it('两段域名只给自己', () => {
    expect(domainLevelsOf('example.com')).toEqual(['example.com']);
  });

  it('单段标签不产生候选（不是可查域名）', () => {
    expect(domainLevelsOf('localhost')).toEqual([]);
  });
});

describe('dnsStatusOf', () => {
  it('没有同类记录 → pending', () => {
    expect(dnsStatusOf('v1', [])).toBe('pending');
  });

  it('值命中 → matched（忽略首尾空白）', () => {
    expect(dnsStatusOf('v1', [' v1 '])).toBe('matched');
  });

  it('有记录但值不符 → mismatched', () => {
    expect(dnsStatusOf('v1', ['v2'])).toBe('mismatched');
  });
});
