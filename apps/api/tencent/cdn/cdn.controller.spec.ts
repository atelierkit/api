// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ApiService } from '../api/api.service.js';
import { CdnController } from './cdn.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 腾讯云接口服务替身 */
  const apiSrv = { cdn: vi.fn(async (..._args: unknown[]) => ({}) as unknown) };
  return {
    controller: new CdnController(apiSrv as unknown as ApiService),
    apiSrv,
  };
}

describe('CdnController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', CdnController)).toEqual(['admin']);
  });

  it('详情把单个域名包成 Domains 数组（腾讯云要的是数组）', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();
    await controller.detail(3, { Domain: 'cdn.example.com' });
    expect(apiSrv.cdn).toHaveBeenLastCalledWith(3, 'DescribeDomainsConfig', {
      Domains: ['cdn.example.com'],
    });
  });

  it('列表 / 备注 / 启停 / 删除都转发给 CDN 接口', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();

    await controller.list(3, { Offset: 0, Limit: 10 });
    expect(apiSrv.cdn).toHaveBeenLastCalledWith(3, 'DescribeDomains', {
      Offset: 0,
      Limit: 10,
    });

    await controller.remark(3, { Domain: 'cdn.example.com', Remark: '' });
    expect(apiSrv.cdn).toHaveBeenLastCalledWith(3, 'ModifyDomainConfig', {
      Domain: 'cdn.example.com',
      Remark: '',
    });

    await controller.enable(3, { Domain: 'cdn.example.com' });
    expect(apiSrv.cdn).toHaveBeenLastCalledWith(3, 'StartCdnDomain', {
      Domain: 'cdn.example.com',
    });

    await controller.disable(3, { Domain: 'cdn.example.com' });
    expect(apiSrv.cdn).toHaveBeenLastCalledWith(3, 'StopCdnDomain', {
      Domain: 'cdn.example.com',
    });

    await controller.delete(3, { Domain: 'cdn.example.com' });
    expect(apiSrv.cdn).toHaveBeenLastCalledWith(3, 'DeleteCdnDomain', {
      Domain: 'cdn.example.com',
    });
  });
});
