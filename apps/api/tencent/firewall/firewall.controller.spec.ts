// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ApiService } from '../api/api.service.js';
import { FirewallController } from './firewall.controller.js';

/** 一条防火墙规则 */
const RULE = { Protocol: 'TCP', Port: '22', CidrBlock: '0.0.0.0/0', Action: 'ACCEPT' };

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 腾讯云接口服务替身 */
  const apiSrv = { lighthouse: vi.fn(async (..._args: unknown[]) => ({}) as unknown) };
  return {
    controller: new FirewallController(apiSrv as unknown as ApiService),
    apiSrv,
  };
}

describe('FirewallController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', FirewallController)).toEqual(['admin']);
  });

  it('四个接口都带上地域，并转发到轻量服务器的防火墙接口', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();
    /** 规则参数 */
    const params = { InstanceId: 'lhins-1', FirewallRules: [RULE] };

    await controller.list(3, 'ap-guangzhou', {
      InstanceId: 'lhins-1',
      Offset: 0,
      Limit: 20,
    });
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'DescribeFirewallRules',
      { InstanceId: 'lhins-1', Offset: 0, Limit: 20 },
    );

    await controller.create(3, 'ap-guangzhou', params);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'CreateFirewallRules',
      params,
    );

    await controller.delete(3, 'ap-guangzhou', params);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'DeleteFirewallRules',
      params,
    );

    await controller.modify(3, 'ap-guangzhou', params);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'ModifyFirewallRules',
      params,
    );
  });
});
