// 外部依赖
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KongService } from '../../cloud/kong/kong.service.js';
import { ObjectService } from '../../cloud/kong/object/object.service.js';
import { ApiService } from '../api/api.service.js';
import type { SslDeployDto } from './ssl.dto.js';
import { SslController } from './ssl.controller.js';

/** 证书详情（腾讯云返回的形状） */
const CERT = {
  RequestId: 'rid',
  CertificateId: 'cert-1',
  CertificatePublicKey: '-----BEGIN CERTIFICATE-----',
  CertificatePrivateKey: '-----BEGIN PRIVATE KEY-----',
};

/**
 * 构造部署入参
 *
 * 注：用工厂 + 覆盖项而不是展开类实例 —— 展开 DTO 实例会丢原型，`no-misused-spread` 会告警
 *
 * @param patch 覆盖项
 * @returns 部署入参
 */
function deployOf(patch: Partial<SslDeployDto> = {}): SslDeployDto {
  return {
    CertificateId: 'cert-1',
    domain: ['example.com'],
    KongId: 1,
    update: 0,
    ...patch,
  };
}

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 腾讯云接口服务替身 */
  const apiSrv = {
    ssl: vi.fn(async (..._args: unknown[]) => CERT as unknown),
  };
  /** KONG 站点服务替身 */
  const kongSrv = {
    show: vi.fn(async (_id: number) => ({ id: 1, url: 'http://k:8001' }) as unknown),
  };
  /** KONG 对象服务替身 */
  const objectSrv = {
    create: vi.fn(async (..._args: unknown[]) => ({ id: 'kong-cert-1' }) as unknown),
    update: vi.fn(async (..._args: unknown[]) => ({ id: 'kong-cert-1' }) as unknown),
  };
  return {
    controller: new SslController(
      apiSrv as unknown as ApiService,
      kongSrv as unknown as KongService,
      objectSrv as unknown as ObjectService,
    ),
    apiSrv,
    kongSrv,
    objectSrv,
  };
}

describe('SslController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', SslController)).toEqual(['admin']);
  });

  it('证书的增删改查都按接口名转发给腾讯云', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();
    await controller.list(3, { Offset: 0, Limit: 10 });
    expect(apiSrv.ssl).toHaveBeenLastCalledWith(3, 'DescribeCertificates', {
      Offset: 0,
      Limit: 10,
    });
    await controller.detail(3, { CertificateId: 'cert-1' });
    expect(apiSrv.ssl).toHaveBeenLastCalledWith(
      3,
      'DescribeCertificateDetail',
      { CertificateId: 'cert-1' },
    );
    await controller.apply(3, { DomainName: 'example.com', DvAuthMethod: 'DNS_AUTO' });
    expect(apiSrv.ssl).toHaveBeenLastCalledWith(3, 'ApplyCertificate', {
      DomainName: 'example.com',
      DvAuthMethod: 'DNS_AUTO',
    });
    await controller.alias(3, { CertificateId: 'cert-1', Alias: '' });
    expect(apiSrv.ssl).toHaveBeenLastCalledWith(3, 'ModifyCertificateAlias', {
      CertificateId: 'cert-1',
      Alias: '',
    });
    await controller.revoke(3, { CertificateId: 'cert-1' });
    expect(apiSrv.ssl).toHaveBeenLastCalledWith(3, 'RevokeCertificate', {
      CertificateId: 'cert-1',
    });
    await controller.delete(3, { CertificateId: 'cert-1' });
    expect(apiSrv.ssl).toHaveBeenLastCalledWith(3, 'DeleteCertificate', {
      CertificateId: 'cert-1',
    });
  });

  describe('deploy', () => {
    it('新建模式：把公私钥与域名交给 KONG 建证书', async () => {
      /** 被测控制器与替身 */
      const { controller, objectSrv } = controllerOf();
      expect(await controller.deploy(3, deployOf())).toEqual({
        message: '证书部署成功',
        created: true,
        certId: 'kong-cert-1',
      });
      expect(objectSrv.create).toHaveBeenCalledWith(1, 'certificates', {
        cert: CERT.CertificatePublicKey,
        key: CERT.CertificatePrivateKey,
        snis: ['example.com'],
      });
      expect(objectSrv.update).not.toHaveBeenCalled();
    });

    it('更新模式：覆盖站点上指定的证书', async () => {
      /** 被测控制器与替身 */
      const { controller, objectSrv } = controllerOf();
      expect(
        await controller.deploy(3, deployOf({ update: 1, id: 'kong-cert-9' })),
      ).toEqual({ message: '证书更新成功', updated: true, certId: 'kong-cert-9' });
      expect(objectSrv.update).toHaveBeenCalledWith(1, 'certificates', 'kong-cert-9', {
        cert: CERT.CertificatePublicKey,
        key: CERT.CertificatePrivateKey,
        snis: ['example.com'],
      });
      expect(objectSrv.create).not.toHaveBeenCalled();
    });

    it('更新模式未指定证书时 400（否则会静默把新证书建出来）', async () => {
      /** 被测控制器 */
      const { controller } = controllerOf();
      await expect(
        controller.deploy(3, deployOf({ update: 1 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('证书取不到时把腾讯云的原始错误说明透出去', async () => {
      /** 被测控制器与替身 */
      const { controller, apiSrv } = controllerOf();
      apiSrv.ssl.mockResolvedValueOnce({
        Error: { Code: 'InvalidParameter', Message: '证书不存在' },
      });
      await expect(controller.deploy(3, deployOf())).rejects.toThrow('证书不存在');
    });

    it('证书详情缺公私钥时 400', async () => {
      /** 被测控制器与替身 */
      const { controller, apiSrv } = controllerOf();
      apiSrv.ssl.mockResolvedValueOnce({ CertificateId: 'cert-1' });
      await expect(controller.deploy(3, deployOf())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('KONG 站点不存在时 404，且不去碰对象接口', async () => {
      /** 被测控制器与替身 */
      const { controller, kongSrv, objectSrv } = controllerOf();
      kongSrv.show.mockResolvedValueOnce(null);
      await expect(controller.deploy(3, deployOf())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(objectSrv.create).not.toHaveBeenCalled();
    });
  });
});
