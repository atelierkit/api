// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KubernetesObjectController } from './object.controller.js';
import { KubernetesObjectService } from './object.service.js';

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
    controller: new KubernetesObjectController(
      objectSrv as unknown as KubernetesObjectService,
    ),
    objectSrv,
  };
}

describe('KubernetesObjectController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', KubernetesObjectController)).toEqual([
      'admin',
    ]);
  });

  it('清单与详情按集群、类型、命名空间、资源名转发', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    await controller.index({ kubernetesId: 1, type: 'pods', namespace: 'default' });
    expect(objectSrv.index).toHaveBeenCalledWith(1, 'pods', 'default');
    await controller.show({
      kubernetesId: 1,
      type: 'pods',
      namespace: 'default',
      id: 'web-0',
    });
    expect(objectSrv.show).toHaveBeenCalledWith(1, 'pods', 'web-0', 'default');
  });

  it('动作把 replicas / gracePeriod 平铺成参数（不透传任意 JSON）', async () => {
    /** 被测控制器与替身 */
    const { controller, objectSrv } = controllerOf();
    await controller.action({
      kubernetesId: 2,
      type: 'deployments',
      namespace: 'default',
      id: 'web',
      action: 'scale',
      replicas: 3,
    });
    expect(objectSrv.action).toHaveBeenCalledWith(
      2,
      'deployments',
      'scale',
      'web',
      { replicas: 3, gracePeriod: undefined },
      'default',
    );
  });
});
