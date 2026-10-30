// 外部依赖
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RedisService } from './redis.service.js';

/**
 * 构造缓存服务替身
 *
 * 注：直接以原型创建实例，避免构造函数去连真实的 Redis；只覆盖被测方法用到的命令。
 *
 * @param overrides 需要覆盖的命令桩
 * @returns 缓存服务替身
 */
function serviceOf(overrides: Record<string, unknown>) {
  /** 原型实例 */
  const service = Object.create(RedisService.prototype) as Record<
    string,
    unknown
  >;
  // 注：logger 是字段初始化出来的，绕过构造函数后需要手动补上
  return Object.assign(
    service,
    { logger: new Logger(RedisService.name) },
    overrides,
  ) as unknown as RedisService & {
    exists: ReturnType<typeof vi.fn>;
    hmset: ReturnType<typeof vi.fn>;
    pexpireat: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
  };
}

describe('RedisService', () => {
  describe('addCode', () => {
    it('长期有效时不设置缓存过期时间', async () => {
      /** 缓存服务替身 */
      const service = serviceOf({
        exists: vi.fn(async (_key: string) => 0),
        hmset: vi.fn(async (_key: string, ..._values: unknown[]) => 'OK'),
        pexpireat: vi.fn(async (_key: string, _timestamp: number) => 1),
      });
      /** 随机码记录 */
      const result = await service.addCode('activate', 20, 0, { id: 1 });
      expect(result.code).toHaveLength(20);
      expect(result.expired).toBe(0);
      expect(service.pexpireat).not.toHaveBeenCalled();
      // 附加信息与随机码写在同一哈希里
      /** 写入的哈希参数 */
      const values = service.hmset.mock.calls[0];
      expect(values[0]).toMatch(/^activate:[A-Za-z0-9]{20}$/);
      expect(values[1]).toMatchObject({ id: 1, expired: 0 });
    });

    it('有有效期时过期时间多留 30 秒缓冲', async () => {
      /** 缓存服务替身 */
      const service = serviceOf({
        exists: vi.fn(async (_key: string) => 0),
        hmset: vi.fn(async (_key: string, ..._values: unknown[]) => 'OK'),
        pexpireat: vi.fn(async (_key: string, _timestamp: number) => 1),
      });
      /** 随机码记录 */
      const result = await service.addCode('activate', 20, 2, { id: 1 });
      expect(result.expired - result.createAt).toBe(2 * 60000);
      // 业务有效期外多留 30 秒，避免前端刚拿到就过期
      expect(service.pexpireat).toHaveBeenCalledWith(
        `activate:${result.code}`,
        result.expired + 30000,
      );
    });

    it('随机码冲突时重新生成，避免覆盖他人的记录', async () => {
      /** 缓存服务替身 */
      const service = serviceOf({
        exists: vi.fn(async (_key: string) => 0).mockResolvedValueOnce(1),
        hmset: vi.fn(async (_key: string, ..._values: unknown[]) => 'OK'),
        pexpireat: vi.fn(async (_key: string, _timestamp: number) => 1),
      });
      await service.addCode('reset', 20, 1);
      expect(service.exists).toHaveBeenCalledTimes(2);
    });
  });

  describe('scanKeys', () => {
    it('按游标分批遍历直到游标归零', async () => {
      /** 缓存服务替身 */
      const service = serviceOf({
        scan: vi
          .fn()
          .mockResolvedValueOnce(['17', ['token:1:a', 'token:1:b']])
          .mockResolvedValueOnce(['0', ['token:2:c']]),
      });
      expect(await service.scanKeys('token:*')).toEqual([
        'token:1:a',
        'token:1:b',
        'token:2:c',
      ]);
      expect(service.scan).toHaveBeenCalledTimes(2);
      // 使用 scan 而不是 keys，避免阻塞缓存服务
      expect(service.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'token:*',
        'COUNT',
        100,
      );
      expect(service.scan).toHaveBeenLastCalledWith(
        '17',
        'MATCH',
        'token:*',
        'COUNT',
        100,
      );
    });
  });

  describe('构造函数校验', () => {
    it('未配置缓存地址时直接抛错，避免应用带病启动', () => {
      /** 原缓存地址 */
      const host = process.env.REDIS_HOST;
      delete process.env.REDIS_HOST;
      expect(() => new RedisService()).toThrow('未配置缓存地址');
      if (host) {
        process.env.REDIS_HOST = host;
      }
    });
  });

  describe('onApplicationBootstrap', () => {
    afterEach(() => {
      delete process.env.REDIS_INIT;
      delete process.env.REDIS_DB;
      delete process.env.BULL_DB;
      vi.restoreAllMocks();
    });

    it('未开启 REDIS_INIT 时不动缓存', async () => {
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      /** 缓存服务替身 */
      const service = serviceOf({
        flushdb: vi.fn(async () => 'OK'),
        duplicate: vi.fn(),
      }) as unknown as RedisService & { flushdb: ReturnType<typeof vi.fn> };
      await service.onApplicationBootstrap();
      expect(service.flushdb).not.toHaveBeenCalled();
    });

    it('开启后清空应用库，并对独立的 Bull 库单独清理再断开', async () => {
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      process.env.REDIS_INIT = 'true';
      process.env.REDIS_DB = '0';
      process.env.BULL_DB = '1';
      /** Bull 库连接替身 */
      const bullClient = {
        flushdb: vi.fn(async () => 'OK'),
        quit: vi.fn(async () => 'OK'),
      };
      /** 缓存服务替身 */
      const service = serviceOf({
        flushdb: vi.fn(async () => 'OK'),
        duplicate: vi.fn(() => bullClient),
      }) as unknown as RedisService & {
        flushdb: ReturnType<typeof vi.fn>;
        duplicate: ReturnType<typeof vi.fn>;
      };

      await service.onApplicationBootstrap();
      expect(service.flushdb).toHaveBeenCalled();
      expect(service.duplicate).toHaveBeenCalledWith({ db: 1 });
      expect(bullClient.flushdb).toHaveBeenCalled();
      // 复制出来的连接用完必须断开，否则进程无法退出
      expect(bullClient.quit).toHaveBeenCalled();
    });

    it('Bull 与应用同库时不重复清理', async () => {
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      process.env.REDIS_INIT = 'true';
      process.env.REDIS_DB = '0';
      process.env.BULL_DB = '0';
      /** 缓存服务替身 */
      const service = serviceOf({
        flushdb: vi.fn(async () => 'OK'),
        duplicate: vi.fn(),
      }) as unknown as RedisService & {
        flushdb: ReturnType<typeof vi.fn>;
        duplicate: ReturnType<typeof vi.fn>;
      };

      await service.onApplicationBootstrap();
      expect(service.flushdb).toHaveBeenCalled();
      expect(service.duplicate).not.toHaveBeenCalled();
    });
  });
});
