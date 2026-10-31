// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { KeyCreateDto } from './key.dto.js';
import { KeyController } from './key.controller.js';
import { KeyService } from './key.service.js';

/** 合法的建密钥入参 */
const KEY: KeyCreateDto = {
  name: '腾讯云主账号',
  description: '部署 CDN 用',
  provider: 'tencent',
  key: 'AKIDEXAMPLE',
  secret: 'SECRETEXAMPLE',
  status: true,
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 密钥服务替身 */
  const keySrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 1),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 5),
    update: vi.fn(async (..._args: unknown[]) => 1),
  };
  return {
    controller: new KeyController(keySrv as unknown as KeyService),
    keySrv,
  };
}

describe('KeyController', () => {
  it('整个控制器由 admin 角色独占（密钥等同云账号凭据）', () => {
    expect(Reflect.getMetadata('role', KeyController)).toEqual(['admin']);
  });

  it('清单 / 数量 / 日志 / 详情全部转发给密钥服务', async () => {
    /** 被测控制器与替身 */
    const { controller, keySrv } = controllerOf();
    await controller.index(3);
    expect(keySrv.index).toHaveBeenCalledWith(3);
    expect(await controller.count()).toBe(1);
    await controller.log(1);
    expect(keySrv.log).toHaveBeenCalledWith(1);
    await expect(controller.show(1)).rejects.toBeInstanceOf(NotFoundException);
    keySrv.show.mockResolvedValue({ id: 1, name: '腾讯云主账号' });
    expect(await controller.show(1)).toEqual({ id: 1, name: '腾讯云主账号' });
  });

  it('创建与更新带上操作人和请求ID后转发（供操作日志溯源）', async () => {
    /** 被测控制器与替身 */
    const { controller, keySrv } = controllerOf();
    expect(await controller.create(KEY, 7, 9)).toBe(5);
    expect(keySrv.create).toHaveBeenCalledWith(KEY, 7, 9);
    expect(await controller.update(5, { status: false }, 7, 9)).toBe(1);
    expect(keySrv.update).toHaveBeenCalledWith(5, { status: false }, 7, 9);
  });
});
