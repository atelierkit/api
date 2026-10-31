// 外部依赖
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { RetryAfterException } from '../common/retry-after.exception.js';
import { EmailService } from '../email/email.service.js';
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import { RedisService } from '../redis/redis.service.js';
import { hashPassword } from './password.util.js';
import {
  LOGIN_FAIL_MAX,
  LOGIN_FAIL_TTL,
  LOGIN_LOCK_TTL,
} from './user.constant.js';
import { UserEntity, UserLogEntity } from './user.entity.js';
import { UserService } from './user.service.js';

/**
 * 构造存储器替身
 *
 * @returns 存储器替身
 */
function repositoryStub() {
  return {
    find: vi.fn(async (_options: unknown) => [] as unknown[]),
    findOne: vi.fn(async (_options: unknown) => null as unknown),
    existsBy: vi.fn(async (_where: unknown) => false),
    count: vi.fn(async () => 0),
    update: vi.fn(async (_criteria: unknown, _value: unknown) => ({
      affected: 1,
    })),
    insert: vi.fn(async (_value: unknown) => ({
      identifiers: [{ id: 5 }] as Array<{ id: number }>,
    })),
    metadata: { tableName: 'users', columns: [] as unknown[] },
  };
}

/**
 * 构造缓存服务替身
 *
 * @returns 缓存替身
 */
function redisStub() {
  return {
    incr: vi.fn(async (_key: string) => 1),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    ttl: vi.fn(async (_key: string) => 0),
    set: vi.fn(
      async (
        _key: string,
        _value: string,
        _mode?: string,
        _seconds?: number,
        _nx?: string,
      ) => 'OK',
    ),
    del: vi.fn(async (_key: string) => 1),
    hgetall: vi.fn(async (_key: string) => ({}) as Record<string, string>),
    hmset: vi.fn(async (_key: string, ..._values: unknown[]) => 'OK'),
    hincrby: vi.fn(async (_key: string, _field: string, _by: number) => 1),
    pexpireat: vi.fn(async (_key: string, _timestamp: number) => 1),
    scanKeys: vi.fn(async (_pattern: string) => [] as string[]),
    addCode: vi.fn(async (..._args: unknown[]) => ({ code: 'NEWCODE' })),
    pipeline: vi.fn(() => ({
      del: vi.fn(),
      exec: vi.fn(async () => []),
    })),
  };
}

/**
 * 组装被测服务
 *
 * @returns 被测服务与全部替身
 */
function serviceOf() {
  /** 缓存替身 */
  const redis = redisStub();
  /** 邮件服务替身 */
  const email = { send: vi.fn(async (_mail: unknown) => undefined) };
  /** 操作序号服务替身 */
  const operate = { create: vi.fn(async (..._args: unknown[]) => 1) };
  /** 队列服务替身 */
  const queue = {
    addTask: vi.fn((_task: () => Promise<unknown>) => undefined),
  };
  /** 用户存储器替身 */
  const repository = repositoryStub();
  /** 用户日志存储器替身 */
  const logRepository = repositoryStub();
  /** 被测服务 */
  const service = new UserService(
    redis as unknown as RedisService,
    email as unknown as EmailService,
    operate as unknown as OperateService,
    queue as unknown as QueueService,
    repository as unknown as Repository<UserEntity>,
    logRepository as unknown as Repository<UserLogEntity>,
  );
  return { service, redis, email, operate, queue, repository };
}

/** 合法密码的哈希，注：scrypt 较慢，整个文件只算一次 */
let HASH = '';

/** 合法用户（登录态查询用） */
const USER = {
  id: 1,
  username: 'admin',
  status: true,
  tokenValid: 1440,
  loginTimes: 3,
  firstLoginAt: 111,
};

describe('UserService', () => {
  beforeAll(async () => {
    HASH = await hashPassword('abc12345');
  });

  afterEach(() => {
    delete process.env.ALLOW_SIGNUP;
  });

  describe('用户名 / 密码 / 邮箱归一化与校验', () => {
    it('用户名去空白并转小写', () => {
      /** 被测服务 */
      const { service } = serviceOf();
      expect(service.normalizeUsername('  Admin_01 ')).toBe('admin_01');
      // 入库前统一小写，保证同一账号的不同书写形式命中同一频控键
      expect(service.checkUsername('ADMIN_01')).toBe('admin_01');
    });

    it('用户名不合规时抛出 400', () => {
      /** 被测服务 */
      const { service } = serviceOf();
      for (const username of ['ab', 'a'.repeat(21), 'bad name', 'admin@x']) {
        expect(() => service.checkUsername(username)).toThrow(
          BadRequestException,
        );
      }
    });

    it('密码需 8-64 位且同时包含字母与数字', () => {
      /** 被测服务 */
      const { service } = serviceOf();
      expect(() => service.checkPassword('abc12345')).not.toThrow();
      // 过短
      expect(() => service.checkPassword('abc1234')).toThrow(
        BadRequestException,
      );
      // 超过上限
      expect(() => service.checkPassword('a1'.repeat(40))).toThrow(
        BadRequestException,
      );
      // 纯字母 / 纯数字
      expect(() => service.checkPassword('abcdefgh')).toThrow(
        BadRequestException,
      );
      expect(() => service.checkPassword('12345678')).toThrow(
        BadRequestException,
      );
    });

    it('密码不允许与用户名相同（忽略大小写）', () => {
      /** 被测服务 */
      const { service } = serviceOf();
      expect(() => service.checkPassword('Admin123', 'admin123')).toThrow(
        BadRequestException,
      );
      expect(() => service.checkPassword('Admin123', 'other')).not.toThrow();
    });

    it('邮箱空串统一转 null（唯一索引下多个空串会互相冲突）', () => {
      /** 被测服务 */
      const { service } = serviceOf();
      expect(service.toEmail(' A@B.com ')).toBe('a@b.com');
      expect(service.toEmail('')).toBeNull();
      expect(service.toEmail('   ')).toBeNull();
      expect(service.toEmail(null)).toBeNull();
      expect(service.toEmail(undefined)).toBeNull();
    });
  });

  describe('valid', () => {
    it('白名单外的有效期回退到默认档位（兼容历史数据）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ id: 1, tokenValid: 3600 });
      expect(await service.valid(1)).toBe(1440);
    });

    it('白名单内的档位原样返回，0 表示长期有效', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ id: 1, tokenValid: 0 });
      expect(await service.valid(1)).toBe(0);
      repository.findOne.mockResolvedValue({ id: 1, tokenValid: 10080 });
      expect(await service.valid(1)).toBe(10080);
    });

    it('用户不存在时 404', async () => {
      /** 被测服务 */
      const { service } = serviceOf();
      await expect(service.valid(1)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('login', () => {
    it('账号处于锁定期时直接 429，不查库也不校验密码', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      redis.ttl.mockResolvedValue(42);
      /** 捕获的异常 */
      const error = await service
        .login({ username: 'admin', password: 'abc12345' })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RetryAfterException);
      expect((error as RetryAfterException).retryAfter).toBe(42);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('账号不存在时返回统一的 401，且不写失败计数', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      /** 捕获的异常 */
      const error = await service
        .login({ username: 'ghost', password: 'abc12345' })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe(
        '用户名或密码不正确！',
      );
      expect(redis.incr).not.toHaveBeenCalled();
    });

    it('用户被禁用时 403', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({
        ...USER,
        password: HASH,
        status: false,
      });
      await expect(
        service.login({ username: 'admin', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('未设置密码的历史账号引导到重置流程（409 而不是 401）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: '' });
      await expect(
        service.login({ username: 'admin', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('密码错误时累计失败次数并记录 10 分钟有效期', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: HASH });
      await expect(
        service.login({ username: 'admin', password: 'wrong123' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(redis.incr).toHaveBeenCalledWith('loginFail:admin');
      expect(redis.expire).toHaveBeenCalledWith(
        'loginFail:admin',
        LOGIN_FAIL_TTL,
      );
    });

    it('连续失败达到上限时锁定账号并清空计数', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: HASH });
      redis.incr.mockResolvedValue(LOGIN_FAIL_MAX);
      /** 捕获的异常 */
      const error = await service
        .login({ username: 'admin', password: 'wrong123' })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RetryAfterException);
      expect((error as RetryAfterException).retryAfter).toBe(LOGIN_LOCK_TTL);
      expect(redis.set).toHaveBeenCalledWith(
        'loginLock:admin',
        '1',
        'EX',
        LOGIN_LOCK_TTL,
      );
      // 锁到期后可重新尝试，计数不能留着
      expect(redis.del).toHaveBeenCalledWith('loginFail:admin');
    });

    it('登录成功：清空失败计数、维护登录统计、清理旧令牌并签发新令牌', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository, operate, queue } = serviceOf();
      repository.findOne
        .mockResolvedValueOnce({ ...USER, password: HASH })
        .mockResolvedValueOnce({ ...USER });
      redis.scanKeys.mockResolvedValue(['token:1:a', 'token:1:b']);
      /** 令牌信息 */
      const result = await service.login(
        { username: 'Admin', password: 'abc12345' },
        88,
        '1.2.3.4',
      );

      expect(result).toEqual({ code: 'NEWCODE' });
      expect(redis.del).toHaveBeenCalledWith('loginFail:admin');
      // 单会话策略：签发前先清掉该用户的全部旧令牌
      expect(redis.scanKeys).toHaveBeenCalledWith('token:1:*');
      expect(operate.create).toHaveBeenCalledWith('user', 'login', 1);
      expect(queue.addTask).toHaveBeenCalled();

      /** 登录统计更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.loginTimes).toBe(4);
      expect(value.firstLoginAt).toBe(111);
      expect(value.lastLoginIp).toBe('1.2.3.4');
      // 有效期按用户设置签发
      expect(redis.addCode).toHaveBeenCalledWith('token:1', 60, 1440, {
        id: 1,
        valid: 1440,
      });
    });

    it('首次登录时登录次数归 1 并记录首次登录时间', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne
        .mockResolvedValueOnce({
          ...USER,
          password: HASH,
          loginTimes: 0,
          firstLoginAt: 0,
        })
        .mockResolvedValueOnce({ ...USER, loginTimes: 0, firstLoginAt: 0 });
      await service.login({ username: 'admin', password: 'abc12345' });
      /** 登录统计更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.loginTimes).toBe(1);
      expect(typeof value.firstLoginAt).toBe('number');
      expect(value.firstLoginAt).toBeGreaterThan(0);
    });

    it('无法解析的脏 IP 不入库（inet 列写入会直接 500）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne
        .mockResolvedValueOnce({ ...USER, password: HASH })
        .mockResolvedValueOnce({ ...USER });
      await service.login(
        { username: 'admin', password: 'abc12345' },
        0,
        'unknown',
      );
      /** 登录统计更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.lastLoginIp).toBeUndefined();
    });
  });

  describe('issueToken', () => {
    it('用户不存在时 404，被禁用时 403', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await expect(service.issueToken(1, 'login')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      repository.findOne.mockResolvedValue({ ...USER, status: false });
      await expect(service.issueToken(1, 'login')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('登录态更新失败时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER });
      repository.update.mockResolvedValue({ affected: 0 });
      await expect(service.issueToken(1, 'login')).rejects.toThrow(
        '登录状态更新失败！',
      );
    });
  });

  describe('register', () => {
    it('默认关闭自助注册（410）', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      /** 捕获的异常 */
      const error = await service
        .register({ username: 'newbie', password: 'abc12345' })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.GONE);
    });

    it('邮箱或用户名重复时 409', async () => {
      process.env.ALLOW_SIGNUP = 'true';
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      await expect(
        service.register({
          username: 'newbie',
          password: 'abc12345',
          email: 'a@b.com',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('用户数达到上限时 409', async () => {
      process.env.ALLOW_SIGNUP = 'true';
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.count.mockResolvedValue(20);
      await expect(
        service.register({ username: 'newbie', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('并发注册撞唯一索引（23505）转为 409 而不是 500', async () => {
      process.env.ALLOW_SIGNUP = 'true';
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.insert.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      await expect(
        service.register({ username: 'newbie', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('注册成功返回新用户ID，并落库为 scrypt 哈希', async () => {
      process.env.ALLOW_SIGNUP = 'true';
      /** 被测服务与替身 */
      const { service, repository, operate } = serviceOf();
      expect(
        await service.register({
          username: 'NewBie',
          password: 'abc12345',
          email: 'A@B.com',
        }),
      ).toBe(5);
      /** 插入数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.username).toBe('newbie');
      expect(value.email).toBe('a@b.com');
      expect(value.name).toBe('newbie');
      expect(String(value.password)).toMatch(/^scrypt\$/);
      expect(operate.create).toHaveBeenCalledWith('user', 'register', 0);
    });
  });

  describe('password', () => {
    it('原密码错误时 400（不是 401，避免前端按登录过期把人踢出去），同一密码时 400', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: HASH });
      await expect(
        service.password(1, {
          oldPassword: 'wrong123',
          newPassword: 'new12345',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.password(1, {
          oldPassword: 'abc12345',
          newPassword: 'abc12345',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('改密成功保留当前会话、作废其它会话', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: HASH });
      redis.scanKeys.mockResolvedValue(['token:1:keep', 'token:1:other']);
      /** 响应报文 */
      const result = await service.password(
        1,
        { oldPassword: 'abc12345', newPassword: 'new12345' },
        '1:keep',
      );
      expect(result.msg).toBe('密码修改成功，已退出1个其它会话！');
      // 只删掉非当前会话的那一个
      /** 管道替身 */
      const pipeline = redis.pipeline.mock.results[0].value as {
        del: ReturnType<typeof vi.fn>;
      };
      expect(pipeline.del).toHaveBeenCalledTimes(1);
      expect(pipeline.del).toHaveBeenCalledWith('token:1:other');
    });
  });

  describe('unlock', () => {
    it('用户不存在时 404，被禁用时 403，未设置密码时 409', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await expect(service.unlock(1, 'abc12345')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      repository.findOne.mockResolvedValue({ ...USER, status: false });
      await expect(service.unlock(1, 'abc12345')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      repository.findOne.mockResolvedValue({ ...USER, password: '' });
      await expect(service.unlock(1, 'abc12345')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('密码错误时 400（不是 401，避免前端按登录过期把人踢出去）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: HASH });
      await expect(
        service.unlock(1, 'wrong123'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('解锁成功：校验密码并刷新最后会话时间，不重新签发令牌', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository, operate } = serviceOf();
      repository.findOne.mockResolvedValue({ ...USER, password: HASH });
      /** 响应报文 */
      const result = await service.unlock(1, 'abc12345');
      expect(result).toEqual({ code: 0, msg: '解锁成功！' });
      // 刷新会话时间
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(typeof value.lastSessionAt).toBe('number');
      // 不签发令牌、不写操作序号
      expect(redis.addCode).not.toHaveBeenCalled();
      expect(operate.create).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('验证码缓存不存在或已过期时 400，过期还要顺手删键', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      await expect(
        service.reset({
          email: 'a@b.com',
          code: '123456',
          password: 'abc12345',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      redis.hgetall.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        captcha: '123456',
        expired: String(Date.now() - 1000),
      });
      await expect(
        service.reset({
          email: 'a@b.com',
          code: '123456',
          password: 'abc12345',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(redis.del).toHaveBeenCalledWith('reset:a@b.com');
    });

    it('验证码错误累计次数，超过上限直接销毁验证码（410）', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      redis.hgetall.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        captcha: '123456',
        expired: String(Date.now() + 60000),
      });
      redis.hincrby.mockResolvedValue(4);
      await expect(
        service.reset({
          email: 'a@b.com',
          code: '000000',
          password: 'abc12345',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      redis.hincrby.mockResolvedValue(5);
      /** 捕获的异常 */
      const error = await service
        .reset({ email: 'a@b.com', code: '000000', password: 'abc12345' })
        .catch((err: unknown) => err);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.GONE);
      expect(redis.del).toHaveBeenCalledWith('reset:a@b.com');
    });

    it('重置成功：更新密码、删验证码并作废该用户全部令牌', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      redis.hgetall.mockResolvedValue({
        id: '1',
        email: 'a@b.com',
        captcha: '123456',
        expired: String(Date.now() + 60000),
      });
      repository.findOne.mockResolvedValue({
        id: 1,
        username: 'admin',
        status: true,
      });
      redis.scanKeys.mockResolvedValue(['token:1:a']);
      /** 响应报文 */
      const result = await service.reset({
        email: 'A@B.com',
        code: ' 123456 ',
        password: 'abc12345',
      });
      expect(result.msg).toBe('密码已重置，请使用新密码登录！');
      expect(redis.del).toHaveBeenCalledWith('reset:a@b.com');
      // 改密后所有旧会话失效
      expect(redis.scanKeys).toHaveBeenCalledWith('token:1:*');
    });
  });

  describe('check', () => {
    it('空用户名视为不存在，不走查库', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      expect(await service.check('   ')).toEqual({ exists: false });
      expect(repository.existsBy).not.toHaveBeenCalled();
    });

    it('按归一化后的用户名查重（不暴露账号状态）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      expect(await service.check(' Admin ')).toEqual({ exists: true });
      expect(repository.existsBy).toHaveBeenCalledWith({ username: 'admin' });
    });

    it('同一 IP 超过每分钟上限时 429', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      redis.incr.mockResolvedValue(4);
      redis.ttl.mockResolvedValue(30);
      /** 捕获的异常 */
      const error = await service
        .check('admin', '1.2.3.4')
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RetryAfterException);
      expect(redis.incr).toHaveBeenCalledWith('limit:ip:check:1.2.3.4');
    });
  });

  describe('setValid', () => {
    it('档位不在白名单时 400，且不查库', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await expect(service.setValid(1, 15)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('用户不存在时 404', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      await expect(service.setValid(1, 60)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('设置成功：记操作序号、写库并排队补日志', async () => {
      /** 被测服务与替身 */
      const { service, repository, operate, queue } = serviceOf();
      repository.findOne.mockResolvedValue({ id: 1, tokenValid: 1440 });
      expect(await service.setValid(1, 60, 88)).toBe(60);
      expect(operate.create).toHaveBeenCalledWith('user', 'valid', 1);
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.tokenValid).toBe(60);
      expect(queue.addTask).toHaveBeenCalled();
    });

    it('影响行数为 0 时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ id: 1, tokenValid: 1440 });
      repository.update.mockResolvedValue({ affected: 0 });
      await expect(service.setValid(1, 60)).rejects.toThrow(
        '令牌有效期设置失败！',
      );
    });
  });

  describe('email', () => {
    it('用户不存在时 404', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      await expect(service.email(1, 'a@b.com')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('邮箱未变化时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({
        id: 1,
        username: 'admin',
        status: true,
        email: 'a@b.com',
      });
      await expect(service.email(1, ' A@B.com ')).rejects.toThrow(
        '邮箱并未发生变化，无需修改！',
      );
    });

    it('邮箱已被占用时 409', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({
        id: 1,
        username: 'admin',
        status: true,
        email: 'old@b.com',
      });
      repository.existsBy.mockResolvedValue(true);
      await expect(service.email(1, 'new@b.com')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('成功时生成激活码并发送含激活链接的邮件', async () => {
      process.env.WEB_URL = 'http://web/';
      /** 被测服务与替身 */
      const { service, repository, redis, email } = serviceOf();
      repository.findOne.mockResolvedValue({
        id: 1,
        username: 'admin',
        status: true,
        email: 'old@b.com',
      });
      redis.addCode.mockResolvedValue({ code: 'CODE123' });
      expect(await service.email(1, ' New@B.com ')).toBe(1);
      // 激活码缓存 30 分钟，携带用户ID与目标邮箱
      expect(redis.addCode).toHaveBeenCalledWith('activate', 100, 30, {
        id: 1,
        email: 'new@b.com',
      });
      /** 邮件内容 */
      const mail = email.send.mock.calls[0][0] as { to: string; html: string };
      expect(mail.to).toBe('new@b.com');
      expect(mail.html).toContain('http://web/passport/activate/CODE123');
      delete process.env.WEB_URL;
    });

    it('同一 IP 超过每分钟上限时 429', async () => {
      /** 被测服务与替身 */
      const { service, redis } = serviceOf();
      redis.incr.mockResolvedValue(4);
      redis.ttl.mockResolvedValue(20);
      /** 捕获的异常 */
      const error = await service
        .email(1, 'a@b.com', '1.2.3.4')
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(RetryAfterException);
      expect(redis.incr).toHaveBeenCalledWith('limit:ip:email:1.2.3.4');
    });
  });

  describe('activate', () => {
    it('激活码不存在或已过期时 404', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      await expect(service.activate('CODE')).rejects.toThrow(
        '激活地址已过期！',
      );
    });

    it('用户不存在时 404，被禁用时 401', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      redis.hgetall.mockResolvedValue({ id: '1', email: 'a@b.com' });
      await expect(service.activate('CODE')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      repository.findOne.mockResolvedValue({
        id: 1,
        email: null,
        status: false,
        roles: [],
      });
      await expect(service.activate('CODE')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('目标邮箱已被他人占用时 409', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      redis.hgetall.mockResolvedValue({ id: '1', email: 'a@b.com' });
      repository.findOne.mockResolvedValue({
        id: 1,
        email: null,
        status: true,
        roles: [],
      });
      repository.existsBy.mockResolvedValue(true);
      await expect(service.activate('CODE')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('成功时写入新邮箱、删除激活码并返回提示', async () => {
      /** 被测服务与替身 */
      const { service, redis, repository } = serviceOf();
      redis.hgetall.mockResolvedValue({ id: '1', email: 'a@b.com' });
      repository.findOne.mockResolvedValue({
        id: 1,
        email: null,
        status: true,
        roles: [],
      });
      /** 响应报文 */
      const result = await service.activate('CODE', 88);
      expect(result.msg).toContain('a@b.com');
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.email).toBe('a@b.com');
      expect(redis.del).toHaveBeenCalledWith('activate:CODE');
    });
  });

  describe('session', () => {
    it('只更新最后会话时间，不写操作序号', async () => {
      /** 被测服务与替身 */
      const { service, repository, operate } = serviceOf();
      await service.session(1);
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(typeof value.lastSessionAt).toBe('number');
      expect(operate.create).not.toHaveBeenCalled();
    });
  });
});
