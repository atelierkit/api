// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import {
  KongObjectCreateDto,
  KongObjectIndexDto,
  KongObjectShowDto,
  KongObjectUpdateDto,
} from './object.dto.js';
import { KongObjectController } from './object.controller.js';
import { ObjectService } from './object.service.js';

/** 合法的对象 ID */
const ID = '3f1b9c2e-0a41-4f6d-9f8e-1a2b3c4d5e6f';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 对象服务替身 */
  const objectSrv = {
    index: vi.fn(async (_kongId: number, _type: unknown) => [] as unknown[]),
    show: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
    create: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
    update: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
    destroy: vi.fn(async (..._args: unknown[]) => undefined),
  };
  return {
    controller: new KongObjectController(objectSrv as unknown as ObjectService),
    objectSrv,
  };
}

describe('KongObjectController', () => {
  it('整个控制器由 admin 角色独占（对象接口等同网关写权限）', () => {
    expect(Reflect.getMetadata('role', KongObjectController)).toEqual([
      'admin',
    ]);
  });

  it('挂在 cloud/kong/object 下（与站点控制器同属云服务前缀）', () => {
    expect(Reflect.getMetadata('path', KongObjectController)).toBe(
      'cloud/kong/object',
    );
  });

  it('入参类型必须是真的类引用（写成 import type 会丢掉设计期元数据，校验静默失效）', () => {
    // 注：`@Body()` 的校验靠 design:paramtypes 反射出 DTO 类；用 `import type` 引进来
    // TS 会把元数据降级成 Object，ValidationPipe 便不再校验，且不报任何错
    expect(
      Reflect.getMetadata('design:paramtypes', KongObjectController),
    ).toEqual([ObjectService]);
    expect(
      Reflect.getMetadata('design:paramtypes', KongObjectController.prototype, 'index'),
    ).toEqual([KongObjectIndexDto]);
    expect(
      Reflect.getMetadata('design:paramtypes', KongObjectController.prototype, 'show'),
    ).toEqual([KongObjectShowDto]);
    expect(
      Reflect.getMetadata('design:paramtypes', KongObjectController.prototype, 'create'),
    ).toEqual([KongObjectCreateDto]);
    expect(
      Reflect.getMetadata('design:paramtypes', KongObjectController.prototype, 'update'),
    ).toEqual([KongObjectUpdateDto]);
    expect(
      Reflect.getMetadata('design:paramtypes', KongObjectController.prototype, 'destroy'),
    ).toEqual([KongObjectShowDto]);
  });

  it('清单与详情按站点ID、类型、对象ID 转发给对象服务', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    await controller.index({ kongId: 3, type: 'routes' });
    expect(objectSrv.index).toHaveBeenCalledWith(3, 'routes');
    await controller.show({ kongId: 3, type: 'routes', id: ID });
    expect(objectSrv.show).toHaveBeenCalledWith(3, 'routes', ID);
  });

  it('创建与更新把对象数据整份交给对象服务', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    /** 对象数据 */
    const value = { name: '路由一', paths: ['/a'] };
    await controller.create({ kongId: 3, type: 'routes', value });
    expect(objectSrv.create).toHaveBeenCalledWith(3, 'routes', value);
    await controller.update({ kongId: 3, type: 'routes', id: ID, value });
    expect(objectSrv.update).toHaveBeenCalledWith(3, 'routes', ID, value);
  });

  it('删除走详情同一份入参', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    await controller.destroy({ kongId: 3, type: 'routes', id: ID });
    expect(objectSrv.destroy).toHaveBeenCalledWith(3, 'routes', ID);
  });
});
