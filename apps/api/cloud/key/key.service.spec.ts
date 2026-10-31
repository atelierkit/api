// 外部依赖
import { FindOperator, FindOptionsUtils, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../../shared/operate/operate.service.js';
import { QueueService } from '../../shared/queue/queue.service.js';
import { KeyEntity, KeyLogEntity } from './key.entity.js';
import { KeyService } from './key.service.js';

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
  /** 密钥存储器替身 */
  const repository = {
    find: vi.fn(async (_options: unknown) => [] as unknown[]),
    findOne: vi.fn(async (_options: unknown) => null as unknown),
    count: vi.fn(async () => 1),
    insert: vi.fn(async (_value: unknown) => ({
      identifiers: [{ id: 9 }] as Array<{ id: number }>,
    })),
    update: vi.fn(async (_criteria: unknown, _value: unknown) => ({
      affected: 1,
    })),
    metadata: { tableName: 'cloud_keys', columns: [] as unknown[] },
  };
  /** 密钥日志存储器替身 */
  const logRepository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    query: vi.fn(async (_sql: string, _params: unknown[]) => [] as unknown[]),
    metadata: { tableName: 'cloud_keys_logs', columns: [] as unknown[] },
  };
  /** 被测服务 */
  const service = new KeyService(
    operateSrv as unknown as OperateService,
    queueSrv as unknown as QueueService,
    repository as unknown as Repository<KeyEntity>,
    logRepository as unknown as Repository<KeyLogEntity>,
  );
  return { service, tasks, operateSrv, repository };
}

describe('KeyService', () => {
  describe('index', () => {
    it('不带 operateId 时取全量（-1）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.index();
      /** 查询条件 */
      const options = repository.find.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      /** 增量条件 */
      const update = (options.where as Record<string, Record<string, unknown>>)
        .update;
      const operateId = update.operateId as FindOperator<number>;
      expect(operateId).toBeInstanceOf(FindOperator);
      expect(operateId.value).toBe(-1);
    });

    it('按 operateId 做增量查询，并固定 id 升序（列表顺序稳定）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.index(12);
      /** 查询条件 */
      const options = repository.find.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(options.order).toEqual({ id: 'ASC' });
      /** 增量条件 */
      const update = (options.where as Record<string, Record<string, unknown>>)
        .update;
      const operateId = update.operateId as FindOperator<number>;
      expect(operateId.type).toBe('moreThan');
      expect(operateId.value).toBe(12);
    });

    it('清单不下发 secret（访问密钥只在服务端内部使用）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.index();
      /** 查询条件 */
      const options = repository.find.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      /** 选中的字段，注：TypeORM v1 只认对象写法，字符串数组会在运行时直接抛错 */
      const select = options.select as Record<string, unknown>;
      expect(select['key']).toBe(true);
      expect(select['secret']).toBeUndefined();
      // 嵌入列要展开成嵌套对象，否则 select 不到 create.at / update.at
      expect(select['update']).toEqual({
        userId: true,
        operate: true,
        operateId: true,
        reqId: true,
        at: true,
      });
      // 注：直接用 TypeORM 自己的 v1 校验兜住写法 —— 替身单测最容易漏掉这类「只在真机才报」的错
      expect(() => FindOptionsUtils.rejectStringArraySelect(options)).not.toThrow();
    });
  });

  describe('show', () => {
    it('详情同样不下发 secret', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.show(3);
      /** 查询条件 */
      const options = repository.findOne.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect((options.select as Record<string, unknown>)['secret']).toBeUndefined();
      expect(options.where).toEqual({ id: 3 });
    });
  });

  describe('secret', () => {
    it('只取 id 与 secret（供服务端内部调用云厂商接口）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.findOne.mockResolvedValue({ id: 3, secret: 'S3CR3T' });
      expect(await service.secret(3)).toBe('S3CR3T');
      /** 查询条件 */
      const options = repository.findOne.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(options.select).toEqual({ id: true, secret: true });
      expect(() => FindOptionsUtils.rejectStringArraySelect(options)).not.toThrow();
    });

    it('密钥不存在时返回 null', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      expect(await service.secret(404)).toBeNull();
    });
  });

  describe('继承自 CommonService 的写操作', () => {
    it('操作记录用领域名 key 记账（操作日志页据此显示对象类型）', async () => {
      /** 被测服务与替身 */
      const { service, operateSrv, repository } = serviceOf();
      expect(
        await service.create(
          {
            name: '腾讯云主账号',
            description: '部署 CDN 用',
            provider: 'tencent',
            key: 'AKIDEXAMPLE',
            secret: 'SECRETEXAMPLE',
            status: true,
          },
          3,
          88,
        ),
      ).toBe(9);
      expect(operateSrv.create).toHaveBeenCalledWith('key', 'create', 3);
      /** 插入数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.provider).toBe('tencent');
      expect(value.secret).toBe('SECRETEXAMPLE');
    });
  });
});
