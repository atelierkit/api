// 外部依赖
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Response } from 'express';

/** 携带 Retry-After 信息的限流异常 */
export class RetryAfterException extends HttpException {
  /** 建议等待秒数 */
  readonly retryAfter: number;

  /**
   * 构造函数
   *
   * @param msg 错误文案
   * @param retryAfter 建议等待秒数
   */
  constructor(msg: string, retryAfter: number) {
    super({ msg, retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    this.retryAfter = retryAfter;
  }
}

/** 限流异常过滤器，注：仅捕获 RetryAfterException，补写 Retry-After 响应头 */
@Injectable()
@Catch(RetryAfterException)
export class RetryAfterFilter implements ExceptionFilter {
  /**
   * 捕获限流异常并补写响应头
   *
   * @param exception 限流异常
   * @param host 执行上下文
   */
  catch(exception: RetryAfterException, host: ArgumentsHost) {
    /** 响应上下文 */
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Retry-After', String(exception.retryAfter));
    res.status(exception.getStatus()).json(exception.getResponse());
  }
}
