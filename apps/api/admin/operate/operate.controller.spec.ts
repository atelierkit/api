// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateIndexDto, OperateService } from '@shared';
import { AdminOperateController } from './operate.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 操作日志服务替身 */
  const operateSrv = {
    index: vi.fn(async (_value: OperateIndexDto) => ({ data: [], total: 0 })),
    options: vi.fn(async () => ({ users: [], names: [], operates: [] })),
    show: vi.fn(async (_id: number) => ({ id: 1 }) as unknown),
  };
  return {
    controller: new AdminOperateController(
      operateSrv as unknown as OperateService,
    ),
    operateSrv,
  };
}

describe('AdminOperateController', () => {
  it('接口前缀是 admin/operate，且要求 admin 角色', () => {
    // 注：操作日志含全部用户的邮箱与操作轨迹，越权可读等于泄漏整站审计记录
    expect(Reflect.getMetadata('path', AdminOperateController)).toBe(
      'admin/operate',
    );
    expect(Reflect.getMetadata('role', AdminOperateController)).toEqual([
      'admin',
    ]);
  });

  it('index 原样转发查询条件', async () => {
    /** 被测控制器与替身 */
    const { controller, operateSrv } = controllerOf();
    /** 查询条件 */
    const value: OperateIndexDto = { pi: 2, ps: 50, name: 'setting' };
    expect(await controller.index(value)).toEqual({ data: [], total: 0 });
    expect(operateSrv.index).toHaveBeenCalledWith(value);
  });

  it('options 转发字典查询', async () => {
    /** 被测控制器与替身 */
    const { controller, operateSrv } = controllerOf();
    expect(await controller.options()).toEqual({
      users: [],
      names: [],
      operates: [],
    });
    expect(operateSrv.options).toHaveBeenCalledTimes(1);
  });

  it('show 按操作序号取详情', async () => {
    /** 被测控制器与替身 */
    const { controller, operateSrv } = controllerOf();
    expect(await controller.show(9)).toEqual({ id: 1 });
    expect(operateSrv.show).toHaveBeenCalledWith(9);
  });
});
