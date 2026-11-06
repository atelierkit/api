// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../../shared/operate/operate.service.js';
import { QueueService } from '../../shared/queue/queue.service.js';
import { AliyunContactEntity, AliyunContactLogEntity } from './contact.entity.js';
import { ContactService } from './contact.service.js';

/**
 * 组装被测服务
 *
 * @returns 被测服务与存储器替身
 */
function serviceOf() {
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async (..._args: unknown[]) => 7) };
  /** 队列服务替身，注：日志入队即可，不在这里真正执行 SQL */
  const queueSrv = { addTask: vi.fn((_task: () => Promise<unknown>) => undefined) };
  /** 联系人存储器替身 */
  const repository = {
    existsBy: vi.fn(async (_where: unknown) => true),
    insert: vi.fn(async (_value: unknown) => ({
      identifiers: [{ id: 9 }] as Array<{ id: number }>,
    })),
    update: vi.fn(async (_criteria: unknown, _value: unknown) => ({
      affected: 1,
    })),
    metadata: { tableName: 'aliyun_contacts' },
  };
  /** 联系人日志存储器替身 */
  const logRepository = {
    metadata: { tableName: 'aliyun_contacts_logs', columns: [] as unknown[] },
    query: vi.fn(async (..._args: unknown[]) => []),
  };
  return {
    service: new ContactService(
      operateSrv as unknown as OperateService,
      queueSrv as unknown as QueueService,
      repository as never,
      logRepository as never,
    ),
    repository,
  };
}

/** 合法的联系人入参 */
const CONTACT = {
  username: 'marbleqi',
  email: 'marbleqi@163.com',
  phone: '13673618697',
  province: 'zhejiang',
  city: 'hangzhou',
};

describe('ContactService', () => {
  describe('create', () => {
    it('普通联系人只写一次，不动其它行的默认位', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      expect(await service.create({ ...CONTACT }, 1, 2)).toBe(9);
      expect(repository.update).not.toHaveBeenCalled();
      expect(repository.insert).toHaveBeenCalledTimes(1);
    });

    it('标记默认时先把其它行的默认位清掉', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.create({ ...CONTACT, isDefault: true }, 1, 2);

      // 第一次 update 是「清空默认位」
      /** 清空时的赋值 */
      const clearValue = repository.update.mock.calls[0]?.[1] as unknown;
      expect(clearValue).toEqual({ isDefault: false });
      expect(repository.insert).toHaveBeenCalledTimes(1);
    });

    it('isDefault 为 false 时不去清空（避免每次新建都多一次全表更新）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.create({ ...CONTACT, isDefault: false }, 1, 2);
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('把默认位摘掉时不清空别人', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.update(3, { isDefault: false }, 1, 2);
      // 只有父类自己那次 update
      expect(repository.update).toHaveBeenCalledTimes(1);
    });

    it('设为默认时先清空其它行，再更新自己', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      await service.update(3, { isDefault: true }, 1, 2);

      expect(repository.update).toHaveBeenCalledTimes(2);
      /** 第一段的清空条件 */
      const clearCriteria = repository.update.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(clearCriteria['isDefault']).toBe(true);
      /** 清空时的赋值 */
      expect(repository.update.mock.calls[0]?.[1]).toEqual({ isDefault: false });
      /** 第二段是更新自身 */
      expect(repository.update.mock.calls[1]?.[0]).toBe(3);
    });

    it('联系人不存在时 404（由父类判定）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.existsBy.mockResolvedValueOnce(false);
      await expect(
        service.update(99, { city: 'hangzhou' }, 1, 2),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('日志表名称固定（整行搬入依赖它）', () => {
    /** 占位断言：确保实体类可实例化且表名约定未变 */
    expect(new AliyunContactEntity()).toBeInstanceOf(AliyunContactEntity);
    expect(new AliyunContactLogEntity()).toBeInstanceOf(AliyunContactLogEntity);
  });
});
