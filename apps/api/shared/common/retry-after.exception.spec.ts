// 外部依赖
import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import {
  RetryAfterException,
  RetryAfterFilter,
} from './retry-after.exception.js';

/**
 * 构造响应替身
 *
 * @returns 响应替身与可断言的桩
 */
function responseStub() {
  /** 响应替身 */
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

/**
 * 构造执行上下文替身
 *
 * @param res 响应替身
 * @returns 执行上下文
 */
function hostOf(res: unknown): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
}

describe('RetryAfterException', () => {
  it('状态码为 429，响应体携带 msg 与 retryAfter', () => {
    /** 限流异常 */
    const exception = new RetryAfterException('请求过于频繁', 42);
    expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(exception.getResponse()).toEqual({
      msg: '请求过于频繁',
      retryAfter: 42,
    });
    expect(exception.retryAfter).toBe(42);
  });
});

describe('RetryAfterFilter', () => {
  it('补写 Retry-After 响应头并按异常体响应', () => {
    /** 响应替身 */
    const res = responseStub();
    /** 过滤器 */
    const filter = new RetryAfterFilter();
    filter.catch(new RetryAfterException('请求过于频繁', 30), hostOf(res));
    // 秒数以字符串写入响应头，前端与反代按标准读取
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    expect(res.status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(res.json).toHaveBeenCalledWith({
      msg: '请求过于频繁',
      retryAfter: 30,
    });
  });
});
