// 外部依赖
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Request } from 'express';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { ClientIp, getClientIp, ReqId } from './req.decorator.js';

/**
 * 构造请求替身
 *
 * @param input 请求头、ip 与对端地址
 * @returns 请求替身
 */
function requestOf(input: {
  headers?: Record<string, unknown>;
  ip?: string;
  remoteAddress?: string;
}): Request {
  return {
    headers: input.headers ?? {},
    ip: input.ip,
    socket: { remoteAddress: input.remoteAddress },
  } as unknown as Request;
}

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

/** 参数装饰器注册的取值工厂 */
type ParamFactory = (data: unknown, ctx: ExecutionContext) => unknown;

/**
 * 取出参数装饰器注册的取值工厂
 *
 * 注：createParamDecorator 返回的是「注册元数据的函数」，真正的取值工厂记录在
 * ROUTE_ARGS_METADATA 中，因此这里按 Nest 的注册方式手动调用一次再从元数据取出，
 * 避免为了测一行取值逻辑去起整个 HTTP 应用。
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

describe('req.decorator', () => {
  describe('getClientIp', () => {
    it('优先取 X-Forwarded-For 最左一段（真实客户端）', () => {
      /** 请求 */
      const req = requestOf({
        headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
        ip: '10.0.0.1',
      });
      expect(getClientIp(req)).toBe('1.1.1.1');
    });

    it('X-Forwarded-For 为数组时取第一个元素的左段', () => {
      /** 请求 */
      const req = requestOf({
        headers: { 'x-forwarded-for': ['4.4.4.4, 5.5.5.5', '6.6.6.6'] },
      });
      expect(getClientIp(req)).toBe('4.4.4.4');
    });

    it('无转发头时取 X-Real-IP', () => {
      /** 请求 */
      const req = requestOf({
        headers: { 'x-real-ip': '7.7.7.7' },
        ip: '10.0.0.1',
      });
      expect(getClientIp(req)).toBe('7.7.7.7');
    });

    it('X-Real-IP 为数组时取第一个元素', () => {
      /** 请求 */
      const req = requestOf({
        headers: { 'x-real-ip': ['8.8.8.8', '9.9.9.9'] },
      });
      expect(getClientIp(req)).toBe('8.8.8.8');
    });

    it('无任何转发头时降级到 req.ip，再降级到 socket 地址', () => {
      expect(getClientIp(requestOf({ ip: '10.0.0.2' }))).toBe('10.0.0.2');
      expect(getClientIp(requestOf({ remoteAddress: '10.0.0.3' }))).toBe(
        '10.0.0.3',
      );
      expect(getClientIp(requestOf({}))).toBe('');
    });
  });

  describe('ReqId', () => {
    it('从请求上下文取出请求日志ID', () => {
      expect(factoryOf(ReqId())(undefined, contextOf({ reqId: 12 }))).toBe(12);
    });

    it('请求上下文缺少 reqId 时返回 0', () => {
      expect(factoryOf(ReqId())(undefined, contextOf({}))).toBe(0);
    });
  });

  describe('ClientIp', () => {
    it('从请求上下文取出客户端IP', () => {
      /** 请求 */
      const req = requestOf({ headers: { 'x-real-ip': '6.6.6.6' } });
      expect(factoryOf(ClientIp())(undefined, contextOf(req))).toBe('6.6.6.6');
    });
  });
});
