// 外部依赖
import { ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { TypeORMError } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { DbErrorFilter } from './db-error.filter.js';

/**
 * 构造数据库异常替身
 *
 * @param query 出错的SQL
 * @param code 驱动层错误码
 * @returns 数据库异常
 */
function errorOf(query?: string, code?: string): TypeORMError {
  return Object.assign(new TypeORMError('连接已被对端关闭'), {
    query,
    driverError: code ? { code } : undefined,
  });
}

/**
 * 构造响应替身
 *
 * @param params 由路由守卫写入的请求日志参数
 * @returns 响应替身
 */
function responseStub(params?: Record<string, unknown>) {
  /** 响应替身 */
  const res = {
    headersSent: false,
    status: vi.fn(),
    json: vi.fn(),
    params,
  };
  res.status.mockReturnValue(res);
  return res;
}

/**
 * 构造执行上下文替身
 *
 * @param url 请求路径
 * @param res 响应替身
 * @returns 执行上下文
 */
function hostOf(url: string, res: unknown): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ url }),
      getResponse: () => res,
    }),
  } as unknown as ArgumentsHost;
}

describe('DbErrorFilter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('记录请求上下文、驱动错误码与压缩后的SQL，并保持框架默认 500 响应', () => {
    /** 日志桩 */
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    /** 响应替身 */
    const res = responseStub({
      reqId: 9,
      userId: 5,
      url: '/user/index',
      clientIp: '1.1.1.1',
      startAt: Date.now() - 120,
    });
    /** 异常 */
    const error = errorOf('SELECT  *\n  FROM users\n WHERE id = $1', '57P01');
    new DbErrorFilter().catch(error, hostOf('/user/index', res));

    expect(log).toHaveBeenCalledTimes(1);
    /** 日志文本 */
    const message = String(log.mock.calls[0][0]);
    expect(message).toContain('reqId=9');
    expect(message).toContain('userId=5');
    expect(message).toContain('url=/user/index');
    expect(message).toContain('clientIp=1.1.1.1');
    expect(message).toContain('错误码=57P01');
    // SQL 换行与连续空白被压成单行，便于按行检索
    expect(message).toContain('SQL=SELECT * FROM users WHERE id = $1');
    expect(message).toMatch(/耗时=\d+ms/);
    // 第二个参数带上堆栈，便于定位
    expect(log.mock.calls[0][1]).toBe(error.stack);

    expect(res.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  });

  it('缺少请求上下文与SQL时使用占位值，不抛异常', () => {
    /** 日志桩 */
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    /** 响应替身 */
    const res = responseStub();
    new DbErrorFilter().catch(errorOf(), hostOf('/x', res));

    /** 日志文本 */
    const message = String(log.mock.calls[0][0]);
    expect(message).toContain('reqId=-');
    expect(message).toContain('userId=0');
    expect(message).toContain('clientIp=-');
    expect(message).toContain('错误码=-');
    expect(message).toContain('SQL=-');
    expect(message).toContain('url=/x');
  });

  it('SQL 超过 500 字符时截断', () => {
    /** 日志桩 */
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    /** 响应替身 */
    const res = responseStub();
    /** 超长SQL */
    const query = `SELECT '${'x'.repeat(600)}'`;
    new DbErrorFilter().catch(errorOf(query), hostOf('/x', res));

    /** 日志文本 */
    const message = String(log.mock.calls[0][0]);
    /** SQL 片段 */
    const sql = message.slice(message.indexOf('SQL=') + 4);
    expect(sql).toHaveLength(500);
  });

  it('响应头已发送时不再补发响应体', () => {
    /** 日志桩 */
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    /** 响应替身 */
    const res = responseStub();
    res.headersSent = true;
    new DbErrorFilter().catch(errorOf(), hostOf('/x', res));
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
