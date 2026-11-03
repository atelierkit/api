// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { DockerObjectController } from './object.controller.js';
import { DockerObjectService } from './object.service.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 资源服务替身 */
  const objectSrv = {
    index: vi.fn(async (..._args: unknown[]) => []),
    show: vi.fn(async (..._args: unknown[]) => ({})),
    action: vi.fn(async (..._args: unknown[]) => undefined),
  };
  return {
    controller: new DockerObjectController(
      objectSrv as unknown as DockerObjectService,
    ),
    objectSrv,
  };
}

describe('DockerObjectController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', DockerObjectController)).toEqual([
      'admin',
    ]);
  });

  it('清单与详情按宿主机、类型、ID 转发', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    await controller.index({ dockerId: 1, type: 'containers' });
    expect(objectSrv.index).toHaveBeenCalledWith(1, 'containers');
    await controller.show({ dockerId: 1, type: 'images', id: 'abc' });
    expect(objectSrv.show).toHaveBeenCalledWith(1, 'images', 'abc');
  });

  it('动作把 force / timeout 平铺成参数（不透传任意 JSON）', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    await controller.action({
      dockerId: 2,
      type: 'containers',
      id: 'abc',
      action: 'remove',
      force: true,
    });
    expect(objectSrv.action).toHaveBeenCalledWith(2, 'containers', 'remove', 'abc', {
      force: true,
      timeout: undefined,
    });
  });
});
