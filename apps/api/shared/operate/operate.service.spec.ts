// 外部依赖
import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { UserEntity } from '../user/user.entity.js';
import { OperateEntity } from './operate.entity.js';
import { OperateService } from './operate.service.js';

/** 默认查询时间窗（与实现一致） */
const DAY = 24 * 60 * 60 * 1000;

/**
 * 构造查询构造器替身
 *
 * @param rows 明细查询返回的记录
 * @returns 可链式调用的构造器替身
 */
function builderOf(rows: Array<Record<string, unknown>> = []) {
  /** 构造器替身 */
  const qb: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of [
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'select',
  ]) {
    qb[method] = vi.fn();
    qb[method].mockReturnValue(qb);
  }
  qb.getManyAndCount = vi.fn(async () => [rows, rows.length]);
  qb.getRawMany = vi.fn(async () => []);
  return qb as unknown as {
    where: ReturnType<typeof vi.fn>;
    andWhere: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    addOrderBy: ReturnType<typeof vi.fn>;
    skip: ReturnType<typeof vi.fn>;
    take: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    getManyAndCount: ReturnType<typeof vi.fn>;
    getRawMany: ReturnType<typeof vi.fn>;
  };
}

/**
 * 组装被测服务
 *
 * @param options 明细记录与用户清单
 * @returns 被测服务与替身
 */
function serviceOf(
  options: { rows?: Array<Record<string, unknown>>; users?: unknown[] } = {},
) {
  /** 构造器替身 */
  const qb = builderOf(options.rows);
  /** 操作日志存储器替身 */
  const repository = {
    createQueryBuilder: vi.fn(() => qb),
    findOneBy: vi.fn(async (_where: unknown) => null as unknown),
    insert: vi.fn(async (_value: unknown) => ({
      identifiers: [{ id: 12 }] as Array<{ id: number }>,
    })),
  };
  /** 用户存储器替身 */
  const userRepository = {
    find: vi.fn(async (_options: unknown) => options.users ?? []),
  };
  /** 被测服务 */
  const service = new OperateService(
    repository as unknown as Repository<OperateEntity>,
    userRepository as unknown as Repository<UserEntity>,
  );
  return { service, qb, repository, userRepository };
}

/** 一条操作记录 */
const RECORD = {
  id: 1,
  name: 'user',
  operate: 'create',
  userId: 1,
  remark: '',
  at: 1700000000000,
};

describe('OperateService', () => {
  describe('index', () => {
    it('缺省时间窗为最近 24 小时，分页默认第 1 页 20 条', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({});
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      /** 时间窗参数 */
      const params = qb.where.mock.calls[0][1] as {
        start: number;
        end: number;
      };
      expect(params.end - params.start).toBe(DAY);
    });

    it('每页条数封顶 100（防止一次拉全表）', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ ps: 500 });
      expect(qb.take).toHaveBeenCalledWith(100);
    });

    it('页码与条数非法时回退默认值，翻页偏移按 (pi-1)*ps 计算', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ pi: 0, ps: 0 });
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);

      await service.index({ pi: 3, ps: 10 });
      expect(qb.skip).toHaveBeenLastCalledWith(20);
    });

    it('userId 为 0 时同样作为筛选条件（系统操作是有意义的值）', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ userId: 0 });
      expect(qb.andWhere).toHaveBeenCalledWith('operate.user_id = :userId', {
        userId: 0,
      });
    });

    it('userId 缺省时不追加该筛选条件', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({});
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('操作对象与操作类型按精确匹配筛选', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ name: 'user', operate: 'create' });
      expect(qb.andWhere).toHaveBeenCalledWith('operate.name = :name', {
        name: 'user',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('operate.operate = :operate', {
        operate: 'create',
      });
    });

    it('补齐操作用户邮箱，邮箱为空时退回用户名，系统操作留空', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf({
        rows: [
          { ...RECORD, id: 1, userId: 1 },
          { ...RECORD, id: 2, userId: 2 },
          { ...RECORD, id: 3, userId: 0 },
        ],
        users: [
          { id: 1, email: 'a@b.com', username: 'a' },
          { id: 2, email: null, username: 'b' },
        ],
      });
      /** 查询结果 */
      const result = await service.index({});
      expect(result.total).toBe(3);
      expect(result.data.map((item) => item.email)).toEqual([
        'a@b.com',
        'b',
        '',
      ]);
    });

    it('没有用户ID需要补齐时不查用户表', async () => {
      /** 被测服务与替身 */
      const { service, userRepository } = serviceOf({
        rows: [{ ...RECORD, userId: 0 }],
      });
      await service.index({});
      expect(userRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('show', () => {
    it('记录不存在时返回空', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      expect(await service.show(1)).toBeNull();
    });

    it('记录存在时补齐用户邮箱', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf({
        users: [{ id: 1, email: 'a@b.com', username: 'a' }],
      });
      repository.findOneBy.mockResolvedValue({ ...RECORD });
      /** 详情 */
      const item = await service.show(1);
      expect(item?.email).toBe('a@b.com');
    });
  });

  describe('create', () => {
    it('返回新操作序号，时间戳由服务写入', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      expect(await service.create('user', 'create', 3, '备注')).toBe(12);
      /** 插入数据 */
      const value = repository.insert.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(value.name).toBe('user');
      expect(value.operate).toBe('create');
      expect(value.userId).toBe(3);
      expect(value.remark).toBe('备注');
      expect(typeof value.at).toBe('number');
    });

    it('未取到主键时返回 0（调用方据此判断日志是否可追）', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      repository.insert.mockResolvedValue({ identifiers: [] });
      expect(await service.create('user', 'create')).toBe(0);
    });
  });

  describe('options', () => {
    it('用户按ID升序，缺失邮箱时退回用户名，系统操作用固定文案', async () => {
      /** 三次聚合查询的构造器 */
      const userQb = builderOf();
      userQb.getRawMany.mockResolvedValue([{ userId: '2' }, { userId: '0' }]);
      /** 操作对象查询 */
      const nameQb = builderOf();
      nameQb.getRawMany.mockResolvedValue([{ name: 'role' }, { name: 'user' }]);
      /** 操作类型查询 */
      const operateQb = builderOf();
      operateQb.getRawMany.mockResolvedValue([{ operate: 'create' }]);
      /** 操作日志存储器替身 */
      const repository = {
        createQueryBuilder: vi
          .fn()
          .mockReturnValueOnce(userQb)
          .mockReturnValueOnce(nameQb)
          .mockReturnValueOnce(operateQb),
      };
      /** 用户存储器替身 */
      const userRepository = {
        find: vi.fn(async () => [{ id: 2, email: null, username: 'bob' }]),
      };
      /** 被测服务 */
      const service = new OperateService(
        repository as unknown as Repository<OperateEntity>,
        userRepository as unknown as Repository<UserEntity>,
      );

      expect(await service.options()).toEqual({
        users: [
          { value: 0, label: '系统/未登录' },
          { value: 2, label: 'bob' },
        ],
        names: ['role', 'user'],
        operates: ['create'],
      });
    });
  });
});
