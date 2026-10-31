// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { UserManageCreateDto } from '../../shared/user/user.dto.js';
import { UserService } from '../../shared/user/user.service.js';
import { AuthUserController } from './user.controller.js';

/** 合法的建号入参 */
const USER: UserManageCreateDto = {
  username: 'dev_01',
  password: 'abc12345',
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 用户服务替身 */
  const userSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 1),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 5),
    update: vi.fn(async (..._args: unknown[]) => 1),
  };
  return {
    controller: new AuthUserController(userSrv as unknown as UserService),
    userSrv,
  };
}

describe('AuthUserController', () => {
  it('整个控制器由 admin 角色独占（建号与改权限不能交给普通用户）', () => {
    expect(Reflect.getMetadata('role', AuthUserController)).toEqual(['admin']);
  });

  it('清单 / 数量 / 日志直接转发给用户服务', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    await controller.index(3);
    expect(userSrv.index).toHaveBeenCalledWith(3);
    expect(await controller.count()).toBe(1);
    await controller.log(1);
    expect(userSrv.log).toHaveBeenCalledWith(1);
  });

  it('详情不存在时抛 404，存在时原样返回', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    await expect(controller.show(1)).rejects.toBeInstanceOf(NotFoundException);
    userSrv.show.mockResolvedValue({ id: 1, username: 'dev_01' });
    expect(await controller.show(1)).toEqual({ id: 1, username: 'dev_01' });
  });

  it('建号与改资料带上操作人和请求ID后转发（供操作日志溯源）', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    expect(await controller.create(USER, 7, 9)).toBe(5);
    expect(userSrv.create).toHaveBeenCalledWith(USER, 7, 9);
    expect(await controller.update(5, { status: false }, 7, 9)).toBe(1);
    expect(userSrv.update).toHaveBeenCalledWith(5, { status: false }, 7, 9);
  });
});
