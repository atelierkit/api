// 外部依赖
import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { beforeAll, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { QueueService } from '../queue/queue.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ReqService } from '../req/req.service.js';
import { UserService } from '../user/user.service.js';
import { TokenGuard } from './token.guard.js';
import { TokenService } from './token.service.js';

/**
 * 构造请求替身
 *
 * @param path 请求路径
 * @param token 请求头中的令牌
 * @returns 请求替身
 */
function requestOf(path: string, token?: string) {
  return {
    path,
    url: path,
    headers: token ? { token } : {},
    ip: '1.2.3.4',
    socket: { address: () => ({ address: '10.0.0.9' }) },
  } as unknown as Request;
}

/**
 * 构造响应替身
 *
 * @returns 响应替身
 */
function responseOf() {
  return {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
  };
}

/**
 * 构造执行上下文替身
 *
 * 注：守卫会读取 getClass().name 与 getHandler().name 做日志标识，
 * 这里用独立的函数声明充当处理器，避免引用原型方法。
 *
 * @param req 请求替身
 * @param res 响应替身
 * @returns 执行上下文
 */
function contextOf(req: unknown, res: unknown): ExecutionContext {
  /** 控制器 */
  class TestController {}
  /** 处理器 */
  function index() {
    return undefined;
  }
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getClass: () => TestController,
    getHandler: () => index,
  } as unknown as ExecutionContext;
}

/**
 * 组装被测守卫
 *
 * @param options 角色声明与令牌内容
 * @returns 被测守卫与全部替身
 */
function serviceOf(
  options: { roles?: string[]; token?: Record<string, string> } = {},
) {
  /** 反射器替身 */
  const reflector = {
    getAllAndOverride: vi.fn(
      (_key: string, _targets: unknown[]) => options.roles,
    ),
  };
  /** 缓存服务替身 */
  const redis = { incr: vi.fn(async (_key: string) => 88) };
  /** 请求日志服务替身 */
  const reqSrv = { insert: vi.fn(async (_value: unknown) => 1) };
  /** 用户服务替身 */
  const userSrv = {
    show: vi.fn(
      async (
        _id: number,
        _type?: string,
      ): Promise<Record<string, unknown> | null> => ({
        id: 5,
        username: 'admin',
        status: true,
        roles: ['admin'],
      }),
    ),
    session: vi.fn(async (_id: number) => undefined),
  };
  /** 令牌服务替身 */
  const tokenSrv = {
    show: vi.fn(
      async (_token: string) => options.token ?? { id: '5', code: 'abc' },
    ),
  };
  /** 队列服务替身 */
  const queueSrv = {
    addTask: vi.fn((_task: () => Promise<unknown>) => undefined),
  };
  /** 被测守卫 */
  const guard = new TokenGuard(
    reflector as unknown as Reflector,
    redis as unknown as RedisService,
    reqSrv as unknown as ReqService,
    userSrv as unknown as UserService,
    tokenSrv as unknown as TokenService,
    queueSrv as unknown as QueueService,
  );
  return { guard, reflector, redis, reqSrv, userSrv, tokenSrv, queueSrv };
}

describe('TokenGuard', () => {
  beforeAll(() => {
    // 守卫内部有 debug 日志，测试里静音避免刷屏
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  it('写入请求ID、客户端IP与服务端IP，供日志与过滤器读取', async () => {
    /** 被测守卫与替身 */
    const { guard, redis } = serviceOf();
    /** 请求与响应 */
    const req = requestOf('/user/index', '5:abc');
    const res = responseOf();
    await guard.canActivate(contextOf(req, res));
    expect(redis.incr).toHaveBeenCalledWith('reqId');
    expect(req.reqId).toBe(88);
    expect(res.ip).toBe('1.2.3.4');
    /** 请求日志参数 */
    const params = res.params as Record<string, unknown>;
    expect(params.serverIp).toBe('10.0.0.9');
    expect(params.controller).toBe('TestController');
    expect(params.action).toBe('index');
    expect(params.url).toBe('/user/index');
  });

  it('passport 路径直接放行，不查令牌', async () => {
    /** 被测守卫与替身 */
    const { guard, tokenSrv } = serviceOf();
    expect(
      await guard.canActivate(
        contextOf(requestOf('/passport/login'), responseOf()),
      ),
    ).toBe(true);
    expect(tokenSrv.show).not.toHaveBeenCalled();
  });

  it('令牌无效时记 401 日志并抛 401', async () => {
    /** 被测守卫与替身 */
    const { guard, reqSrv } = serviceOf({ token: {} });
    /** 响应 */
    const res = responseOf();
    await expect(
      guard.canActivate(contextOf(requestOf('/user/index', 'bad'), res)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    /** 写入的日志数据 */
    const value = reqSrv.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(value.status).toBe(401);
    expect(value.userId).toBe(0);
    expect(res.setHeader).toHaveBeenCalledWith('request_id', 88);
  });

  it('令牌指向的用户不存在时 401，并在文案里带上用户ID', async () => {
    /** 被测守卫与替身 */
    const { guard, userSrv } = serviceOf();
    userSrv.show.mockResolvedValue(null);
    /** 捕获的异常 */
    const error = await guard
      .canActivate(contextOf(requestOf('/user/index', '5:abc'), responseOf()))
      .catch((err: unknown) => err);
    expect((error as HttpException).getStatus()).toBe(401);
    expect((error as HttpException).message).toBe('用户ID5验证无效！');
  });

  it('用户被禁用时 401', async () => {
    /** 被测守卫与替身 */
    const { guard, userSrv } = serviceOf();
    userSrv.show.mockResolvedValue({
      id: 5,
      username: 'admin',
      status: false,
      roles: [],
    });
    /** 捕获的异常 */
    const error = await guard
      .canActivate(contextOf(requestOf('/user/index', '5:abc'), responseOf()))
      .catch((err: unknown) => err);
    expect((error as HttpException).message).toBe('用户admin已被禁用！');
  });

  it('角色不足时 403，日志状态码也必须是 403（不能一律记成 401）', async () => {
    /** 被测守卫与替身 */
    const { guard, userSrv, reqSrv } = serviceOf({ roles: ['admin'] });
    userSrv.show.mockResolvedValue({
      id: 5,
      username: 'bob',
      status: true,
      roles: ['viewer'],
    });
    await expect(
      guard.canActivate(
        contextOf(requestOf('/user/index', '5:abc'), responseOf()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    /** 写入的日志数据 */
    const value = reqSrv.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(value.status).toBe(403);
  });

  it('命中任意一个声明角色即通过', async () => {
    /** 被测守卫与替身 */
    const { guard, userSrv } = serviceOf({ roles: ['admin', 'viewer'] });
    userSrv.show.mockResolvedValue({
      id: 5,
      username: 'bob',
      status: true,
      roles: ['viewer'],
    });
    /** 请求 */
    const req = requestOf('/user/index', '5:abc');
    expect(await guard.canActivate(contextOf(req, responseOf()))).toBe(true);
    expect(req.user).toMatchObject({ id: 5, username: 'bob' });
  });

  it('验证通过后异步更新最后会话时间，不阻塞响应', async () => {
    /** 被测守卫与替身 */
    const { guard, queueSrv, userSrv } = serviceOf();
    await guard.canActivate(
      contextOf(requestOf('/user/index', '5:abc'), responseOf()),
    );
    expect(queueSrv.addTask).toHaveBeenCalledTimes(1);
    // 任务只是被排队，此时尚未执行
    expect(userSrv.session).not.toHaveBeenCalled();
    /** 排队的任务 */
    const task = queueSrv.addTask.mock.calls[0][0];
    await task();
    expect(userSrv.session).toHaveBeenCalledWith(5);
  });
});
