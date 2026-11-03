// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KubernetesController } from './kubernetes.controller.js';
import type { KubernetesCreateDto } from './kubernetes.dto.js';
import { KubernetesService } from './kubernetes.service.js';

/** 合法的建集群入参 */
const CLUSTER: KubernetesCreateDto = {
  name: '家用集群',
  description: '局域网内的 k3s',
  endpoint: 'https://192.0.2.10:6443',
  token: 'TOKEN',
  verify: true,
  status: true,
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 集群服务替身 */
  const kubernetesSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 1),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 5),
    update: vi.fn(async (..._args: unknown[]) => 1),
    summary: vi.fn(async (_id: number) => ({ version: 'v1.30.4' })),
    diagnose: vi.fn(async (_id: number) => ({ latencyMs: 3 })),
  };
  return {
    controller: new KubernetesController(
      kubernetesSrv as unknown as KubernetesService,
    ),
    kubernetesSrv,
  };
}

describe('KubernetesController', () => {
  it('整个控制器由 admin 角色独占（凭据等同集群权限）', () => {
    expect(Reflect.getMetadata('role', KubernetesController)).toEqual([
      'admin',
    ]);
  });

  it('集群增删改查转发给服务', async () => {
    /** 被测控制器与替身 */
    const { controller, kubernetesSrv } = controllerOf();
    await controller.index(3);
    expect(kubernetesSrv.index).toHaveBeenCalledWith(3);
    expect(await controller.create(CLUSTER, 7, 9)).toBe(5);
    expect(kubernetesSrv.create).toHaveBeenCalledWith(CLUSTER, 7, 9);
    expect(await controller.update(5, { status: false }, 7, 9)).toBe(1);
    expect(kubernetesSrv.update).toHaveBeenCalledWith(
      5,
      { status: false },
      7,
      9,
    );
  });

  it('探测接口按集群ID转发（概览 / 诊断）', async () => {
    /** 被测控制器与替身 */
    const { controller, kubernetesSrv } = controllerOf();
    expect(await controller.summary(2)).toEqual({ version: 'v1.30.4' });
    expect(kubernetesSrv.summary).toHaveBeenCalledWith(2);
    expect(await controller.diagnose(2)).toEqual({ latencyMs: 3 });
    expect(kubernetesSrv.diagnose).toHaveBeenCalledWith(2);
  });
});
