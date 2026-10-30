// 外部依赖
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { TypeORMError } from 'typeorm';

/** SQL 日志截断长度 */
const SQL_LIMIT = 500;

/** 请求日志参数（由路由守卫写入响应上下文，仅取本过滤器需要的字段） */
interface RequestParams {
  /** 请求日志ID */
  reqId?: number;
  /** 用户ID */
  userId?: number;
  /** 请求路径 */
  url?: string;
  /** 客户端IP */
  clientIp?: string;
  /** 请求开始时间 */
  startAt?: number;
}

/** 数据库异常携带的查询与驱动信息 */
interface QueryErrorLike {
  /** 出错的SQL */
  query?: string;
  /** 驱动层原始错误 */
  driverError?: {
    /** 错误码 */
    code?: string;
    /** 系统错误号 */
    errno?: string;
  };
}

/** 数据库异常过滤器
 *
 * 记录数据库异常的请求上下文：路由、用户、客户端IP、耗时、驱动错误码与SQL。
 * 注1：路由守卫阶段的异常早于拦截器，既不会写入请求日志，也缺少业务上下文，
 *      这里的日志是故障复现时的主要线索。
 * 注2：响应体保持与框架默认处理一致（500 / Internal server error），不改变既有行为。
 */
@Injectable()
@Catch(TypeORMError)
export class DbErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DbErrorFilter.name);

  /**
   * 捕获数据库异常，记录日志并按框架默认格式响应
   *
   * @param exception 数据库异常
   * @param host 执行上下文
   */
  catch(exception: TypeORMError, host: ArgumentsHost): void {
    /** 请求上下文 */
    const req = host.switchToHttp().getRequest<Request>();
    /** 响应上下文 */
    const res = host.switchToHttp().getResponse<Response>();
    /** 请求日志参数 */
    const params = (res['params'] || {}) as RequestParams;
    this.logger.error(this.describe(exception, req, params), exception.stack);
    // 响应报文已开始发送时不再补发，与框架默认处理保持一致
    if (res.headersSent) {
      return;
    }
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }

  /**
   * 组装数据库异常日志
   *
   * @param exception 数据库异常
   * @param req 请求上下文
   * @param params 请求日志参数
   * @returns 日志文本
   */
  private describe(
    exception: TypeORMError,
    req: Request,
    params: RequestParams,
  ): string {
    /** 异常详情 */
    const detail = exception as unknown as QueryErrorLike;
    /** 请求耗时（毫秒） */
    const cost = params.startAt ? Date.now() - params.startAt : 0;
    /** 驱动层错误码 */
    const code = detail.driverError?.code || detail.driverError?.errno || '-';
    /** 出错SQL（压缩空白便于单行输出） */
    const sql = detail.query
      ? String(detail.query).replace(/\s+/g, ' ').slice(0, SQL_LIMIT)
      : '-';
    return (
      `数据库访问异常：reqId=${params.reqId ?? '-'}` +
      ` userId=${params.userId ?? 0} url=${params.url ?? req.url}` +
      ` clientIp=${params.clientIp ?? '-'} 耗时=${cost}ms 错误码=${code}` +
      ` 原因=${exception.message}；SQL=${sql}`
    );
  }
}
