// 外部依赖
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UserId } from './user.decorator.js';

/** 参数装饰器注册的取值工厂 */
type ParamFactory = (data: unknown, ctx: ExecutionContext) => unknown;

/**
 * 构造执行上下文替身
 *
 * @param request 请求替身
 * @returns 执行上下文
 */
function contextOf(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * 取出参数装饰器注册的取值工厂
 *
 * 注：createParamDecorator 返回的是「注册元数据的函数」，真正的取值工厂记录在
 * ROUTE_ARGS_METADATA 中，按 Nest 的注册方式手动调用一次后从元数据取出即可。
 *
 * @param decorator 参数装饰器，如 `UserId()` 的返回值
 * @returns 取值工厂
 */
function factoryOf(decorator: ParameterDecorator): ParamFactory {
  /** 探测用控制器 */
  class Probe {
    /** 占位方法 */
    handler() {
      return undefined;
    }
  }
  decorator(Probe.prototype, 'handler', 0);
  /** 注册的参数元数据 */
  const metadata = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    Probe,
    'handler',
  ) as Record<string, { factory: ParamFactory }>;
  return Object.values(metadata)[0].factory;
}

describe('UserId', () => {
  it('从请求上下文的登录用户取用户ID', () => {
    expect(factoryOf(UserId())(undefined, contextOf({ user: { id: 7 } }))).toBe(
      7,
    );
  });

  it('用户ID为字符串时转换为数字（令牌里的 id 来自缓存，可能是字符串）', () => {
    expect(
      factoryOf(UserId())(undefined, contextOf({ user: { id: '9' } })),
    ).toBe(9);
  });

  it('未登录时返回 0，而不是 NaN 或 undefined', () => {
    expect(factoryOf(UserId())(undefined, contextOf({}))).toBe(0);
    expect(factoryOf(UserId())(undefined, contextOf({ user: {} }))).toBe(0);
  });
});
