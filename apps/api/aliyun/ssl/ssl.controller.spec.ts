// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SslService } from './ssl.service.js';
import { SslController } from './ssl.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与服务替身
 */
function controllerOf() {
  /** 证书服务替身 */
  const sslSrv = {
    list: vi.fn(async (..._args: unknown[]) => ({ total: 0, items: [] })),
    show: vi.fn(async (..._args: unknown[]) => ({})),
    pem: vi.fn(async (..._args: unknown[]) => ({})),
    import: vi.fn(async (..._args: unknown[]) => ({})),
    remove: vi.fn(async (..._args: unknown[]) => ({})),
    orders: vi.fn(async (..._args: unknown[]) => ({ total: 0, items: [] })),
    audit: vi.fn(async (..._args: unknown[]) => ({})),
    cancel: vi.fn(async (..._args: unknown[]) => ({})),
    state: vi.fn(async (..._args: unknown[]) => ({})),
    verify: vi.fn(async (..._args: unknown[]) => ({})),
    deploy: vi.fn(async (..._args: unknown[]) => ({})),
  };
  return {
    controller: new SslController(sslSrv as unknown as SslService),
    sslSrv,
  };
}

describe('SslController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', SslController)).toEqual(['admin']);
  });

  it('控制器前缀为 aliyun/ssl', () => {
    expect(Reflect.getMetadata('path', SslController)).toBe('aliyun/ssl');
  });

  it('每个路由都把密钥ID与请求体原样转交给服务', async () => {
    /** 被测控制器与替身 */
    const { controller, sslSrv } = controllerOf();

    await controller.list(3, { CurrentPage: 1 });
    expect(sslSrv.list).toHaveBeenCalledWith(3, { CurrentPage: 1 });

    await controller.show(3, { CertId: 1 });
    expect(sslSrv.show).toHaveBeenCalledWith(3, { CertId: 1 });

    await controller.pem(3, { CertId: 1 });
    expect(sslSrv.pem).toHaveBeenCalledWith(3, { CertId: 1 });

    await controller.import(3, { Name: 'n', Cert: 'c', Key: 'k' });
    expect(sslSrv.import).toHaveBeenCalledWith(3, {
      Name: 'n',
      Cert: 'c',
      Key: 'k',
    });

    await controller.remove(3, { CertId: 1 });
    expect(sslSrv.remove).toHaveBeenCalledWith(3, { CertId: 1 });

    await controller.orders(3, { Status: 'PAYED' });
    expect(sslSrv.orders).toHaveBeenCalledWith(3, { Status: 'PAYED' });

    await controller.audit(3, {
      InstanceId: 'cas-cn-1',
      Domain: 'a.com',
      DomainVerifyType: 'DNS',
      Username: 'u',
      Mobile: '13600000000',
      Email: 'e@x.com',
      Province: 'zhejiang',
      City: 'hangzhou',
    });
    expect(sslSrv.audit).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ InstanceId: 'cas-cn-1', Domain: 'a.com' }),
    );

    await controller.cancel(3, { OrderId: 1 });
    expect(sslSrv.cancel).toHaveBeenCalledWith(3, { OrderId: 1 });

    await controller.state(3, { OrderId: 1 });
    expect(sslSrv.state).toHaveBeenCalledWith(3, { OrderId: 1 });

    await controller.verify(3, { OrderId: 1, Domain: 'a.com' });
    expect(sslSrv.verify).toHaveBeenCalledWith(3, {
      OrderId: 1,
      Domain: 'a.com',
    });

    await controller.deploy(3, { CertId: 1, KongId: 1, update: 0 });
    expect(sslSrv.deploy).toHaveBeenCalledWith(3, {
      CertId: 1,
      KongId: 1,
      update: 0,
    });
  });
});
