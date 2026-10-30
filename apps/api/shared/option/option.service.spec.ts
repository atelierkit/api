// 外部依赖
import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import {
  OptionEntity,
  OptionEntityLog,
  OptionService,
} from './option.service.js';

/** 配置对象的测试实现（以 code 为主键，与 settings 表一致） */
class TestOptionService extends OptionService<OptionEntity, OptionEntityLog> {
  protected keyName = 'code';
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
    repository: Repository<OptionEntity>,
    logRepository: Repository<OptionEntityLog>,
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
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async (..._args: unknown[]) => 7) };
  /** 队列服务替身 */
  const queueSrv = {
    addTask: vi.fn((_task: () => Promise<unknown>) => undefined),
  };
  /** 对象存储器替身 */
  const repository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    findOneBy: vi.fn(async (_where: unknown) => null as unknown),
    existsBy: vi.fn(async (_where: unknown) => false),
    count: vi.fn(async () => 3),
    insert: vi.fn(async (_value: unknown) => ({ identifiers: [1] })),
    update: vi.fn(async (_criteria: unknown, _value: unknown) => ({
      affected: 1,
    })),
    metadata: { tableName: 'settings', columns: [] as unknown[] },
  };
  /** 对象日志存储器替身 */
  const logRepository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    query: vi.fn(async (_sql: string, _params: unknown[]) => [] as unknown[]),
    metadata: { tableName: 'settings_logs', columns: [] as unknown[] },
  };
  /** 被测服务 */
  const service = new TestOptionService(
    operateSrv as unknown as OperateService,
    queueSrv as unknown as QueueService,
    repository as unknown as Repository<OptionEntity>,
    logRepository as unknown as Repository<OptionEntityLog>,
  );
  return { service, operateSrv, queueSrv, repository, logRepository };
}

describe('OptionService', () => {
  describe('create', () => {
    it('主键已存在时 422，且不创建操作序号', async () => {
      /** 被测服务与替身 */
      const { service, repository, operateSrv } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      await expect(service.create({ code: 'init' })).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(operateSrv.create).not.toHaveBeenCalled();
    });

    it('创建成功返回主键并写入创建/更新元信息', async () => {
      /** 被测服务与替身 */
      const { service, repository, queueSrv } = serviceOf();
      expect(await service.create({ code: 'init', value: {} }, 3, 88)).toEqual({
        code: 'init',
      });
      /** 插入数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      /** 更新信息 */
      const update = value.update as Record<string, unknown>;
      expect(update.operate).toBe('create');
      expect(update.operateId).toBe(7);
      expect(update.reqId).toBe(88);
      expect(queueSrv.addTask).toHaveBeenCalled();
    });

    it('未取到主键时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.insert.mockResolvedValue({ identifiers: [] });
      await expect(service.create({ code: 'init' })).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe('update', () => {
    it('原主键不存在时 404', async () => {
      /** 被测服务与替身 */
      const { service, repository, operateSrv } = serviceOf();
      repository.existsBy.mockResolvedValue(false);
      await expect(
        service.update('init', { code: 'init' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(operateSrv.create).not.toHaveBeenCalled();
    });

    it('主键被修改且新键已存在时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository, operateSrv } = serviceOf();
      // 第一次校验原键存在，第二次校验新键已被占用
      repository.existsBy
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      await expect(
        service.update('init', { code: 'used' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.existsBy).toHaveBeenCalledTimes(2);
      expect(operateSrv.create).not.toHaveBeenCalled();
    });

    it('主键未变时不再校验新键冲突', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      await service.update('init', { code: 'init' });
      expect(repository.existsBy).toHaveBeenCalledTimes(1);
    });

    it('更新成功返回主键，并按原主键定位记录', async () => {
      /** 被测服务与替身 */
      const { service, repository, queueSrv } = serviceOf();
      // 仅原键存在，新键未被占用
      repository.existsBy.mockResolvedValueOnce(true);
      expect(await service.update('init', { code: 'init2' }, 3, 88)).toEqual({
        code: 'init2',
      });
      expect(repository.update).toHaveBeenCalledWith(
        { code: 'init' },
        expect.objectContaining({ code: 'init2' }),
      );
      /** 更新数据 */
      const value = repository.update.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      /** 更新信息 */
      const update = value.update as Record<string, unknown>;
      expect(update.operate).toBe('update');
      expect(queueSrv.addTask).toHaveBeenCalled();
    });

    it('影响行数为 0 时 422', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValue(true);
      repository.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.update('init', { code: 'init' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('查询代理', () => {
    it('详情与日志按 keyName 定位', async () => {
      /** 被测服务与替身 */
      const { service, repository, logRepository } = serviceOf();
      await service.show('init');
      expect(repository.findOneBy).toHaveBeenCalledWith({ code: 'init' });
      await service.log('init');
      expect(logRepository.findBy).toHaveBeenCalledWith({ code: 'init' });
    });

    it('记录数直接委托存储器', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      expect(await service.count()).toBe(3);
    });
  });
});
