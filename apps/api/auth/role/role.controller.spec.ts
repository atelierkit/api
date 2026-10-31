// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RoleService } from '../../shared/role/role.service.js';
import { RoleController } from './role.controller.js';
import { RoleUpdateDto } from './role.dto.js';

/** 合法的角色修改入参 */
const ROLE: RoleUpdateDto = {
  id: 'admin',
  name: '管理员',
  description: '超级管理员',
  status: true,
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 角色服务替身 */
  const roleSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    show: vi.fn(async (_key: string) => null as unknown),
    log: vi.fn(async (_key: string) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 'ops'),
    update: vi.fn(async (..._args: unknown[]) => 'ops'),
    sort: vi.fn(async (..._args: unknown[]) => ({ length: 2 })),
  };
  return {
    controller: new RoleController(roleSrv as unknown as RoleService),
    roleSrv,
  };
}

describe('RoleController', () => {
  it('整个控制器由 admin 角色独占（鉴权由全局 TokenGuard 依据该元数据判定）', () => {
    expect(Reflect.getMetadata('role', RoleController)).toEqual(['admin']);
  });

  it('增删改查全部转发给角色服务（基类路由）', async () => {
    /** 被测控制器与替身 */
    const { controller, roleSrv } = controllerOf();
    await controller.index(0);
    expect(roleSrv.index).toHaveBeenCalledWith(0);
    await controller.log('admin');
    expect(roleSrv.log).toHaveBeenCalledWith('admin');
    await controller.create(ROLE, 1, 2);
    expect(roleSrv.create).toHaveBeenCalledWith(ROLE, 1, 2);
    await controller.update('admin', ROLE, 1, 2);
    expect(roleSrv.update).toHaveBeenCalledWith('admin', ROLE, 1, 2);
  });

  it('详情不存在时抛 404，存在时原样返回', async () => {
    /** 被测控制器与替身 */
    const { controller, roleSrv } = controllerOf();
    await expect(controller.show('admin')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    roleSrv.show.mockResolvedValue({ id: 'admin', name: '管理员' });
    expect(await controller.show('admin')).toEqual({
      id: 'admin',
      name: '管理员',
    });
  });

  it('排序接口按提交顺序写库并带上操作人', async () => {
    /** 被测控制器与替身 */
    const { controller, roleSrv } = controllerOf();
    /** 排序入参 */
    const values = [
      { id: 'admin', sort: 1 },
      { id: 'dev', sort: 2 },
    ];
    expect(await controller.sort(values, 7, 9)).toEqual({ length: 2 });
    expect(roleSrv.sort).toHaveBeenCalledWith(values, 7, 9);
  });
});
