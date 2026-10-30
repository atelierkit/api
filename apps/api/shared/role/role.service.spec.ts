// 外部依赖
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import { RoleEntity, RoleLogEntity } from './role.entity.js';
import { RoleService } from './role.service.js';

/**
 * 组装被测服务
 *
 * @returns 被测服务与全部替身
 */
function serviceOf() {
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async (..._args: unknown[]) => 7) };
  /** 队列服务替身 */
  const queueSrv = {
    addTask: vi.fn((_task: () => Promise<unknown>) => undefined),
  };
  /** 角色存储器替身 */
  const repository = {
    existsBy: vi.fn(async (_where: unknown) => false),
    insert: vi.fn(async (_value: unknown) => ({ identifiers: [1] })),
    save: vi.fn(async (_values: unknown) => []),
    metadata: { tableName: 'roles', columns: [] as unknown[] },
  };
  /** 角色日志存储器替身 */
  const logRepository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    query: vi.fn(async (_sql: string, _params: unknown[]) => [] as unknown[]),
    metadata: { tableName: 'roles_logs', columns: [] as unknown[] },
  };
  /** 被测服务 */
  const service = new RoleService(
    operateSrv as unknown as OperateService,
    queueSrv as unknown as QueueService,
    repository as unknown as Repository<RoleEntity>,
    logRepository as unknown as Repository<RoleLogEntity>,
  );
  return { service, operateSrv, queueSrv, repository };
}

describe('RoleService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('onApplicationBootstrap', () => {
    it('管理员角色已存在时不重复创建', async () => {
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      await service.onApplicationBootstrap();
      expect(repository.existsBy).toHaveBeenCalledWith({ id: 'admin' });
      expect(repository.insert).not.toHaveBeenCalled();
    });

    it('缺少管理员角色时自动补建（否则没人能进管理后台）', async () => {
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      /** 被测服务与替身 */
      const { service, repository, operateSrv } = serviceOf();
      await service.onApplicationBootstrap();
      /** 插入数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.id).toBe('admin');
      expect(value.name).toBe('管理员');
      expect(value.status).toBe(true);
      expect(value.sort).toBe(1);
      expect(operateSrv.create).toHaveBeenCalledWith('role', 'create', 0);
    });

    it('初始化失败只记日志，不影响服务启动', async () => {
      /** 错误日志桩 */
      const log = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockRejectedValue(new Error('数据库不可用'));
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalled();
    });
  });

  describe('sort', () => {
    it('按入参顺序批量落库，并写入统一的更新元信息', async () => {
      /** 被测服务与替身 */
      const { service, repository, operateSrv } = serviceOf();
      expect(
        await service.sort(
          [
            { id: 'admin', sort: 2 },
            { id: 'viewer', sort: 1 },
          ],
          3,
          88,
        ),
      ).toEqual({ length: 2 });
      expect(operateSrv.create).toHaveBeenCalledWith('role', 'sort', 3);
      /** 落库数据 */
      const values = repository.save.mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(values).toHaveLength(2);
      expect(values[1].id).toBe('viewer');
      /** 更新信息 */
      const update = values[0].update as Record<string, unknown>;
      expect(update.operate).toBe('sort');
      expect(update.operateId).toBe(7);
      expect(update.reqId).toBe(88);
    });
  });
});
