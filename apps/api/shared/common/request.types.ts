// 外部依赖
import { Request } from 'express';

/** 用户负载信息 */
export interface UserPayload {
  /** 用户ID */
  id: number;
  /** 扩展属性 */
  [key: string]: unknown;
}

declare module 'express' {
  interface Request {
    // 注：`ip` 由 @types/express-serve-static-core 提供（`readonly ip: string | undefined`），
    // 这里不要再声明，否则与其 readonly 声明冲突（TS2430）
    /** 用户信息 */
    user?: unknown;
    /** 请求日志ID */
    reqId?: number;
  }
}

declare module 'express-serve-static-core' {
  interface Response {
    /** 客户端IP，注：由令牌守卫写入，供日志记录与过滤器读取 */
    ip?: string;
    /** 请求日志参数，注：由令牌守卫写入，供拦截器与过滤器读取 */
    params?: Record<string, unknown>;
  }
}

/** 应用请求类型 */
export type AppRequest = Request & {
  /** 用户负载信息 */
  user?: UserPayload;
  /** 请求日志ID */
  reqId?: number;
};
