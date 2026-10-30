// 外部依赖
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
// 内部依赖
import type { AppRequest } from '../common/request.types.js';

/**
 * 从请求中提取真实客户端IP
 * 优先从 X-Forwarded-For（多层）/ X-Real-IP 获取，否则降级到 req.ip
 *
 * @param req Express 请求对象
 * @returns 客户端IP
 */
export function getClientIp(req: Request): string {
  /** 转发头 */
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For 可能为 "client, proxy1, proxy2"，取最左边（真实客户端）
    const ips = typeof forwarded === 'string' ? forwarded : forwarded[0];
    return ips.split(',')[0].trim();
  }
  /** 真实IP头 */
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return typeof realIp === 'string' ? realIp : realIp[0];
  }
  // trust proxy 开启后 req.ip 即为真实客户端 IP
  return req.ip || req.socket.remoteAddress || '';
}

/** 请求ID装饰器 */
export const ReqId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): number => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    return Number(request.reqId ?? 0);
  },
);

/** 客户端IP装饰器 */
export const ClientIp = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<AppRequest>();
    return getClientIp(request);
  },
);
