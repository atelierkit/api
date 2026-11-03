// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { DockerController } from './docker.controller.js';
import type { DockerCreateDto } from './docker.dto.js';
import { DockerService } from './docker.service.js';

/** 合法的建站入参 */
const DOCKER: DockerCreateDto = {
  name: '家用宿主机',
  description: '局域网内的 Docker',
  endpoint: 'tcp://192.0.2.10:2376',
  tls: true,
  ca: 'CA',
  cert: 'CERT',
  key: 'KEY',
  verify: true,
  status: true,
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 宿主机服务替身 */
  const dockerSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 1),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 5),
    update: vi.fn(async (..._args: unknown[]) => 1),
    summary: vi.fn(async (_id: number) => ({ version: '27.3.1' })),
    diagnose: vi.fn(async (_id: number) => ({ latencyMs: 3 })),
  };
  return {
    controller: new DockerController(
      dockerSrv as unknown as DockerService,
    ),
    dockerSrv,
  };
}

describe('DockerController', () => {
  it('整个控制器由 admin 角色独占（daemon 地址等同宿主机 root）', () => {
    expect(Reflect.getMetadata('role', DockerController)).toEqual(['admin']);
  });

  it('宿主机增删改查转发给服务', async () => {
    /** 被测控制器与替身 */
    const { controller, dockerSrv } = controllerOf();
    await controller.index(3);
    expect(dockerSrv.index).toHaveBeenCalledWith(3);
    expect(await controller.create(DOCKER, 7, 9)).toBe(5);
    expect(dockerSrv.create).toHaveBeenCalledWith(DOCKER, 7, 9);
    expect(await controller.update(5, { status: false }, 7, 9)).toBe(1);
    expect(dockerSrv.update).toHaveBeenCalledWith(5, { status: false }, 7, 9);
  });

  it('探测接口按宿主机ID转发（概览 / 诊断）', async () => {
    /** 被测控制器与替身 */
    const { controller, dockerSrv } = controllerOf();
    expect(await controller.summary(2)).toEqual({ version: '27.3.1' });
    expect(dockerSrv.summary).toHaveBeenCalledWith(2);
    expect(await controller.diagnose(2)).toEqual({ latencyMs: 3 });
    expect(dockerSrv.diagnose).toHaveBeenCalledWith(2);
  });
});
