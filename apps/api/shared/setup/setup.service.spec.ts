// 外部依赖
import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RetryAfterException } from '../common/retry-after.exception.js';
import { RedisService } from '../redis/redis.service.js';
import { SettingEntity } from '../setting/setting.entity.js';
import { UserService } from '../user/user.service.js';
import { SetupService } from './setup.service.js';

/**
 * 构造缓存服务替身
 *
 * @returns 缓存替身
 */
function redisStub() {
  return {
    get: vi.fn(async (_key: string) => null as string | null),
    set: vi.fn(async (_key: string, _value: string) => 'OK'),
    incr: vi.fn(async (_key: string) => 1),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    ttl: vi.fn(async (_key: string) => 0),
  };
}

/**
 * 构造配置存储器替身
 *
 * @returns 存储器替身
 */
function settingRepositoryStub() {
  return {
    existsBy: vi.fn(async (_where: unknown) => false),
  };
}

/**
 * 构造用户服务替身
 *
 * @returns 用户服务替身
 */
function userServiceStub() {
  return {
    checkUsername: vi.fn((username: string) => username.trim().toLowerCase()),
    checkPassword: vi.fn((_password: string, _username?: string) => undefined),
    toEmail: vi.fn((email?: string | null) =>
      email ? email.trim().toLowerCase() : null,
    ),
    issueToken: vi.fn(async (..._args: unknown[]) => ({ code: 'TOKEN' })),
  };
}

/**
 * 构造事务管理器替身
 *
 * @param rows INSERT ... RETURNING 的返回行
 * @returns 管理器替身与插入桩
 */
function managerStub(rows: unknown) {
  /** 用户插入桩 */
  const insert = vi.fn(async (_value: unknown) => ({
    identifiers: [{ id: 7 }],
  }));
  return {
    manager: {
      query: vi.fn(async (_sql: string, _params: unknown[]) => rows),
      getRepository: vi.fn(() => ({ insert })),
    },
    insert,
  };
}

/**
 * 组装被测服务
 *
 * @param options 各依赖替身与事务返回行
 * @returns 被测服务与全部替身
 */
function serviceOf(options: { rows?: unknown } = {}) {
  /** 缓存替身 */
  const redis = redisStub();
  /** 配置存储器替身 */
  const settingRepository = settingRepositoryStub();
  /** 用户服务替身 */
  const userSrv = userServiceStub();
  /** 管理器替身 */
  const { manager, insert } = managerStub(
    'rows' in options ? options.rows : [[{ code: 'init' }]],
  );
  /** 数据源替身 */
  const dataSource = {
    transaction: vi.fn(async (run: (m: unknown) => Promise<unknown>) =>
      run(manager),
    ),
  };
  /** 被测服务 */
  const service = new SetupService(
    dataSource as unknown as DataSource,
    settingRepository as unknown as Repository<SettingEntity>,
    redis as unknown as RedisService,
    userSrv as unknown as UserService,
  );
  return { service, redis, settingRepository, userSrv, dataSource, insert };
}

/** 合法的初始化入参 */
const VALUE = {
  username: ' Admin ',
  password: 'abc12345',
  email: 'ADMIN@Example.com',
  name: '  ',
};

describe('SetupService', () => {
  beforeEach(() => {
    // 初始化成功会打印业务日志，测试里静音避免刷屏
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.SETUP_TOKEN;
    vi.restoreAllMocks();
  });

  describe('ready', () => {
    it('缓存命中时直接返回，不再查库', async () => {
      /** 被测服务与替身 */
      const { service, redis, settingRepository } = serviceOf();
      redis.get.mockResolvedValue('1');
      expect(await service.ready()).toBe(true);
      expect(settingRepository.existsBy).not.toHaveBeenCalled();
    });

    it('缓存未命中时回查 settings 表，命中后回填缓存', async () => {
      /** 被测服务与替身 */
      const { service, redis, settingRepository } = serviceOf();
      settingRepository.existsBy.mockResolvedValue(true);
      expect(await service.ready()).toBe(true);
      expect(settingRepository.existsBy).toHaveBeenCalledWith({ code: 'init' });
      expect(redis.set).toHaveBeenCalledWith('init', '1');
    });

    it('未初始化时不缓存负向结果（避免首次初始化被缓存拖慢）', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      expect(await service.ready()).toBe(false);
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('setup', () => {
    it('已初始化时直接 409，且不进入任何校验', async () => {
      /** 被测服务与替身 */
      const { service, redis, userSrv } = serviceOf();
      redis.get.mockResolvedValue('1');
      await expect(service.setup(VALUE)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(userSrv.checkUsername).not.toHaveBeenCalled();
    });

    it('配置了 SETUP_TOKEN 时，凭据不符一律 403（长度不同也不泄漏差异）', async () => {
      process.env.SETUP_TOKEN = 'secret-token';
      /** 被测服务与替身 */
      const { service, userSrv } = serviceOf();
      await expect(
        service.setup(VALUE, 'wrong', '127.0.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // 同长度但内容不同，走 timingSafeEqual 分支
      await expect(
        service.setup(VALUE, 'secret-tokeX', '127.0.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(userSrv.checkUsername).not.toHaveBeenCalled();
    });

    it('配置了 SETUP_TOKEN 时，凭据正确即可从公网来源初始化', async () => {
      process.env.SETUP_TOKEN = 'secret-token';
      /** 被测服务与替身 */
      const { service, userSrv } = serviceOf();
      await service.setup(VALUE, ' secret-token ', '8.8.8.8');
      expect(userSrv.checkUsername).toHaveBeenCalled();
    });

    it('未配置 SETUP_TOKEN 时只接受回环/内网来源', async () => {
      /** 被测服务与替身 */
      const { service, userSrv } = serviceOf();
      await expect(service.setup(VALUE, '', '8.8.8.8')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        service.setup(VALUE, '', '172.32.0.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // IPv4-mapped IPv6、回环、10/8、192.168/16、172.16/12、IPv6 ULA 与链路本地均放行
      for (const ip of [
        '::ffff:127.0.0.1',
        '127.0.0.1',
        '10.1.2.3',
        '192.168.1.5',
        '172.16.3.4',
        '172.31.0.1',
        'fd00::1',
        'fe80::1',
      ]) {
        await service.setup(VALUE, '', ip);
      }
      expect(userSrv.checkUsername).toHaveBeenCalledTimes(8);
    });

    it('同一 IP 超过每分钟上限时 429，并带上剩余秒数', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      redis.incr.mockResolvedValue(6);
      redis.ttl.mockResolvedValue(42);
      /** 捕获的异常 */
      const error = await service
        .setup(VALUE, '', '127.0.0.1', '1.2.3.4')
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RetryAfterException);
      expect((error as RetryAfterException).retryAfter).toBe(42);
      expect((error as RetryAfterException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      // 计数键以动作与 IP 区分
      expect(redis.incr).toHaveBeenCalledWith('limit:ip:setup:1.2.3.4');
    });

    it('首次请求时给限流计数设置 60 秒有效期', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      await service.setup(VALUE, '', '127.0.0.1', '1.2.3.4');
      expect(redis.expire).toHaveBeenCalledWith('limit:ip:setup:1.2.3.4', 60);
    });

    it('初始化成功：写入标记与管理员在同一事务，回填缓存并直接签发令牌', async () => {
      /** 被测服务与替身 */
      const { service, redis, userSrv, insert, dataSource } = serviceOf();
      /** 返回结果 */
      const result = await service.setup(VALUE, '', '127.0.0.1', '1.2.3.4', 88);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith('init', '1');
      // 初始化成功即完成登录，前端不需要再走一次登录接口
      expect(userSrv.issueToken).toHaveBeenCalledWith(
        7,
        'setup',
        88,
        '1.2.3.4',
      );
      expect(result).toEqual({ code: 'TOKEN' });

      /** 管理员插入数据 */
      const value = insert.mock.calls[0][0] as Record<string, unknown>;
      expect(value.username).toBe('admin');
      expect(value.email).toBe('admin@example.com');
      // 昵称为空时退回用户名，避免后台出现没有标识的管理员
      expect(value.name).toBe('admin');
      expect(value.roles).toEqual(['admin']);
      expect(value.status).toBe(true);
      // 密码以 scrypt 自描述格式落库，绝不留明文
      expect(String(value.password)).toMatch(/^scrypt\$/);
      expect(String(value.password)).not.toContain(VALUE.password);
    });

    it('并发下被抢先：RETURNING 无行时 409，且不创建管理员、不签发令牌', async () => {
      /** 被测服务与替身 */
      const { service, userSrv, insert } = serviceOf({ rows: [] });
      await expect(
        service.setup(VALUE, '', '127.0.0.1'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(insert).not.toHaveBeenCalled();
      expect(userSrv.issueToken).not.toHaveBeenCalled();
    });

    it('INSERT 返回行被包一层时同样识别为成功（原生查询形态归一化）', async () => {
      /** 被测服务与替身 */
      const { service, userSrv } = serviceOf({ rows: [{ code: 'init' }] });
      await service.setup(VALUE, '', '127.0.0.1');
      expect(userSrv.issueToken).toHaveBeenCalled();
    });
  });
});
