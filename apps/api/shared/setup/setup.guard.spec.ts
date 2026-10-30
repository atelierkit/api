// 外部依赖
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SetupGuard } from './setup.guard.js';
import { SetupService } from './setup.service.js';

/**
 * 构造执行上下文
 *
 * @param method 请求方法
 * @param path 请求路径
 * @returns 执行上下文
 */
function contextOf(method: string, path: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, path }),
    }),
  } as unknown as ExecutionContext;
}

/**
 * 构造初始化服务替身
 *
 * @param initialized 是否已初始化
 * @returns 服务替身与可断言的 ready 桩
 */
function serviceOf(initialized: boolean) {
  /** 初始化状态桩 */
  const ready = vi.fn().mockResolvedValue(initialized);
  return {
    service: { ready } as unknown as SetupService,
    ready,
  };
}

describe('SetupGuard', () => {
  it('未初始化时，登录接口被拒绝（428）', async () => {
    /** 守卫 */
    const guard = new SetupGuard(serviceOf(false).service);
    await expect(
      guard.canActivate(contextOf('POST', '/passport/login')),
    ).rejects.toBeInstanceOf(HttpException);
    // 状态码必须是 428，而不是 401/403
    try {
      await guard.canActivate(contextOf('POST', '/passport/login'));
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
  });

  it('未初始化时，初始化状态与创建管理员接口放行', async () => {
    /** 守卫 */
    const guard = new SetupGuard(serviceOf(false).service);
    expect(await guard.canActivate(contextOf('GET', '/passport/init'))).toBe(
      true,
    );
    expect(await guard.canActivate(contextOf('POST', '/passport/setup'))).toBe(
      true,
    );
    // 应用展示配置同样放行，保证创建管理员页面能渲染页头
    expect(await guard.canActivate(contextOf('GET', '/passport/app'))).toBe(
      true,
    );
  });

  it('已初始化后一切放行', async () => {
    /** 守卫 */
    const guard = new SetupGuard(serviceOf(true).service);
    expect(await guard.canActivate(contextOf('POST', '/passport/login'))).toBe(
      true,
    );
  });

  it('非 passport 路径直接放行且不查询初始化状态', async () => {
    /** 初始化服务替身 */
    const { service, ready } = serviceOf(false);
    /** 守卫 */
    const guard = new SetupGuard(service);
    expect(await guard.canActivate(contextOf('GET', '/user/nav'))).toBe(true);
    // 正常业务请求不应为初始化状态多付一次缓存查询
    expect(ready).not.toHaveBeenCalled();
  });
});
