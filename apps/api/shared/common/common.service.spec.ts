// 外部依赖
import { FindOperator, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import {
  CommonEntity,
  CommonEntityLog,
  CommonService,
} from './common.service.js';

/** 测试实体 */
type TestEntity = CommonEntity & { code: string };

/** 测试日志实体 */
type TestLogEntity = CommonEntityLog & { code: string };

/** 通用服务的测试实现 */
class TestCommonService extends CommonService<TestEntity, TestLogEntity> {
  protected name = 'setting';

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param repository 对象存储器
   * @param logRepository 对象日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    repository: Repository<TestEntity>,
    logRepository: Repository<TestLogEntity>,
  ) {
    super(operateSrv, queueSrv, repository, logRepository);
  }
}

/**
 * 组装被测服务
 *
 * @returns 被测服务与全部替身
 */
function serviceOf() {
  /** 排队中的任务 */
  const tasks: Array<() => Promise<unknown>> = [];
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async (..._args: unknown[]) => 7) };
  /** 队列服务替身 */
  const queueSrv = {
    addTask: vi.fn((task: () => Promise<unknown>) => tasks.push(task)),
  };
  /** 对象存储器替身 */
  const repository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    findOneBy: vi.fn(async (_where: unknown) => null as unknown),
    existsBy: vi.fn(async (_where: unknown) => true),
    count: vi.fn(async () => 3),
    insert: vi.fn(async (_value: unknown) => ({
      identifiers: [{ id: 9 }] as Array<{ id: number }>,
    })),
    update: vi.fn(async (_criteria: unknown, _value: unknown) => ({
      affected: 1,
    })),
    metadata: { tableName: 'settings', columns: [] as unknown[] },
  };
  /** 对象日志存储器替身 */
  const logRepository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    query: vi.fn(async (_sql: string, _params: unknown[]) => [] as unknown[]),
    metadata: {
      tableName: 'settings_logs',
      columns: [
        { databaseName: 'log_id' },
        { databaseName: 'code' },
        { databaseName: 'status' },
      ],
    },
  };
  /** 被测服务 */
  const service = new TestCommonService(
    operateSrv as unknown as OperateService,
    queueSrv as unknown as QueueService,
    repository as unknown as Repository<TestEntity>,
    logRepository as unknown as Repository<TestLogEntity>,
  );
  return { service, tasks, operateSrv, repository, logRepository };
}

describe('CommonService', () => {
  describe('create', () => {
    it('写入创建/更新元信息并返回新主键', async () => {
      /** 被测服务与替身 */
      const { service, operateSrv, repository } = serviceOf();
      expect(await service.create({ code: 'a' }, 3, 88)).toBe(9);
      expect(operateSrv.create).toHaveBeenCalledWith('setting', 'create', 3);
      /** 插入数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.id).toBeUndefined();
      expect(value.code).toBe('a');
      /** 创建信息 */
      const create = value.create as Record<string, unknown>;
      expect(create.userId).toBe(3);
      /** 更新信息 */
      const update = value.update as Record<string, unknown>;
      expect(update.operate).toBe('create');
      expect(update.operateId).toBe(7);
      expect(update.reqId).toBe(88);
    });

    it('未取到主键时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.insert.mockResolvedValue({ identifiers: [] });
      await expect(service.create({ code: 'a' })).rejects.toThrow(
        '对象创建失败！',
      );
    });

    it('日志写入走异步队列，SQL 按日志表列名对齐并剔除 log_id', async () => {
      /** 被测服务与替身 */
      const { service, tasks, logRepository } = serviceOf();
      await service.create({ code: 'a' });
      expect(tasks).toHaveLength(1);
      // 主流程不等待日志写入
      await tasks[0]();
      expect(logRepository.query).toHaveBeenCalledTimes(1);
      /** 日志SQL与参数 */
      const [sql, params] = logRepository.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO "settings_logs" ("code", "status")');
      expect(sql).toContain('FROM "settings"');
      expect(sql).not.toContain('"log_id"');
      expect(params).toEqual([7]);
    });
  });

  describe('update', () => {
    it('对象不存在时 404，且不创建操作序号', async () => {
      /** 被测服务与替身 */
      const { service, repository, operateSrv } = serviceOf();
      repository.existsBy.mockResolvedValue(false);
      await expect(service.update(1, { code: 'b' })).rejects.toThrow(
        '当前对象不存在！',
      );
      expect(operateSrv.create).not.toHaveBeenCalled();
    });

    it('更新成功返回 ID 并写入更新元信息', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      expect(await service.update(1, { code: 'b' }, 3, 88)).toBe(1);
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      /** 更新信息 */
      const update = value.update as Record<string, unknown>;
      expect(update.operate).toBe('update');
      expect(update.operateId).toBe(7);
    });

    it('影响行数为 0 时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.update.mockResolvedValue({ affected: 0 });
      await expect(service.update(1, { code: 'b' })).rejects.toThrow(
        '更新对象信息失败！',
      );
    });
  });

  describe('查询代理', () => {
    it('清单按操作序号取增量（operateId 大于入参）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.index(5);
      /** 查询条件 */
      const where = repository.findBy.mock.calls[0][0] as {
        update: { operateId: FindOperator<number> };
      };
      expect(where.update.operateId).toBeInstanceOf(FindOperator);
      expect(where.update.operateId.value).toBe(5);
    });

    it('记录数、详情与日志直接委托存储器', async () => {
      /** 被测服务与替身 */
      const { service, repository, logRepository } = serviceOf();
      expect(await service.count()).toBe(3);
      await service.show(1);
      expect(repository.findOneBy).toHaveBeenCalledWith({ id: 1 });
      await service.log(1);
      expect(logRepository.findBy).toHaveBeenCalledWith({ id: 1 });
    });
  });
});
