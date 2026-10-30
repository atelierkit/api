// 外部依赖
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { QueueService } from './queue.service.js';

/**
 * 等待一段时间
 *
 * @param ms 毫秒
 * @returns 等待完成的 Promise
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('QueueService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('任务串行执行并保持入队顺序', async () => {
    /** 队列服务 */
    const queue = new QueueService();
    /** 执行顺序 */
    const order: number[] = [];
    queue.addTask(async () => {
      await wait(10);
      order.push(1);
    });
    queue.addTask(async () => {
      order.push(2);
    });
    await wait(50);
    // 若并发执行，先入队的任务反而会后完成
    expect(order).toEqual([1, 2]);
  });

  it('单个任务失败不阻断后续任务', async () => {
    /** 错误日志桩 */
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    /** 队列服务 */
    const queue = new QueueService();
    /** 已执行的任务 */
    const done: string[] = [];
    queue.addTask(async () => {
      done.push('first');
      throw new Error('boom');
    });
    queue.addTask(async () => {
      done.push('second');
    });
    await wait(30);
    expect(done).toEqual(['first', 'second']);
    expect(log).toHaveBeenCalled();
  });

  it('关闭后不再接受新任务', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    /** 队列服务 */
    const queue = new QueueService();
    /** 关闭流程 */
    const closing = queue.onModuleDestroy();
    // 关闭前排队等待剩余任务，固定 3 秒
    await vi.advanceTimersByTimeAsync(3000);
    await closing;

    /** 新任务 */
    const late = vi.fn(async () => undefined);
    queue.addTask(late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });
});
