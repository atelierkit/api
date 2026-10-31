// 外部依赖
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { EmailService } from '../email/email.service.js';
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import { RedisService } from '../redis/redis.service.js';
import { verifyPassword } from './password.util.js';
import { USER_MAX } from './user.constant.js';
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
 * 组装被测服务
 *
 * @returns 被测服务与全部替身
 */
function serviceOf() {
  /** 缓存替身 */
  const redis = { del: vi.fn(async (_key: string) => 1) };
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
  return { service, operate, queue, repository };
}

/** 库中已有的用户（管理端改资料时按 id 查出） */
const EXIST = {
  id: 5,
  username: 'dev_01',
  email: null,
  status: true,
  roles: [] as string[],
};

describe('UserService 管理端建号与改资料', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('归一化用户名、哈希密码，昵称缺省取用户名，其余字段给默认值', async () => {
      /** 被测服务与替身 */
      const { service, repository, operate, queue } = serviceOf();
      /** 新用户ID */
      const id = await service.create(
        { username: ' Dev_01 ', password: 'abc12345' },
        7,
        9,
      );
      expect(id).toBe(5);
      /** 落库数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.username).toBe('dev_01');
      // 密码必须是可校验的 scrypt 哈希，不是明文
      expect(value.password).not.toBe('abc12345');
      expect(await verifyPassword('abc12345', value.password as string)).toBe(
        true,
      );
      expect(typeof value.passwordAt).toBe('number');
      expect(value.name).toBe('dev_01');
      expect(value.avatar).toBe('');
      expect(value.email).toBeNull();
      expect(value.roles).toEqual([]);
      expect(value.status).toBe(true);
      // 操作序号与日志按管理端操作人记账
      expect(operate.create).toHaveBeenCalledWith('user', 'create', 7);
      expect(queue.addTask).toHaveBeenCalledTimes(1);
    });

    it('邮箱归一化后落库，空串转 NULL（避免撞唯一索引）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.create({
        username: 'dev_01',
        password: 'abc12345',
        email: ' Dev_01@Example.COM ',
      });
      /** 落库数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.email).toBe('dev_01@example.com');
      await service.create({
        username: 'dev_02',
        password: 'abc12345',
        email: '',
      });
      /** 第二次落库数据 */
      const again = repository.insert.mock.calls[1][0] as Record<
        string,
        unknown
      >;
      expect(again.email).toBeNull();
    });

    it('显式提交的昵称、头像、角色与状态原样生效', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.create({
        username: 'dev_01',
        password: 'abc12345',
        name: ' 开发 ',
        avatar: ' /avatar.png ',
        roles: ['dev'],
        status: false,
      });
      /** 落库数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.name).toBe('开发');
      expect(value.avatar).toBe('/avatar.png');
      expect(value.roles).toEqual(['dev']);
      expect(value.status).toBe(false);
    });

    it('用户名不合规时直接拒绝，不查库', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await expect(
        service.create({ username: '管理', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.existsBy).not.toHaveBeenCalled();
    });

    it('密码不合规时直接拒绝', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      await expect(
        service.create({ username: 'dev_01', password: '12345678' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('用户名已存在时拒绝', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      await expect(
        service.create({ username: 'dev_01', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('邮箱已被使用时拒绝', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockImplementation(
        async (where: unknown) => 'email' in (where as Record<string, unknown>),
      );
      await expect(
        service.create({
          username: 'dev_01',
          password: 'abc12345',
          email: 'a@b.com',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('用户数达到上限时拒绝', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.count.mockResolvedValue(USER_MAX);
      await expect(
        service.create({ username: 'dev_01', password: 'abc12345' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.insert).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('只写入提交了的字段，昵称与头像去首尾空格', async () => {
      /** 被测服务与替身 */
      const { service, repository, operate } = serviceOf();
      repository.findOne.mockResolvedValue({ ...EXIST });
      repository.existsBy.mockResolvedValue(true);
      expect(
        await service.update(5, { name: ' 开发 ', avatar: ' /a.png ' }, 7, 9),
      ).toBe(5);
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.name).toBe('开发');
      expect(value.avatar).toBe('/a.png');
      expect('email' in value).toBe(false);
      expect('status' in value).toBe(false);
      expect('roles' in value).toBe(false);
      expect(operate.create).toHaveBeenCalledWith('user', 'update', 7);
    });

    it('可以禁用用户并调整角色', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...EXIST });
      repository.existsBy.mockResolvedValue(true);
      await service.update(5, { status: false, roles: ['dev'] }, 7, 9);
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.status).toBe(false);
      expect(value.roles).toEqual(['dev']);
    });

    it('清空邮箱时落库为 NULL', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...EXIST, email: 'a@b.com' });
      repository.existsBy.mockResolvedValue(true);
      await service.update(5, { email: '' }, 7, 9);
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(value.email).toBeNull();
    });

    it('沿用原邮箱不查重也不报错', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...EXIST, email: 'a@b.com' });
      repository.existsBy.mockResolvedValue(true);
      await service.update(5, { email: 'a@b.com' }, 7, 9);
      // 仅基类的「对象是否存在」查了一次
      expect(repository.existsBy).toHaveBeenCalledTimes(1);
    });

    it('邮箱被其他用户占用时拒绝', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ ...EXIST, email: 'a@b.com' });
      repository.existsBy.mockResolvedValue(true);
      await expect(
        service.update(5, { email: 'c@d.com' }, 7, 9),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('用户不存在时抛 404', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      await expect(
        service.update(5, { name: '开发' }, 7, 9),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
