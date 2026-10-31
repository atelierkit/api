// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ReqIndexDto, ReqService } from '@shared';
import { AdminReqController } from './req.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 请求日志服务替身 */
  const reqSrv = {
    url: vi.fn(async () => ['/admin/req/index']),
    user: vi.fn(async () => [{ value: 7, label: 'a@b.c' }]),
    controller: vi.fn(async () => ['AdminReqController']),
    action: vi.fn(async (_controller: string) => ['index']),
    index: vi.fn(async (..._args: unknown[]) => ({ data: [], total: 0 })),
    show: vi.fn(async (_reqId: number) => ({ reqId: 1 }) as unknown),
  };
  return {
    controller: new AdminReqController(reqSrv as unknown as ReqService),
    reqSrv,
  };
}

describe('AdminReqController', () => {
  it('接口前缀是 admin/req，且要求 admin 角色', () => {
    // 注：请求日志含访问路径、客户端IP与耗时，越权可读等于泄漏整站流量画像
    expect(Reflect.getMetadata('path', AdminReqController)).toBe('admin/req');
    expect(Reflect.getMetadata('role', AdminReqController)).toEqual(['admin']);
  });

  it('四个字典接口各自转发到对应服务方法', async () => {
    /** 被测控制器与替身 */
    const { controller, reqSrv } = controllerOf();
    expect(await controller.url()).toEqual(['/admin/req/index']);
    expect(await controller.user()).toEqual([{ value: 7, label: 'a@b.c' }]);
    expect(await controller.controller()).toEqual(['AdminReqController']);
    expect(await controller.action('AdminReqController')).toEqual(['index']);
    expect(reqSrv.action).toHaveBeenCalledWith('AdminReqController');
  });

  it('index 把当前请求ID一并交给服务，用于剔除自身', async () => {
    /** 被测控制器与替身 */
    const { controller, reqSrv } = controllerOf();
    /** 查询条件 */
    const value: ReqIndexDto = { pi: 1, success: false };
    expect(await controller.index(value, 123)).toEqual({ data: [], total: 0 });
    expect(reqSrv.index).toHaveBeenCalledWith(value, 123);
  });

  it('show 按请求日志ID取详情', async () => {
    /** 被测控制器与替身 */
    const { controller, reqSrv } = controllerOf();
    expect(await controller.show(5)).toEqual({ reqId: 1 });
    expect(reqSrv.show).toHaveBeenCalledWith(5);
  });
});
