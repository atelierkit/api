// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SyncPlanService, type SyncPlanDeps } from './sync-plan.service.js';
import { SYNC_TARGET } from './sync.types.js';
import {
  advanceWatermark,
  emptyWatermark,
} from './watermark.js';
import { factUnits, factForDay, factForPage } from './progress.js';
import { progressUnitOf, coverageScopeOf, isActive, isTerminal } from './sync.types.js';

/** 内存替身 */
function makeDeps(overrides: Partial<SyncPlanDeps> = {}): SyncPlanDeps {
  return {
    earliestCalendarDate: async () => '1990-12-19',
    allStockCodes: async () => ['sh.600000', 'sz.000001'],
    ensureTasks: async (_target, codes) =>
      new Map(codes.map((code, i) => [code, i + 1])),
    enqueue: async (runs) => ({ enqueuedIds: runs.map((_, i) => i + 1), blocked: 0 }),
    today: () => '2026-10-31',
    ...overrides,
  };
}

describe('SyncPlanService', () => {
  it('整份快照展开成一条任务（code 为空串）', async () => {
    const deps = makeDeps();
    const svc = new SyncPlanService(deps);
    const result = await svc.plan({ target: SYNC_TARGET.SECURITY, codes: [] });
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.enqueuedIds).toHaveLength(1);
      expect(result.plan.blocked).toBe(0);
    }
  });

  it('按交易日整个区间展开成一条，code 为固定单元标识', async () => {
    const deps = makeDeps();
    const svc = new SyncPlanService(deps);
    const result = await svc.plan({
      target: SYNC_TARGET.BAR_BY_DATE,
      codes: [],
      from: '2020-01-01',
    });
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.enqueuedIds).toHaveLength(1);
    }
  });

  it('按交易日带了证券代码必须报错', async () => {
    const svc = new SyncPlanService(makeDeps());
    const result = await svc.plan({
      target: SYNC_TARGET.BAR_BY_DATE,
      codes: ['sh.600000'],
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('sync.codes_not_supported');
    }
  });

  it('日历为空时按交易日展开明确失败', async () => {
    const svc = new SyncPlanService(makeDeps({ earliestCalendarDate: async () => null }));
    const result = await svc.plan({ target: SYNC_TARGET.ADJUST_FACTOR, codes: [] });
    expect('error' in result).toBe(true);
  });

  it('起点晚于上界时不排任务', async () => {
    const svc = new SyncPlanService(makeDeps());
    const result = await svc.plan({
      target: SYNC_TARGET.BAR_BY_DATE,
      codes: [],
      from: '2027-01-01',
    });
    expect('plan' in result).toBe(true);
    if ('plan' in result) {
      expect(result.plan.enqueuedIds).toHaveLength(0);
    }
  });

  it('区间 from > to 校验失败', async () => {
    const svc = new SyncPlanService(makeDeps());
    const result = await svc.plan({
      target: SYNC_TARGET.SECURITY,
      codes: [],
      from: '2026-01-01',
      to: '2020-01-01',
    });
    expect('error' in result).toBe(true);
  });

  it('按证券（Bar）带了空代码 ⇒ 校验失败', async () => {
    const svc = new SyncPlanService(makeDeps());
    const result = await svc.plan({
      target: SYNC_TARGET.BAR,
      codes: ['sh.600000', ''],
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('sync.empty_code');
    }
  });

  it('按证券（Bar）显式代码去重排序展开', async () => {
    const ensureTasks = vi.fn(async (_t: string, codes: string[]) => new Map(codes.map((c, i) => [c, i + 1])));
    const svc = new SyncPlanService(
      makeDeps({ ensureTasks }),
    );
    const result = await svc.plan({
      target: SYNC_TARGET.BAR,
      codes: ['sz.000001', 'sh.600000', 'sz.000001'],
    });
    expect('plan' in result).toBe(true);
    // 去重 + 排序后是 sh.600000, sz.000001
    expect(ensureTasks).toHaveBeenCalledWith(SYNC_TARGET.BAR, ['sh.600000', 'sz.000001']);
  });

  it('按证券（Bar）空代码 ⇒ 全市场展开（allStockCodes）', async () => {
    const allStockCodes = vi.fn(async () => ['sh.600000', 'sz.000001']);
    const svc = new SyncPlanService(makeDeps({ allStockCodes }));
    const result = await svc.plan({ target: SYNC_TARGET.BAR, codes: [] });
    expect('plan' in result).toBe(true);
    expect(allStockCodes).toHaveBeenCalled();
  });
});

describe('领域常量与纯函数', () => {
  it('量纲映射：证券=只，日历/按交易日=天', () => {
    expect(progressUnitOf(SYNC_TARGET.SECURITY)).toBe('只');
    expect(progressUnitOf(SYNC_TARGET.CALENDAR)).toBe('天');
    expect(progressUnitOf(SYNC_TARGET.BAR_BY_DATE)).toBe('天');
    expect(progressUnitOf(SYNC_TARGET.ADJUST_FACTOR)).toBe('天');
  });

  it('量纲未知类型抛错', () => {
    expect(() => progressUnitOf('Unknown' as never)).toThrow();
  });

  it('作用域映射正确', () => {
    expect(coverageScopeOf(SYNC_TARGET.SECURITY)).toBe('security');
    expect(coverageScopeOf(SYNC_TARGET.BAR_BY_DATE)).toBe('bar.byDate');
    expect(coverageScopeOf(SYNC_TARGET.ADJUST_FACTOR)).toBe('adjustFactor');
  });

  it('状态判定：Paused 是终态但不是活跃', () => {
    expect(isTerminal(6)).toBe(true);
    expect(isActive(6)).toBe(false);
    expect(isActive(1)).toBe(true);
    expect(isActive(2)).toBe(true);
  });

  it('台账推进：累计 = 既有 + 当天，lastDate 前进', () => {
    const wm = emptyWatermark('bar.byDate', 'bar');
    const advanced = advanceWatermark(wm, '2026-01-05', 1234);
    expect(advanced.lastDate).toBe('2026-01-05');
    expect(advanced.rows).toBe(1234);

    const advanced2 = advanceWatermark(advanced, '2026-01-06', 10);
    expect(advanced2.rows).toBe(1244); // 1234 + 10，不是 + 本段累计
  });

  it('factUnits：按交易日一批 = 1，分页一批 = 本页条数', () => {
    expect(factUnits(factForDay('2026-01-05', 5432, 4200))).toBe(1);
    expect(factUnits(factForPage(3, 500, 3200))).toBe(500);
  });
});
