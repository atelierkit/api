// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ApiService } from '../api/api.service.js';
import { LighthouseController } from './lighthouse.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 腾讯云接口服务替身 */
  const apiSrv = { lighthouse: vi.fn(async (..._args: unknown[]) => ({}) as unknown) };
  return {
    controller: new LighthouseController(apiSrv as unknown as ApiService),
    apiSrv,
  };
}

describe('LighthouseController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', LighthouseController)).toEqual(['admin']);
  });

  it('地域列表不带地域，其余接口都带地域转发', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();

    await controller.regions(3);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      '',
      'DescribeRegions',
      {},
    );

    await controller.bundles(3, 'ap-guangzhou');
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'DescribeBundles',
      {},
    );

    await controller.list(3, 'ap-guangzhou', { Offset: 0, Limit: 20 });
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'DescribeInstances',
      { Offset: 0, Limit: 20 },
    );
  });

  it('实例操作逐个转发（启停 / 重启 / 重置密码 / 删除 / 创建）', async () => {
    /** 被测控制器与替身 */
    const { controller, apiSrv } = controllerOf();
    /** 实例参数 */
    const one = { InstanceId: 'lhins-1' };

    await controller.start(3, 'ap-guangzhou', one);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'StartInstance',
      one,
    );

    await controller.stop(3, 'ap-guangzhou', one);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'StopInstance',
      one,
    );

    await controller.reboot(3, 'ap-guangzhou', one);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'RebootInstance',
      one,
    );

    await controller.resetPassword(3, 'ap-guangzhou', {
      ...one,
      Password: 'Passw0rd!',
    });
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'ResetInstancePassword',
      { ...one, Password: 'Passw0rd!' },
    );

    await controller.delete(3, 'ap-guangzhou', one);
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'DeleteInstance',
      one,
    );

    await controller.create(3, 'ap-guangzhou', { BundleId: 'bundle-1' });
    expect(apiSrv.lighthouse).toHaveBeenLastCalledWith(
      3,
      'ap-guangzhou',
      'CreateInstance',
      { BundleId: 'bundle-1' },
    );
  });
});
