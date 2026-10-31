// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ApiService } from '../api/api.service.js';
import { DomainController } from './domain.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 腾讯云接口服务替身 */
  const apiSrv = { dnspod: vi.fn(async (..._args: unknown[]) => ({}) as unknown) };
  return {
    controller: new DomainController(apiSrv as unknown as ApiService),
    apiSrv,
  };
}

describe('DomainController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', DomainController)).toEqual(['admin']);
  });

  it('列表 / 备注 / 详情都转发给 DNSPod 域名接口', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();

    await controller.list(3, { Offset: 0, Limit: 10 });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'DescribeDomainList', {
      Offset: 0,
      Limit: 10,
    });

    // 空串备注是「删除备注」，必须原样透传
    await controller.remark(3, { Domain: 'example.com', Remark: '' });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'ModifyDomainRemark', {
      Domain: 'example.com',
      Remark: '',
    });

    await controller.detail(3, { Domain: 'example.com' });
    expect(apiSrv.dnspod).toHaveBeenLastCalledWith(3, 'DescribeDomain', {
      Domain: 'example.com',
    });
  });
});
