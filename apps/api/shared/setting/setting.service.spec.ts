// 外部依赖
import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';
import { SettingEntity, SettingLogEntity } from './setting.entity.js';
import { SettingService } from './setting.service.js';

/**
 * 组装被测服务
 *
 * @returns 被测服务与替身
 */
function serviceOf() {
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async (..._args: unknown[]) => 7) };
  /** 队列服务替身 */
  const queueSrv = {
    addTask: vi.fn((_task: () => Promise<unknown>) => undefined),
  };
  /** 配置存储器替身 */
  const repository = {
    findOneBy: vi.fn(async (_where: unknown) => null as unknown),
    existsBy: vi.fn(async (_where: unknown) => false),
    count: vi.fn(async () => 5),
    insert: vi.fn(async (_value: unknown) => ({ identifiers: [1] })),
    metadata: { tableName: 'settings', columns: [] as unknown[] },
  };
  /** 配置日志存储器替身 */
  const logRepository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    query: vi.fn(async (_sql: string, _params: unknown[]) => [] as unknown[]),
    metadata: { tableName: 'settings_logs', columns: [] as unknown[] },
  };
  /** 被测服务 */
  const service = new SettingService(
    operateSrv as unknown as OperateService,
    queueSrv as unknown as QueueService,
    repository as unknown as Repository<SettingEntity>,
    logRepository as unknown as Repository<SettingLogEntity>,
  );
  return { service, operateSrv, repository };
}

describe('SettingService', () => {
  it('以 code 为主键查询配置', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    repository.findOneBy.mockResolvedValue({
      code: 'app',
      value: { name: 'x' },
    });
    expect(await service.show('app')).toEqual({
      code: 'app',
      value: { name: 'x' },
    });
    expect(repository.findOneBy).toHaveBeenCalledWith({ code: 'app' });
  });

  it('创建配置时以 code 判重，日志对象名固定为 setting', async () => {
    /** 被测服务与替身 */
    const { service, operateSrv } = serviceOf();
    expect(await service.create({ code: 'init', value: {} })).toEqual({
      code: 'init',
    });
    expect(operateSrv.create).toHaveBeenCalledWith('setting', 'create', 0);
  });

  it('记录数直接委托存储器', async () => {
    /** 被测服务与替身 */
    const { service } = serviceOf();
    expect(await service.count()).toBe(5);
  });
});
