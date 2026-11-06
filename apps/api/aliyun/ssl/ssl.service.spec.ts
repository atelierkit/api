// 外部依赖
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KongService } from '../../cloud/kong/kong.service.js';
import { ObjectService } from '../../cloud/kong/object/object.service.js';
import { AliyunException } from '../api/api.request.js';
import { ApiService } from '../api/api.service.js';
import { SslService } from './ssl.service.js';

/** DNS 探测替身，注：`verify` 只负责编排，解析细节在 `ssl.dns.spec.ts` 里测 */
const dnsMock = vi.hoisted(() => ({
  probeDns: vi.fn(),
}));

vi.mock('./ssl.dns.js', () => dnsMock);

/** 证书条目（真机形状） */
const CERT_RAW = {
  CertificateId: 28334622,
  InstanceId: 'cas-cn-45912b2nt0wd',
  Name: 'cert-1851806',
  CommonName: 'kong.marbleqi.top',
  Sans: 'kong.marbleqi.top,www.kong.marbleqi.top',
  Issuer: 'DigiCert Inc',
  StartDate: '2026-11-06',
  EndDate: '2027-02-03',
  Expired: false,
  Upload: false,
};

/** 订单条目（真机形状） */
const ORDER_RAW = {
  InstanceId: 'cas-cn-45912cyfl19k',
  OrderId: 1855371,
  Status: 'EXPIRED',
  CertType: 'FREE',
  ProductName: 'EEFreeSSL',
  Domain: '',
  BuyDate: 1553937109000,
  CertEndTime: 1736524799000,
};

/**
 * 组装被测服务
 *
 * @returns 被测服务与各替身
 */
function serviceOf() {
  /** 阿里云接口服务替身 */
  const apiSrv = {
    ssl: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
    sslPost: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
  };
  /** KONG 站点服务替身 */
  const kongSrv = {
    show: vi.fn(async (_id: number) => ({ id: 1 }) as unknown),
  };
  /** KONG 对象服务替身 */
  const objectSrv = {
    create: vi.fn(async (..._args: unknown[]) => ({ id: 'kong-1' }) as unknown),
    update: vi.fn(async (..._args: unknown[]) => ({ id: 'kong-1' }) as unknown),
  };
  return {
    service: new SslService(
      apiSrv as unknown as ApiService,
      kongSrv as unknown as KongService,
      objectSrv as unknown as ObjectService,
    ),
    apiSrv,
    kongSrv,
    objectSrv,
  };
}

describe('SslService', () => {
  beforeEach(() => {
    dnsMock.probeDns.mockReset();
  });

  describe('list', () => {
    it('固定 OrderType=CERT 并归一化条目', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({
        TotalCount: 1,
        CertificateOrderList: [CERT_RAW],
      });

      /** 返回结果 */
      const result = await service.list(3, { CurrentPage: 1, ShowSize: 10 });
      expect(apiSrv.ssl).toHaveBeenCalledWith(3, 'ListUserCertificateOrder', {
        CurrentPage: 1,
        ShowSize: 10,
        OrderType: 'CERT',
      });
      expect(result.total).toBe(1);
      expect(result.items[0]?.certId).toBe(28334622);
      expect(result.items[0]?.sans).toEqual([
        'kong.marbleqi.top',
        'www.kong.marbleqi.top',
      ]);
    });

    it('数组缺失时返回空列表（不把 undefined 抛给前端）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({ TotalCount: 0 });
      expect(await service.list(3, {})).toEqual({ total: 0, items: [] });
    });

    it('额度不足翻成可读中文（不把「额度不足。」直接抛给用户）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockRejectedValue(
        new AliyunException('InsufficientQuota', '额度不足。', 400),
      );
      await expect(service.list(3, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.list(3, {})).rejects.toThrow('证书资源包');
    });

    it('NotFound 转 404', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockRejectedValueOnce(
        new AliyunException('NotFound', '没有找到必要内容', 400),
      );
      await expect(service.list(3, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('其他错误原样抛出（保留阿里云错误码）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      /** 原始异常 */
      const raw = new AliyunException('ServiceUnavailable', '服务不可用', 503);
      apiSrv.ssl.mockRejectedValueOnce(raw);
      await expect(service.list(3, {})).rejects.toBe(raw);
    });
  });

  describe('show / pem', () => {
    it('概览归一化（含证书链与部署信息）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({
        CertificateId: 28334622,
        CertificateName: 'cert-1851806',
        CommonName: 'kong.marbleqi.top',
        SubjectAlternativeNames: ['kong.marbleqi.top', 'www.kong.marbleqi.top'],
        Issuer: 'Encryption Everywhere DV TLS CA - G2',
        Algorithm: 'RSA',
        KeySize: 2048,
        Serial: '0f5c',
        FingerPrint: '8126',
        CertificateStatus: 'issued',
        InstanceId: 'cas-cn-45912b2nt0wd',
        CertIdentifier: '28334622-cn-hangzhou',
        ExistPrivateKey: true,
        NotBefore: 1793923200000,
        NotAfter: 1801699199000,
        CertificateChainList: ['-----BEGIN CERTIFICATE-----'],
      });

      /** 返回结果 */
      const result = await service.show(3, { CertId: 28334622 });
      expect(result.status).toBe('issued');
      expect(result.keySize).toBe(2048);
      expect(result.existPrivateKey).toBe(true);
      expect(result.sans).toEqual(['kong.marbleqi.top', 'www.kong.marbleqi.top']);
      expect(result.startAt).toBe('2026-11-06T00:00:00.000Z');
      expect(result.chain).toHaveLength(1);
    });

    it('pem 返回证书与私钥', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({ Cert: 'CERT', Key: 'KEY' });
      expect(await service.pem(3, { CertId: 1 })).toEqual({
        cert: 'CERT',
        key: 'KEY',
      });
    });

    it('pem 两者皆空时 404（阿里云对不存在的 CertId 可能是 200 空对象）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({ RequestId: 'x' });
      await expect(service.pem(3, { CertId: 1 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('import / remove', () => {
    it('上传走 POST，并带出新生证书ID', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.sslPost.mockResolvedValueOnce({ CertId: 123 });
      expect(
        await service.import(3, { Name: 'n', Cert: 'c', Key: 'k' }),
      ).toEqual({ certId: 123 });
      expect(apiSrv.sslPost).toHaveBeenCalledWith(3, 'UploadUserCertificate', {
        Name: 'n',
        Cert: 'c',
        Key: 'k',
      });
    });

    it('删除后回执带证书ID', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      expect(await service.remove(3, { CertId: 9 })).toEqual({
        deleted: true,
        certId: 9,
      });
    });
  });

  describe('orders', () => {
    it('固定 OrderType=CPACK（与证书列表共用接口但字段集不同）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({
        TotalCount: 1,
        CertificateOrderList: [ORDER_RAW],
      });

      /** 返回结果 */
      const result = await service.orders(3, { Status: 'PAYED' });
      expect(apiSrv.ssl).toHaveBeenCalledWith(3, 'ListUserCertificateOrder', {
        Status: 'PAYED',
        OrderType: 'CPACK',
      });
      expect(result.items[0]).toMatchObject({
        instanceId: 'cas-cn-45912cyfl19k',
        orderId: 1855371,
        status: 'EXPIRED',
      });
    });
  });

  describe('audit / cancel', () => {
    it('申请固定走 2018-07-13 版并 POST', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.sslPost.mockResolvedValueOnce({ RequestId: 'rid' });

      /** 申请参数 */
      const dto = {
        InstanceId: 'cas-cn-1',
        Domain: 'a.com',
        DomainVerifyType: 'DNS',
        Username: 'u',
        Mobile: '13600000000',
        Email: 'e@x.com',
        Province: 'zhejiang',
        City: 'hangzhou',
      };
      expect(await service.audit(3, dto)).toEqual({
        submitted: true,
        requestId: 'rid',
      });
      expect(apiSrv.sslPost).toHaveBeenCalledWith(
        3,
        'CreateDVOrderAudit',
        dto,
        '2018-07-13',
      );
    });

    it('取消申请走 POST 并回执订单ID', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      expect(await service.cancel(3, { OrderId: 1 })).toEqual({
        canceled: true,
        orderId: 1,
      });
      expect(apiSrv.sslPost).toHaveBeenCalledWith(
        3,
        'CancelCertificateForPackageRequest',
        { OrderId: 1 },
      );
    });
  });

  describe('state / verify', () => {
    it('待验证状态带出 DNS 记录', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({
        Type: 'domain_verify',
        RecordType: 'TXT',
        RecordDomain: '_dnsauth.a.com',
        RecordValue: 'v1',
      });

      /** 返回结果 */
      const result = await service.state(3, { OrderId: 1 });
      expect(result.type).toBe('domain_verify');
      expect(result.record).toEqual({
        type: 'TXT',
        domain: '_dnsauth.a.com',
        value: 'v1',
      });
    });

    it('已签发状态带出证书、私钥与 CertId', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({
        Type: 'certificate',
        CertId: 28334622,
        Certificate: 'CERT',
        PrivateKey: 'KEY',
      });
      expect(await service.state(3, { OrderId: 1 })).toMatchObject({
        type: 'certificate',
        certId: 28334622,
        cert: 'CERT',
        key: 'KEY',
      });
    });

    it('verify 有记录时交给 DNS 探测', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({
        Type: 'domain_verify',
        RecordType: 'TXT',
        RecordDomain: '_dnsauth.a.com',
        RecordValue: 'v1',
      });
      dnsMock.probeDns.mockResolvedValueOnce({
        status: 'matched',
        existing: ['v1'],
        ns: ['dnspod.net'],
      });

      /** 返回结果 */
      const result = await service.verify(3, { OrderId: 1, Domain: 'a.com' });
      expect(dnsMock.probeDns).toHaveBeenCalledWith(
        { type: 'TXT', domain: '_dnsauth.a.com', value: 'v1' },
        'a.com',
      );
      expect(result).toMatchObject({
        status: 'matched',
        ns: ['dnspod.net'],
        type: 'domain_verify',
      });
    });

    it('verify 在没有记录时直接回 unknown，不去查 DNS', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({ Type: 'certificate' });

      /** 返回结果 */
      const result = await service.verify(3, { OrderId: 1 });
      expect(dnsMock.probeDns).not.toHaveBeenCalled();
      expect(result.status).toBe('unknown');
      expect(result.record).toBeNull();
    });
  });

  describe('deploy', () => {
    /** 证书详情替身 */
    const DETAIL = {
      Cert: 'CERT-PEM',
      Key: 'KEY-PEM',
      Sans: 'a.com,www.a.com',
    };

    it('新建模式：把公私钥与域名交给 KONG 建证书', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv, objectSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce(DETAIL);

      expect(
        await service.deploy(3, { CertId: 1, KongId: 1, update: 0 }),
      ).toEqual({
        message: '证书部署成功',
        created: true,
        certId: 'kong-1',
      });
      expect(objectSrv.create).toHaveBeenCalledWith(1, 'certificates', {
        cert: 'CERT-PEM',
        key: 'KEY-PEM',
        snis: ['a.com', 'www.a.com'],
      });
      expect(objectSrv.update).not.toHaveBeenCalled();
    });

    it('更新模式：覆盖站点上指定的证书', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv, objectSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce(DETAIL);

      expect(
        await service.deploy(3, {
          CertId: 1,
          KongId: 1,
          update: 1,
          id: 'kong-9',
        }),
      ).toEqual({ message: '证书更新成功', updated: true, certId: 'kong-9' });
      expect(objectSrv.update).toHaveBeenCalledWith(1, 'certificates', 'kong-9', {
        cert: 'CERT-PEM',
        key: 'KEY-PEM',
        snis: ['a.com', 'www.a.com'],
      });
    });

    it('更新模式未指定证书时 400（否则会静默建出重复证书）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce(DETAIL);
      await expect(
        service.deploy(3, { CertId: 1, KongId: 1, update: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('证书缺私钥时 400（不把空证书推给 KONG）', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv, objectSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce({ Cert: 'CERT-PEM' });
      await expect(
        service.deploy(3, { CertId: 1, KongId: 1, update: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(objectSrv.create).not.toHaveBeenCalled();
    });

    it('KONG 站点不存在时 404，且不去碰对象接口', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv, kongSrv, objectSrv } = serviceOf();
      apiSrv.ssl.mockResolvedValueOnce(DETAIL);
      kongSrv.show.mockResolvedValueOnce(null);
      await expect(
        service.deploy(3, { CertId: 1, KongId: 9, update: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(objectSrv.create).not.toHaveBeenCalled();
    });

    it('证书不存在时把阿里云的说明透出去', async () => {
      /** 被测服务与替身 */
      const { service, apiSrv } = serviceOf();
      apiSrv.ssl.mockRejectedValueOnce(
        new AliyunException('NotFound', '没有找到必要内容', 400),
      );
      await expect(
        service.deploy(3, { CertId: 9, KongId: 1, update: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
