// 外部依赖
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
// 内部依赖
import { BarQueryDto, CalendarQueryDto, SecurityQueryDto } from './query.dto.js';

describe('查询 DTO', () => {
  it('证券查询：合法条件通过', async () => {
    const dto = Object.assign(new SecurityQueryDto(), {
      keyword: '平安',
      type: 'Stock',
      market: 'Shanghai',
      sort: 'CodeAsc',
      page: 1,
      size: 50,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('证券查询：非法的类型/交易所/排序被拒', async () => {
    const dto = Object.assign(new SecurityQueryDto(), {
      type: 'Bond', // 合法
      market: 'NASDAQ', // 非法
      sort: 'Foo', // 非法
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('证券查询：size 超界被拒', async () => {
    const dto = Object.assign(new SecurityQueryDto(), { size: 999 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('日历查询：year 必须是 4 位数字', async () => {
    const ok = Object.assign(new CalendarQueryDto(), { year: '2026' });
    expect(await validate(ok)).toHaveLength(0);

    const bad = Object.assign(new CalendarQueryDto(), { year: 'abc' });
    expect((await validate(bad)).length).toBeGreaterThan(0);
  });

  it('K 线查询：code/from/to 必填', async () => {
    const ok = Object.assign(new BarQueryDto(), {
      code: 'sh.600000',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(await validate(ok)).toHaveLength(0);

    const missing = Object.assign(new BarQueryDto(), { code: 'sh.600000' });
    expect((await validate(missing)).length).toBeGreaterThan(0);
  });
});
