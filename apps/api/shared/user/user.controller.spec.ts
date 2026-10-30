// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RedisService } from '../redis/redis.service.js';
import { TokenService } from '../token/token.service.js';
import { UserController } from './user.controller.js';
import { UserService } from './user.service.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 用户服务替身 */
  const userSrv = {
    show: vi.fn(async (_id: number, _type?: string) => ({ id: 1 }) as unknown),
    valid: vi.fn(async (_id: number) => 1440),
    setValid: vi.fn(async (_id: number, _valid: number, _reqId: number) => 30),
    update: vi.fn(async (..._args: unknown[]) => 1),
    password: vi.fn(async (..._args: unknown[]) => ({ code: 0 })),
    email: vi.fn(async (..._args: unknown[]) => 1),
  };
  /** 令牌服务替身 */
  const tokenSrv = {
    refresh: vi.fn(async (..._args: unknown[]) => ({ code: 'NEW' })),
    destroy: vi.fn(async (_token: string) => 1),
  };
  /** 缓存服务替身 */
  const redisSrv = {
    get: vi.fn(async (_key: string) => null as string | null),
  };
  return {
    controller: new UserController(
      userSrv as unknown as UserService,
      tokenSrv as unknown as TokenService,
      redisSrv as unknown as RedisService,
    ),
    userSrv,
    tokenSrv,
    redisSrv,
  };
}

describe('UserController', () => {
  it('startup / show 按当前登录用户取信息（用户ID来自令牌，不接受客户端传参）', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    expect(await controller.startup(7)).toEqual({ id: 1 });
    expect(userSrv.show).toHaveBeenCalledWith(7, 'startup');
    await controller.show(7);
    expect(userSrv.show).toHaveBeenCalledWith(7);
  });

  it('ip 直接回显请求上下文里的客户端IP', () => {
    /** 被测控制器 */
    const { controller } = controllerOf();
    expect(controller.ip({ ip: '1.2.3.4' } as never)).toEqual({
      ip: '1.2.3.4',
    });
  });

  it('nav 无缓存时返回空快捷方式，有缓存时反序列化', async () => {
    /** 被测控制器与替身 */
    const { controller, redisSrv } = controllerOf();
    expect(await controller.nav(7)).toEqual({ orders: [] });
    redisSrv.get.mockResolvedValue('["dashboard"]');
    expect(await controller.nav(7)).toEqual({ orders: ['dashboard'] });
    expect(redisSrv.get).toHaveBeenCalledWith('shortcut:7');
  });

  it('refresh 用用户设置的有效期续期，不接受客户端指定', async () => {
    /** 被测控制器与替身 */
    const { controller, tokenSrv } = controllerOf();
    expect(await controller.refresh('1:abc', 7)).toEqual({ code: 'NEW' });
    expect(tokenSrv.refresh).toHaveBeenCalledWith(7, '1:abc', 1440);
  });

  it('valid 先落库再按新有效期刷新当前令牌', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv, tokenSrv } = controllerOf();
    expect(await controller.valid({ valid: 60 }, '1:abc', 7, 88)).toEqual({
      code: 'NEW',
    });
    expect(userSrv.setValid).toHaveBeenCalledWith(7, 60, 88);
    expect(tokenSrv.refresh).toHaveBeenCalledWith(7, '1:abc', 30);
  });

  it('update / password / email 透传当前用户与请求ID', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    await controller.update({ name: 'n', avatar: 'a' }, 7, 88);
    expect(userSrv.update).toHaveBeenCalledWith(
      7,
      { name: 'n', avatar: 'a' },
      7,
      88,
    );

    await controller.password(
      { oldPassword: 'abc12345', newPassword: 'abc12346' },
      '1:abc',
      7,
      88,
    );
    expect(userSrv.password).toHaveBeenCalledWith(
      7,
      { oldPassword: 'abc12345', newPassword: 'abc12346' },
      '1:abc',
      88,
    );

    await controller.email('a@b.com', 7, '1.2.3.4');
    expect(userSrv.email).toHaveBeenCalledWith(7, 'a@b.com', '1.2.3.4');
  });

  it('logout 作废当前令牌', async () => {
    /** 被测控制器与替身 */
    const { controller, tokenSrv } = controllerOf();
    expect(await controller.destroy('1:abc')).toBe(1);
    expect(tokenSrv.destroy).toHaveBeenCalledWith('1:abc');
  });
});
