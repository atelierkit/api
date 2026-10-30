// 外部依赖
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RedisService } from '../redis/redis.service.js';
import { ShortcutController } from './shortcut.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 缓存服务替身 */
  const redisSrv = {
    get: vi.fn(async (_key: string) => null as string | null),
    set: vi.fn(async (_key: string, _value: string) => 'OK'),
  };
  return {
    controller: new ShortcutController(redisSrv as unknown as RedisService),
    redisSrv,
  };
}

describe('ShortcutController', () => {
  it('未登录时 401，且不读缓存', async () => {
    /** 被测控制器与替身 */
    const { controller, redisSrv } = controllerOf();
    await expect(controller.show(0)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redisSrv.get).not.toHaveBeenCalled();
  });

  it('缓存为空时返回空数组，避免前端拿到 null', async () => {
    /** 被测控制器与替身 */
    const { controller, redisSrv } = controllerOf();
    expect(await controller.show(5)).toEqual([]);
    expect(redisSrv.get).toHaveBeenCalledWith('shortcut:5');
  });

  it('缓存命中时反序列化为字符串数组', async () => {
    /** 被测控制器与替身 */
    const { controller, redisSrv } = controllerOf();
    redisSrv.get.mockResolvedValue('["dashboard","user"]');
    expect(await controller.show(5)).toEqual(['dashboard', 'user']);
  });

  it('更新时按用户维度写缓存，且要求登录', async () => {
    /** 被测控制器与替身 */
    const { controller, redisSrv } = controllerOf();
    expect(await controller.update(['a'], 5)).toEqual({ result: 'OK' });
    expect(redisSrv.set).toHaveBeenCalledWith('shortcut:5', '["a"]');
    await expect(controller.update(['a'], 0)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
