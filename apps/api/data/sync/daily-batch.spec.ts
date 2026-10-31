// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { runDailyBatch, type DailyBatchDeps } from './daily-batch.js';
import type { BaostockRecord } from '../source/baostock.record.js';
import type { BaostockQuery } from '../source/baostock.query.js';
import { SYNC_TARGET } from './sync.types.js';
import type { Watermark } from './watermark.js';

/** 内存替身：可编排每天返回多少条记录 */
function makeDeps(opts: {
  calendarDays: { date: string; isOpen: boolean }[];
  recordsByDate: Map<string, BaostockRecord[]>;
}) {
  const watermarks = new Map<string, Watermark>();
  const written: string[] = [];

  const deps: DailyBatchDeps = {
    findWatermark: async (scope, dataset) => watermarks.get(`${scope}/${dataset}`) ?? null,
    saveWatermark: async (wm) => {
      watermarks.set(`${wm.scope}/${wm.dataset}`, wm);
    },
    latestCalendarDate: async () =>
      opts.calendarDays.length > 0
        ? opts.calendarDays[opts.calendarDays.length - 1].date
        : null,
    calendarRange: async (from, to) =>
      opts.calendarDays.filter((d) => d.date >= from && d.date <= to),
    client: {
      query: async (q: BaostockQuery) => {
        // 从查询体里抠出日期（aStockDaily 的第 3 个字段）
        const date = q.bodyFields[q.bodyFields.length - 1];
        return opts.recordsByDate.get(date) ?? [];
      },
    } as never,
  };

  return { deps, watermarks, written };
}

function rec(code: string): BaostockRecord {
  const map = new Map<string, string>();
  map.set('code', code);
  map.set('date', '');
  return map;
}

describe('runDailyBatch 按交易日骨架', () => {
  it('逐日推进台账，断点续跑从 lastDate+1 起', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06', '2026-01-07'].map((date) => ({
      date,
      isOpen: true,
    }));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', [rec('sh.600000')]],
      ['2026-01-06', [rec('sh.600000')]],
      ['2026-01-07', [rec('sh.600000')]],
    ]);

    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-07',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    const wm = watermarks.get('bar.byDate/bar')!;
    expect(wm.lastDate).toBe('2026-01-07');
    expect(wm.rows).toBe(3);
  });

  it('日 K 交易日返回 0 条 = 停本段、台账不推进', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({
      date,
      isOpen: true,
    }));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', [rec('sh.600000')]],
      // 2026-01-06 返回 0 条（数据源未发布）
    ]);

    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-06',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    const wm = watermarks.get('bar.byDate/bar')!;
    // 台账只推进到 01-05，01-06 未发布所以停住
    expect(wm.lastDate).toBe('2026-01-05');
  });

  it('复权因子 0 条 = 正常，照常推进台账', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({
      date,
      isOpen: true,
    }));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', [rec('sh.600000')]],
      // 2026-01-06 无除权除息事件（正常）
    ]);

    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate });

    const result = await runDailyBatch(
      SYNC_TARGET.ADJUST_FACTOR,
      'adjustFactor',
      '2026-01-05',
      '2026-01-06',
      deps,
      (date) => ({ messageType: '9C', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步复权因子', emptyResponseIsNormal: true },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    const wm = watermarks.get('adjustFactor/adjustFactor')!;
    expect(wm.lastDate).toBe('2026-01-06');
  });

  it('复权因子全 0 条 ⇒ writtenTotal=0 走「无新增数据」分支', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({
      date,
      isOpen: true,
    }));
    const recordsByDate = new Map<string, BaostockRecord[]>(); // 两天都无记录

    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate });

    const result = await runDailyBatch(
      SYNC_TARGET.ADJUST_FACTOR,
      'adjustFactor',
      '2026-01-05',
      '2026-01-06',
      deps,
      (date) => ({ messageType: '9C', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async () => 0,
      { progressStage: '同步复权因子', emptyResponseIsNormal: true },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stage).toContain('无新增数据');
    }
    const wm = watermarks.get('adjustFactor/adjustFactor')!;
    expect(wm.lastDate).toBe('2026-01-06'); // 0 条也推进
  });

  it('日历未覆盖区间 ⇒ 明确失败', async () => {
    const { deps } = makeDeps({ calendarDays: [], recordsByDate: new Map() });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-06',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sync.calendar_not_covered');
    }
  });

  it('首条记录缺必填列名 ⇒ 抛错（列名错位静默拿空的守卫）', async () => {
    const calendarDays = ['2026-01-05'].map((date) => ({ date, isOpen: true }));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', [new Map<string, string>([['code', 'sh.600000']])]], // 缺 open 等字段
    ]);

    const { deps } = makeDeps({ calendarDays, recordsByDate });

    await expect(
      runDailyBatch(
        SYNC_TARGET.BAR_BY_DATE,
        'bar',
        '2026-01-05',
        '2026-01-05',
        deps,
        (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
        ['code', 'open', 'close'],
        async (_date, records) => records.length,
        { progressStage: '同步全市场日线' },
        { report: () => undefined },
      ),
    ).rejects.toThrow(/缺少字段/);
  });

  it('既无台账又无显式起点 ⇒ 明确失败', async () => {
    const { deps } = makeDeps({
      calendarDays: [],
      recordsByDate: new Map(),
    });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      null, // 无显式起点
      '2026-01-06',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async () => 0,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sync.bydate_missing_start');
    }
  });

  it('起点晚于上界 ⇒ 已是最新（成功、0 条）', async () => {
    // 台账已到 01-10，请求上界 01-05 → 起点 01-11 > 上界
    const calendarDays = ['2026-01-05'].map((date) => ({ date, isOpen: true }));
    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate: new Map() });
    // 预置台账到 01-10
    await deps.saveWatermark({ scope: 'bar.byDate', dataset: 'bar', parameters: '', lastDate: '2026-01-10', rows: 10 });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      null,
      '2026-01-05',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async () => 0,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stage).toBe('已是最新');
    }
    void watermarks;
  });

  it('区间内全是休市日 ⇒ 长假段（成功、0 条）', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({ date, isOpen: false }));
    const { deps } = makeDeps({ calendarDays, recordsByDate: new Map() });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-06',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async () => 0,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stage).toBe('区间内没有交易日（长假段）');
    }
  });

  it('请求上界晚于日历末日 ⇒ 上界截断到日历末日', async () => {
    // 日历只覆盖到 01-06，但请求上界到 01-10
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({ date, isOpen: true }));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', [rec('sh.600000')]],
      ['2026-01-06', [rec('sh.600000')]],
    ]);
    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate });

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-10', // 晚于日历末日 01-06
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    // 只推进到日历末日 01-06，不会到 01-10
    const wm = watermarks.get('bar.byDate/bar')!;
    expect(wm.lastDate).toBe('2026-01-06');
  });
});
