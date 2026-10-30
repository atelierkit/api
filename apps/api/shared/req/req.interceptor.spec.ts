// 外部依赖
import {
  CallHandler,
  ExecutionContext,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { QueueService } from '../queue/queue.service.js';
import { ReqInterceptor } from './req.interceptor.js';
import { ReqService } from './req.service.js';

/**
 * 构造执行上下文替身
 *
 * @param req 请求替身
 * @param res 响应替身
 * @returns 执行上下文
 */
function contextOf(req: unknown, res: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

/**
 * 组装被测拦截器
 *
 * @returns 被测拦截器与全部替身
 */
function serviceOf() {
  /** 请求日志服务替身 */
  const reqSrv = { insert: vi.fn(async (_value: unknown) => 1) };
  /** 排队的任务 */
  const tasks: Array<() => Promise<unknown>> = [];
  /** 队列服务替身 */
  const queueSrv = {
    addTask: vi.fn((task: () => Promise<unknown>) => tasks.push(task)),
  };
  /** 被测拦截器 */
  const interceptor = new ReqInterceptor(
    reqSrv as unknown as ReqService,
    queueSrv as unknown as QueueService,
  );
  return { interceptor, reqSrv, queueSrv, tasks };
}

describe('ReqInterceptor', () => {
  beforeAll(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  it('正常响应：补写响应头并按真实状态码排队记日志', async () => {
    /** 被测拦截器与替身 */
    const { interceptor, reqSrv, tasks } = serviceOf();
    /** 请求与响应 */
    const req = { reqId: 12 };
    const res = { statusCode: 201, setHeader: vi.fn(), params: { reqId: 12 } };
    /** 处理链 */
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(contextOf(req, res), next));
    expect(res.setHeader).toHaveBeenCalledWith('request_id', 12);
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    /** 写入的日志数据 */
    const value = reqSrv.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(value.status).toBe(201);
    expect(value.reqId).toBe(12);
    expect(typeof value.endAt).toBe('number');
  });

  it('非 HttpException 的异常按 500 记录（不能落成实体默认的 200）', async () => {
    /** 被测拦截器与替身 */
    const { interceptor, reqSrv, tasks } = serviceOf();
    /** 处理链 */
    const next: CallHandler = {
      handle: () => throwError(() => new Error('boom')),
    };

    await expect(
      firstValueFrom(
        interceptor.intercept(
          contextOf(
            { reqId: 12 },
            {
              statusCode: 200,
              setHeader: vi.fn(),
              params: { reqId: 12 },
            },
          ),
          next,
        ),
      ),
    ).rejects.toThrow('boom');
    await tasks[0]();
    /** 写入的日志数据 */
    const value = reqSrv.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(value.status).toBe(500);
  });

  it('HttpException 按其自身状态码记录', async () => {
    /** 被测拦截器与替身 */
    const { interceptor, reqSrv, tasks } = serviceOf();
    /** 处理链 */
    const next: CallHandler = {
      handle: () => throwError(() => new NotFoundException('没了')),
    };

    await expect(
      firstValueFrom(
        interceptor.intercept(
          contextOf(
            { reqId: 12 },
            {
              statusCode: 200,
              setHeader: vi.fn(),
              params: { reqId: 12 },
            },
          ),
          next,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await tasks[0]();
    /** 写入的日志数据 */
    const value = reqSrv.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(value.status).toBe(404);
  });

  it('请求没有分配请求ID时不写日志、不补响应头（如静态资源与健康检查）', async () => {
    /** 被测拦截器与替身 */
    const { interceptor, tasks } = serviceOf();
    /** 请求与响应 */
    const res = { statusCode: 200, setHeader: vi.fn(), params: {} };
    /** 处理链 */
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(contextOf({}, res), next));
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });
});
