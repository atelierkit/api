// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RemoteController } from './remote.controller.js';
import type { RemoteCreateDto } from './remote.dto.js';
import type { RemoteService } from './remote.service.js';
import type { RemoteSessionService } from './remote.session.js';

/** 合法的创建入参 */
const REMOTE: RemoteCreateDto = {
  name: '工控机',
  description: '局域网内的 Ubuntu',
  host: '192.168.1.3',
  port: 22,
  authType: 'password',
  username: 'atelier',
  password: 'p@ssw0rd',
  status: true,
};

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 主机服务替身 */
  const remoteSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 1),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 5),
    update: vi.fn(async (..._args: unknown[]) => 1),
    summary: vi.fn(async (_id: number) => ({ osName: 'Ubuntu' })),
    diagnose: vi.fn(async (_id: number) => ({ ok: true })),
    inspectKey: vi.fn((_content: string, _passphrase: string) => ({
      format: 'openssh',
      converted: false,
      encrypted: false,
      fingerprint: 'SHA256:abc',
    })),
    rememberFingerprint: vi.fn(async (..._args: unknown[]) => 1),
  };
  /** 会话服务替身 */
  const sessionSrv = {
    issue: vi.fn((_userId: number, _remoteId: number, _size: unknown) => ({
      ticket: 'ticket',
      expiresAt: 1,
    })),
  };
  return {
    controller: new RemoteController(
      remoteSrv as unknown as RemoteService,
      sessionSrv as unknown as RemoteSessionService,
    ),
    remoteSrv,
    sessionSrv,
  };
}

describe('RemoteController', () => {
  it('整个控制器由 admin 角色独占（主机凭据等同目标机 shell）', () => {
    expect(Reflect.getMetadata('role', RemoteController)).toEqual(['admin']);
  });

  it('主机增删改查转发给服务', async () => {
    /** 被测控制器与替身 */
    const { controller, remoteSrv } = controllerOf();
    await controller.index(3);
    expect(remoteSrv.index).toHaveBeenCalledWith(3);
    expect(await controller.create(REMOTE, 7, 9)).toBe(5);
    expect(remoteSrv.create).toHaveBeenCalledWith(REMOTE, 7, 9);
    expect(await controller.update(5, { status: false }, 7, 9)).toBe(1);
    expect(remoteSrv.update).toHaveBeenCalledWith(5, { status: false }, 7, 9);
  });

  it('探测接口按主机ID转发（概览 / 诊断）', async () => {
    /** 被测控制器与替身 */
    const { controller, remoteSrv } = controllerOf();
    expect(await controller.summary(2)).toEqual({ osName: 'Ubuntu' });
    expect(remoteSrv.summary).toHaveBeenCalledWith(2);
    expect(await controller.diagnose(2)).toEqual({ ok: true });
    expect(remoteSrv.diagnose).toHaveBeenCalledWith(2);
  });

  it('票据按「用户 + 主机 + 尺寸」签发（WS 侧只认这张票）', () => {
    /** 被测控制器与替身 */
    const { controller, sessionSrv } = controllerOf();
    expect(controller.ticket({ id: 3, cols: 120, rows: 40 }, 7)).toEqual({
      ticket: 'ticket',
      expiresAt: 1,
    });
    expect(sessionSrv.issue).toHaveBeenCalledWith(7, 3, { cols: 120, rows: 40 });
  });

  it('私钥预检转发给服务，口令缺省按空串（前端选完文件就调，不等到保存）', () => {
    /** 被测控制器与替身 */
    const { controller, remoteSrv } = controllerOf();
    expect(controller.inspectKey({ content: 'KEY' })).toMatchObject({
      format: 'openssh',
    });
    expect(remoteSrv.inspectKey).toHaveBeenCalledWith('KEY', '');
    controller.inspectKey({ content: 'KEY', passphrase: 'p' });
    expect(remoteSrv.inspectKey).toHaveBeenLastCalledWith('KEY', 'p');
  });

  it('信任新指纹走 rememberFingerprint（会进变更历史）', async () => {
    /** 被测控制器与替身 */
    const { controller, remoteSrv } = controllerOf();
    /** 指纹 */
    const fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(await controller.trust({ id: 3, fingerprint }, 7, 9)).toBe(1);
    expect(remoteSrv.rememberFingerprint).toHaveBeenCalledWith(
      3,
      fingerprint,
      7,
      9,
    );
  });
});
