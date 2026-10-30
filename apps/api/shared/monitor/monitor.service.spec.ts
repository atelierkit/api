// 外部依赖
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { DbMonitorService } from './monitor.service.js';

/** 连接池事件回调 */
type PoolListener = (arg: unknown) => void;

/** 日志桩集合 */
interface LogSpies {
  error: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  log: ReturnType<typeof vi.spyOn>;
  debug: ReturnType<typeof vi.spyOn>;
}

/** 日志桩，注：在每个用例的 beforeEach 里重建 */
let spies: LogSpies;

/**
 * 取某个级别日志的全部文本
 *
 * @param level 日志级别
 * @returns 日志文本清单
 */
function messagesOf(level: keyof LogSpies): string[] {
  /** 日志桩调用记录 */
  const calls = (spies[level] as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  return calls.map((call) => String(call[0]));
}

/**
 * 构造连接池替身
 *
 * @returns 连接池替身与事件回调表
 */
function poolStub() {
  /** 事件回调表 */
  const listeners: Record<string, PoolListener> = {};
  /** 连接池替身 */
  const pool = {
    totalCount: 5,
    idleCount: 3,
    waitingCount: 1,
    on: vi.fn((event: string, listener: PoolListener) => {
      listeners[event] = listener;
      return pool;
    }),
  };
  return { pool, listeners };
}

/**
 * 组装被测服务
 *
 * @param pool 连接池替身，缺省表示拿不到连接池
 * @returns 被测服务与数据源替身
 */
function serviceOf(pool?: unknown) {
  /** 数据源替身 */
  const dataSource = {
    driver: { master: pool },
    query: vi.fn(async (_sql: string) => [] as unknown[]),
  };
  return {
    service: new DbMonitorService(dataSource as unknown as DataSource),
    dataSource,
  };
}

describe('DbMonitorService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T00:00:00Z'));
    spies = {
      error: vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined),
      warn: vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined),
      log: vi
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined),
      debug: vi
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('拿不到连接池时只告警，不启动探活', async () => {
      /** 被测服务与数据源替身 */
      const { service, dataSource } = serviceOf();
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(60000);
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(spies.warn).toHaveBeenCalled();
    });

    it('拿到连接池时挂上三类事件并每 60 秒探活一次', async () => {
      /** 连接池替身 */
      const { pool } = poolStub();
      /** 被测服务与数据源替身 */
      const { service, dataSource } = serviceOf(pool);
      service.onModuleInit();
      expect(pool.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(pool.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(pool.on).toHaveBeenCalledWith('remove', expect.any(Function));

      await vi.advanceTimersByTimeAsync(60000);
      expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
      await vi.advanceTimersByTimeAsync(60000);
      expect(dataSource.query).toHaveBeenCalledTimes(2);
    });

    it('连接池初始化异常时不抛出，仅记录错误', () => {
      /** 数据源替身 */
      const dataSource = {
        get driver(): unknown {
          throw new Error('驱动未就绪');
        },
      };
      /** 被测服务 */
      const service = new DbMonitorService(dataSource as unknown as DataSource);
      expect(() => service.onModuleInit()).not.toThrow();
      expect(spies.error).toHaveBeenCalled();
    });
  });

  describe('探活', () => {
    it('连续失败按次数累计，恢复后清零并给出恢复日志', async () => {
      /** 连接池替身 */
      const { pool } = poolStub();
      /** 被测服务与数据源替身 */
      const { service, dataSource } = serviceOf(pool);
      dataSource.query.mockRejectedValue(new Error('连接已断开'));
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(60000);
      await vi.advanceTimersByTimeAsync(60000);
      /** 失败日志 */
      const errors = messagesOf('error');
      expect(errors.some((text) => text.includes('连续第 1 次'))).toBe(true);
      expect(errors.some((text) => text.includes('连续第 2 次'))).toBe(true);

      dataSource.query.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(60000);
      // 恢复后给出此前连续失败次数，便于判断断连时长
      expect(
        messagesOf('log').some((text) =>
          text.includes('已恢复正常，此前连续失败 2 次'),
        ),
      ).toBe(true);
    });

    it('模块销毁后不再探活', async () => {
      /** 连接池替身 */
      const { pool } = poolStub();
      /** 被测服务与数据源替身 */
      const { service, dataSource } = serviceOf(pool);
      service.onModuleInit();
      service.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(120000);
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('连接池事件', () => {
    it('单次异常记录连接池快照，30 秒内连续 3 次追加突发告警', () => {
      /** 连接池替身与回调表 */
      const { pool, listeners } = poolStub();
      /** 被测服务 */
      const { service } = serviceOf(pool);
      service.onModuleInit();

      listeners.error(new Error('Connection terminated unexpectedly'));
      /** 首条错误日志 */
      const [first] = messagesOf('error');
      expect(first).toContain('Connection terminated unexpectedly');
      // 连接池快照与窗口内次数是排障的关键信息
      expect(first).toContain('total=5 idle=3 waiting=1');
      expect(first).toContain('近30秒 1 次');

      listeners.error(new Error('boom'));
      listeners.error(new Error('boom'));
      expect(
        messagesOf('error').some((text) => text.includes('疑似对端整体重启')),
      ).toBe(true);
    });

    it('突发告警按 30 秒窗口节流，不会持续刷屏', () => {
      /** 连接池替身与回调表 */
      const { pool, listeners } = poolStub();
      /** 被测服务 */
      const { service } = serviceOf(pool);
      service.onModuleInit();
      /** 突发告警次数 */
      const burstCount = () =>
        messagesOf('error').filter((text) => text.includes('疑似对端整体重启'))
          .length;

      for (let i = 0; i < 3; i++) {
        listeners.error(new Error('boom'));
      }
      expect(burstCount()).toBe(1);
      // 窗口内继续异常，只在常规日志里累计，不再重复告警
      listeners.error(new Error('boom'));
      expect(burstCount()).toBe(1);

      // 越过节流窗口后再次达到阈值，重新告警
      vi.advanceTimersByTime(31000);
      for (let i = 0; i < 3; i++) {
        listeners.error(new Error('boom'));
      }
      expect(burstCount()).toBe(2);
    });

    it('异常后重连用 warn 级别记录，便于日志级别只看 error 时也能发现', () => {
      /** 连接池替身与回调表 */
      const { pool, listeners } = poolStub();
      /** 被测服务 */
      const { service } = serviceOf(pool);
      service.onModuleInit();
      listeners.error(new Error('boom'));
      listeners.connect({ processID: 4321 });
      /** 重连日志 */
      const warns = messagesOf('warn');
      expect(warns.some((text) => text.includes('已重新建立连接'))).toBe(true);
      expect(warns.some((text) => text.includes('4321'))).toBe(true);
    });

    it('连接移除只在刚发生过异常时记录，避免空闲回收刷日志', () => {
      /** 连接池替身与回调表 */
      const { pool, listeners } = poolStub();
      /** 被测服务 */
      const { service } = serviceOf(pool);
      service.onModuleInit();

      listeners.remove({ processID: 1 });
      expect(spies.debug).not.toHaveBeenCalled();

      listeners.error(new Error('boom'));
      spies.debug.mockClear();
      listeners.remove({ processID: 1 });
      expect(spies.debug).toHaveBeenCalled();
    });
  });
});
