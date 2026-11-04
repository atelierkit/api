// 外部依赖
import type { Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { TokenService } from '../token/token.service.js';
import {
  SOCKET_AUTH_MESSAGES,
  socketIdentityOf,
} from './socket.auth.js';
import type { UserService } from './user.service.js';

/**
 * 组装 socket 替身
 *
 * @param auth 握手载荷
 * @param headers 请求头
 * @returns socket 替身
 */
function socketOf(
  auth: Record<string, unknown> = { token: 'T' },
  headers: Record<string, string> = {},
): Socket {
  return {
    handshake: { auth, headers },
    data: {},
  } as unknown as Socket;
}

/**
 * 组装服务替身
 *
 * @param token 令牌服务返回值
 * @param user 用户服务返回值
 * @returns 令牌与用户服务
 */
function servicesOf(
  token: unknown = { id: '7' },
  user: unknown = { id: 7, username: 'marbl', status: true, roles: ['admin'] },
) {
  return {
    tokenSrv: { show: vi.fn(async () => token) } as unknown as TokenService,
    userSrv: { show: vi.fn(async () => user) } as unknown as UserService,
  };
}

describe('socketIdentityOf', () => {
  it('校验通过时返回身份并写进 socket.data', async () => {
    /** socket */
    const socket = socketOf();
    /** 服务 */
    const services = servicesOf();
    /** 结果 */
    const result = await socketIdentityOf(socket, services.tokenSrv, services.userSrv);
    expect(result).toEqual({ ok: true, userId: 7, username: 'marbl' });
    expect(socket.data['userId']).toBe(7);
    expect(socket.data['username']).toBe('marbl');
  });

  it('没有令牌时拒绝，原因码是 no-token', async () => {
    /** 结果 */
    const result = await socketIdentityOf(
      socketOf({}),
      servicesOf().tokenSrv,
      servicesOf().userSrv,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'no-token',
      message: SOCKET_AUTH_MESSAGES['no-token'],
    });
  });

  it('令牌只放在请求头里时也能取到（少数客户端的行为）', async () => {
    /** 结果 */
    const result = await socketIdentityOf(
      socketOf({}, { token: '  T  ' }),
      servicesOf().tokenSrv,
      servicesOf().userSrv,
    );
    expect(result.ok).toBe(true);
  });

  it('令牌解析不出用户ID时是 token-invalid', async () => {
    /** 结果 */
    const result = await socketIdentityOf(
      socketOf(),
      servicesOf({}).tokenSrv,
      servicesOf().userSrv,
    );
    expect(result).toMatchObject({ ok: false, reason: 'token-invalid' });
  });

  it('用户不存在与用户被禁用分开报（便于排查）', async () => {
    /** 不存在 */
    const missing = await socketIdentityOf(
      socketOf(),
      servicesOf().tokenSrv,
      servicesOf(undefined, null).userSrv,
    );
    expect(missing).toMatchObject({ ok: false, reason: 'user-missing' });

    /** 禁用 */
    const disabled = await socketIdentityOf(
      socketOf(),
      servicesOf().tokenSrv,
      servicesOf(undefined, { id: 7, status: false, roles: ['admin'] }).userSrv,
    );
    expect(disabled).toMatchObject({ ok: false, reason: 'user-disabled' });
  });

  it('非 admin 角色被拒绝', async () => {
    /** 结果 */
    const result = await socketIdentityOf(
      socketOf(),
      servicesOf().tokenSrv,
      servicesOf(undefined, { id: 7, status: true, roles: ['user'] }).userSrv,
    );
    expect(result).toMatchObject({ ok: false, reason: 'not-admin' });
  });

  it('roles 缺失时按无权限处理，不炸', async () => {
    /** 结果 */
    const result = await socketIdentityOf(
      socketOf(),
      servicesOf().tokenSrv,
      servicesOf(undefined, { id: 7, status: true }).userSrv,
    );
    expect(result).toMatchObject({ ok: false, reason: 'not-admin' });
  });
});
