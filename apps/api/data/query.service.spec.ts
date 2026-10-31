// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { DataQueryService } from './query.service.js';
import type { Repository } from 'typeorm';

/** 构造一个带 mock query builder 的 repository */
function mockRepo<T>(overrides: Partial<Record<keyof Repository<T>, unknown>> = {}): Repository<T> {
  return {
    ...overrides,
  } as unknown as Repository<T>;
}

describe('DataQueryService', () => {
  it('calendar 只返回存在的行（不补空行，三态依赖此）', async () => {
    const rows = [
      { calendarDate: '2026-01-02', isOpen: true },
      { calendarDate: '2026-01-05', isOpen: true },
      { calendarDate: '2026-01-06', isOpen: false },
    ];
    const qb = {
      where: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      getMany: vi.fn(async () => rows),
    };
    const calendarRepo = mockRepo({ createQueryBuilder: vi.fn(() => qb) });

    const svc = new DataQueryService(
      mockRepo(),
      calendarRepo,
      mockRepo(),
    );

    const result = await svc.calendar('2026');
    // 返回的行数与库中存在的行数一致，没有为缺失的日期补空行
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.calendarDate)).toEqual([
      '2026-01-02',
      '2026-01-05',
      '2026-01-06',
    ]);
  });

  it('bars 超过 5000 根时 truncated=true 且只取最近 5000 根', async () => {
    const qb = {
      where: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      limit: vi.fn(() => qb),
      getMany: vi.fn(async () => []),
    };
    const barRepo = mockRepo({
      count: vi.fn(async () => 6000),
      createQueryBuilder: vi.fn(() => qb),
    });

    const svc = new DataQueryService(mockRepo(), mockRepo(), barRepo);

    const result = await svc.bars({ code: 'sh.600000', from: '2020-01-01', to: '2026-01-01' });
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(6000);
    // 截断时按日期倒序取 5000 再反转（orderBy 收到 DESC）
    expect(qb.orderBy).toHaveBeenCalledWith('b.date', 'DESC');
    expect(qb.limit).toHaveBeenCalledWith(5000);
  });

  it('bars 未超上限时 truncated=false 且按日期升序', async () => {
    const qb = {
      where: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      limit: vi.fn(() => qb),
      getMany: vi.fn(async () => []),
    };
    const barRepo = mockRepo({
      count: vi.fn(async () => 100),
      createQueryBuilder: vi.fn(() => qb),
    });

    const svc = new DataQueryService(mockRepo(), mockRepo(), barRepo);

    const result = await svc.bars({ code: 'sh.600000', from: '2026-01-01', to: '2026-01-31' });
    expect(result.truncated).toBe(false);
    expect(qb.orderBy).toHaveBeenCalledWith('b.date', 'ASC');
    expect(qb.limit).not.toHaveBeenCalled();
  });

  it('bars from > to 抛 400', async () => {
    const svc = new DataQueryService(mockRepo(), mockRepo(), mockRepo());
    await expect(
      svc.bars({ code: 'sh.600000', from: '2026-02-01', to: '2026-01-01' }),
    ).rejects.toThrow('起始日期不能晚于结束日期');
  });

  it('securities 关键字过滤 + 分页 + marketTotal', async () => {
    const qb = {
      andWhere: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      addOrderBy: vi.fn(() => qb),
      skip: vi.fn(() => qb),
      take: vi.fn(() => qb),
      getManyAndCount: vi.fn(async () => [[{ code: 'sh.600000', name: '浦发银行', type: 'Stock', market: 'Shanghai', listDate: '1999-11-10', status: 'Listed', delistDate: null }], 1]),
    };
    const securityRepo = mockRepo({
      createQueryBuilder: vi.fn(() => qb),
      count: vi.fn(async () => 5000),
    });

    const svc = new DataQueryService(securityRepo, mockRepo(), mockRepo());

    const result = await svc.securities({ keyword: '浦发', type: 'Stock', market: 'Shanghai', sort: 'CodeAsc', page: 1, size: 50 });
    expect(result.total).toBe(1);
    expect(result.marketTotal).toBe(5000);
    expect(result.rows[0].code).toBe('sh.600000');
    expect(qb.andWhere).toHaveBeenCalledWith('(s.code ILIKE :kw OR s.name ILIKE :kw)', { kw: '%浦发%' });
  });

  it('securities 上市日期排序（升序 NULLS LAST）', async () => {
    const qb = {
      andWhere: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      addOrderBy: vi.fn(() => qb),
      skip: vi.fn(() => qb),
      take: vi.fn(() => qb),
      getManyAndCount: vi.fn(async () => [[], 0]),
    };
    const securityRepo = mockRepo({
      createQueryBuilder: vi.fn(() => qb),
      count: vi.fn(async () => 5000),
    });

    const svc = new DataQueryService(securityRepo, mockRepo(), mockRepo());
    await svc.securities({ sort: 'ListDateAsc' });
    expect(qb.orderBy).toHaveBeenCalledWith('s.listDate', 'ASC', 'NULLS LAST');
  });

  it('securities 上市日期降序', async () => {
    const qb = {
      andWhere: vi.fn(() => qb),
      orderBy: vi.fn(() => qb),
      addOrderBy: vi.fn(() => qb),
      skip: vi.fn(() => qb),
      take: vi.fn(() => qb),
      getManyAndCount: vi.fn(async () => [[], 0]),
    };
    const securityRepo = mockRepo({
      createQueryBuilder: vi.fn(() => qb),
      count: vi.fn(async () => 5000),
    });

    const svc = new DataQueryService(securityRepo, mockRepo(), mockRepo());
    await svc.securities({ sort: 'ListDateDesc' });
    expect(qb.orderBy).toHaveBeenCalledWith('s.listDate', 'DESC', 'NULLS LAST');
  });
});
