// 外部依赖
import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { UserEntity } from '../user/user.entity.js';
import { ReqEntity } from './req.entity.js';
import { ReqService } from './req.service.js';

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
  /** 请求日志存储器替身 */
  const repository = {
    createQueryBuilder: vi.fn(() => qb),
    findOneBy: vi.fn(async (_where: unknown) => null as unknown),
    insert: vi.fn(async (_value: unknown) => ({ identifiers: [1] })),
  };
  /** 用户存储器替身 */
  const userRepository = {
    find: vi.fn(async (_options: unknown) => options.users ?? []),
  };
  /** 被测服务 */
  const service = new ReqService(
    repository as unknown as Repository<ReqEntity>,
    userRepository as unknown as Repository<UserEntity>,
  );
  return { service, qb, repository, userRepository };
}

/** 一条请求日志 */
const RECORD = {
  reqId: 1,
  userId: 1,
  url: '/user/index',
  controller: 'UserController',
  action: 'index',
  status: 200,
  clientIp: '1.1.1.1',
  serverIp: '10.0.0.1',
  startAt: 1000,
  endAt: 1500,
};

describe('ReqService', () => {
  describe('insert', () => {
    it('返回写入条数，供调用方判断是否落库成功', async () => {
      /** 被测服务与替身 */
      const { service, repository } = serviceOf();
      expect(await service.insert({ url: '/x' })).toBe(1);
      expect(repository.insert).toHaveBeenCalledWith({ url: '/x' });
    });
  });

  describe('index', () => {
    it('缺省时间窗为最近 24 小时，并排除当前这次查询自身产生的日志', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({}, 88);
      expect(qb.where).toHaveBeenCalledWith('req.req_id != :reqId', {
        reqId: 88,
      });
      /** 时间窗参数 */
      const params = qb.andWhere.mock.calls[0][1] as {
        start: number;
        end: number;
      };
      expect(params.end - params.start).toBe(DAY);
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
    });

    it('每页条数封顶 100，翻页偏移按 (pi-1)*ps 计算', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ ps: 500 });
      expect(qb.take).toHaveBeenCalledWith(100);

      await service.index({ pi: 2, ps: 25 });
      expect(qb.skip).toHaveBeenLastCalledWith(25);
    });

    it('userId 为 0 时同样作为筛选条件（未登录请求是有意义的值）', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ userId: 0 });
      expect(qb.andWhere).toHaveBeenCalledWith('req.user_id = :userId', {
        userId: 0,
      });
    });

    it('请求路径同时匹配无 query 与带 query 的历史数据', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ path: '/user/index' });
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(req.url = :path OR req.url LIKE :pathLike)',
        { path: '/user/index', pathLike: '/user/index?%' },
      );
    });

    it('控制器与方法名按精确匹配筛选', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ controller: 'UserController', action: 'index' });
      expect(qb.andWhere).toHaveBeenCalledWith('req.controller = :controller', {
        controller: 'UserController',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('req.action = :action', {
        action: 'index',
      });
    });

    it('精确状态码优先于成功/异常筛选', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ status: 404, success: true });
      expect(qb.andWhere).toHaveBeenCalledWith('req.status = :status', {
        status: 404,
      });
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'req.status >= 200 AND req.status < 300',
      );
    });

    it('成功筛选只取 2xx，异常筛选取非 2xx', async () => {
      /** 被测服务与替身 */
      const { service, qb } = serviceOf();
      await service.index({ success: true });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'req.status >= 200 AND req.status < 300',
      );

      await service.index({ success: false });
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(req.status < 200 OR req.status >= 300)',
      );
    });

    it('补齐用户邮箱并计算请求耗时，缺时间戳时耗时为 0', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf({
        rows: [
          { ...RECORD },
          { ...RECORD, reqId: 2, userId: 2, email: undefined },
          { ...RECORD, reqId: 3, userId: 0, endAt: 0 },
        ],
        users: [
          { id: 1, email: 'a@b.com', username: 'a' },
          { id: 2, email: null, username: 'b' },
        ],
      });
      /** 查询结果 */
      const result = await service.index({});
      expect(result.total).toBe(3);
      expect(result.data[0].duration).toBe(500);
      expect(result.data[0].email).toBe('a@b.com');
      // 邮箱缺失时退回用户名
      expect(result.data[1].email).toBe('b');
      // 未登录请求没有用户可补
      expect(result.data[2].email).toBe('');
      expect(result.data[2].duration).toBe(0);
    });
  });

  describe('字典查询', () => {
    it('请求路径去重后按字面排序', async () => {
      /** 聚合查询构造器 */
      const qb = builderOf();
      qb.getRawMany.mockResolvedValue([{ url: '/user/index' }, { url: '/a' }]);
      /** 存储器替身 */
      const repository = { createQueryBuilder: vi.fn(() => qb) };
      /** 被测服务 */
      const service = new ReqService(
        repository as unknown as Repository<ReqEntity>,
        { find: vi.fn(async () => []) } as unknown as Repository<UserEntity>,
      );
      expect(await service.url()).toEqual(['/a', '/user/index']);
    });

    it('方法名按控制器筛选', async () => {
      /** 聚合查询构造器 */
      const qb = builderOf();
      qb.getRawMany.mockResolvedValue([{ action: 'index' }]);
      /** 存储器替身 */
      const repository = { createQueryBuilder: vi.fn(() => qb) };
      /** 被测服务 */
      const service = new ReqService(
        repository as unknown as Repository<ReqEntity>,
        { find: vi.fn(async () => []) } as unknown as Repository<UserEntity>,
      );
      expect(await service.action('UserController')).toEqual(['index']);
      expect(qb.where).toHaveBeenCalledWith('req.controller = :controller', {
        controller: 'UserController',
      });
    });

    it('用户字典区分未登录并补齐邮箱', async () => {
      /** 聚合查询构造器 */
      const qb = builderOf();
      qb.getRawMany.mockResolvedValue([{ userId: '2' }, { userId: '0' }]);
      /** 存储器替身 */
      const repository = { createQueryBuilder: vi.fn(() => qb) };
      /** 用户存储器替身 */
      const userRepository = {
        find: vi.fn(async () => [{ id: 2, email: 'b@b.com', username: 'b' }]),
      };
      /** 被测服务 */
      const service = new ReqService(
        repository as unknown as Repository<ReqEntity>,
        userRepository as unknown as Repository<UserEntity>,
      );
      expect(await service.user()).toEqual([
        { value: 0, label: '未登录' },
        { value: 2, label: 'b@b.com' },
      ]);
    });
  });

  describe('show', () => {
    it('记录不存在时返回空', async () => {
      /** 被测服务与替身 */
      const { service } = serviceOf();
      expect(await service.show(1)).toBeNull();
    });
  });
});
