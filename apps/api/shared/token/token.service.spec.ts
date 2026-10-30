// 外部依赖
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RedisService } from '../redis/redis.service.js';
import { TokenService } from './token.service.js';

/**
 * 构造缓存服务替身
 *
 * @returns 缓存替身（各方法均为桩）
 */
function redisStub() {
  return {
    scanKeys: vi.fn(
      async (_pattern: string, _count?: number) => [] as string[],
    ),
    hgetall: vi.fn(async (_key: string) => ({}) as Record<string, string>),
    exists: vi.fn(async (_key: string) => 0),
    renamenx: vi.fn(async (_from: string, _to: string) => 1),
    hmset: vi.fn(
      async (_key: string, ..._fieldValues: (string | number)[]) => 'OK',
    ),
    pexpireat: vi.fn(async (_key: string, _timestamp: number) => 1),
    persist: vi.fn(async (_key: string) => 1),
    del: vi.fn(async (_key: string) => 1),
  };
}

/**
 * 构造令牌服务
 *
 * @param redis 缓存替身
 * @returns 令牌服务
 */
function serviceOf(redis: ReturnType<typeof redisStub>) {
  return new TokenService(redis as unknown as RedisService);
}

describe('TokenService', () => {
  it('令牌清单按 scan 前缀遍历后逐个取详情', async () => {
    /** 缓存替身 */
    const redis = redisStub();
    redis.scanKeys.mockResolvedValue(['token:1:a', 'token:2:b']);
    redis.hgetall
      .mockResolvedValueOnce({ id: '1', code: 'a' })
      .mockResolvedValueOnce({ id: '2', code: 'b' });
    /** 令牌服务 */
    const srv = serviceOf(redis);

    expect(await srv.index()).toEqual([
      { id: '1', code: 'a' },
      { id: '2', code: 'b' },
    ]);
    // 使用 scan 游标而不是 keys，避免阻塞缓存
    expect(redis.scanKeys).toHaveBeenCalledWith('token:*');
    expect(await srv.count()).toBe(2);
  });

  it('令牌详情与作废都以 token:<令牌> 为键', async () => {
    /** 缓存替身 */
    const redis = redisStub();
    /** 令牌服务 */
    const srv = serviceOf(redis);

    await srv.show('1:abc');
    expect(redis.hgetall).toHaveBeenCalledWith('token:1:abc');

    await srv.destroy('1:abc');
    expect(redis.del).toHaveBeenCalledWith('token:1:abc');
  });

  it('刷新令牌：换键、写有效期并返回新令牌信息', async () => {
    /** 缓存替身 */
    const redis = redisStub();
    redis.hgetall.mockResolvedValue({ id: '1', code: 'new' });
    /** 令牌服务 */
    const srv = serviceOf(redis);

    /** 新令牌信息 */
    const result = await srv.refresh(1, '1:old', 1440);
    expect(result).toEqual({ id: '1', code: 'new' });
    // 旧键原子改名到新键，避免同时存在两个有效令牌
    expect(redis.renamenx).toHaveBeenCalledWith(
      'token:1:old',
      expect.stringMatching(/^token:1:[A-Za-z0-9]{60}$/),
    );
    /** 新令牌键 */
    const newKey = redis.hmset.mock.calls[0][0];
    /** hmset 参数 */
    const args = redis.hmset.mock.calls[0];
    expect(args[2]).toMatch(/^[A-Za-z0-9]{60}$/);
    expect(args[3]).toBe('valid');
    expect(args[4]).toBe(1440);
    /** 业务过期时间 */
    const expired = Number(args[6]);
    expect(expired).toBeGreaterThan(Date.now());
    // 缓存过期时间比业务有效期多留 5 分钟缓冲（applyValid 里另取一次当前时间，放宽 1 秒）
    /** 缓存过期时间点 */
    const [expireKey, expireAt] = redis.pexpireat.mock.calls[0];
    expect(expireKey).toBe(newKey);
    expect(expireAt).toBeGreaterThanOrEqual(expired + 300000);
    expect(expireAt).toBeLessThan(expired + 301000);
    expect(redis.persist).not.toHaveBeenCalled();
  });

  it('刷新为长期有效时清除过期时间，而不是设一个 5 分钟后的过期点', async () => {
    /** 缓存替身 */
    const redis = redisStub();
    /** 令牌服务 */
    const srv = serviceOf(redis);

    await srv.refresh(1, '1:old', 0);
    /** hmset 参数 */
    const args = redis.hmset.mock.calls[0];
    expect(args[4]).toBe(0);
    expect(Number(args[6])).toBe(0);
    expect(redis.pexpireat).not.toHaveBeenCalled();
    expect(redis.persist).toHaveBeenCalledWith(args[0]);
  });

  it('原令牌不存在或已过期时刷新失败，且不写新令牌字段', async () => {
    /** 缓存替身 */
    const redis = redisStub();
    redis.renamenx.mockResolvedValue(0);
    /** 令牌服务 */
    const srv = serviceOf(redis);

    await expect(srv.refresh(1, '1:old', 1440)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redis.hmset).not.toHaveBeenCalled();
    expect(redis.pexpireat).not.toHaveBeenCalled();
  });

  it('新令牌随机码冲突时重新生成（避免覆盖他人的令牌）', async () => {
    /** 缓存替身 */
    const redis = redisStub();
    redis.exists.mockResolvedValueOnce(1).mockResolvedValue(0);
    /** 令牌服务 */
    const srv = serviceOf(redis);

    await srv.refresh(1, '1:old', 60);
    expect(redis.exists).toHaveBeenCalledTimes(2);
  });
});
