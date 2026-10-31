// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { KongCreateDto } from './kong.dto.js';
import { KongController } from './kong.controller.js';
import { KongService } from './kong.service.js';

/** 合法的建站点入参 */
const KONG: KongCreateDto = {
  name: '本地网关',
  description: '家用服务器的 Kong',
  url: 'http://192.168.1.10:8001',
  status: true,
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 站点服务替身 */
  const kongSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 1),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 5),
    update: vi.fn(async (..._args: unknown[]) => 1),
    report: vi.fn(async (_id: number) => ({ version: '3.6.1' })),
    plugin: vi.fn(async (_id: number) => ({ enabled_plugins: [] })),
  };
  return {
    controller: new KongController(kongSrv as unknown as KongService),
    kongSrv,
  };
}

describe('KongController', () => {
  it('整个控制器由 admin 角色独占（站点地址等同网关管理权限）', () => {
    expect(Reflect.getMetadata('role', KongController)).toEqual(['admin']);
  });

  it('站点增删改查转发给站点服务', async () => {
    /** 被测控制器与替身 */
    const { controller, kongSrv } = controllerOf();
    await controller.index(3);
    expect(kongSrv.index).toHaveBeenCalledWith(3);
    await expect(controller.show(1)).rejects.toBeInstanceOf(NotFoundException);
    expect(await controller.create(KONG, 7, 9)).toBe(5);
    expect(kongSrv.create).toHaveBeenCalledWith(KONG, 7, 9);
    expect(await controller.update(5, { status: false }, 7, 9)).toBe(1);
    expect(kongSrv.update).toHaveBeenCalledWith(5, { status: false }, 7, 9);
  });

  it('探测接口按站点ID转发（报告 / 插件）', async () => {
    /** 被测控制器与替身 */
    const { controller, kongSrv } = controllerOf();
    expect(await controller.report(2)).toEqual({ version: '3.6.1' });
    expect(kongSrv.report).toHaveBeenCalledWith(2);
    expect(await controller.plugin(2)).toEqual({ enabled_plugins: [] });
    expect(kongSrv.plugin).toHaveBeenCalledWith(2);
  });
});
