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

  it('shouldAbort 为真 ⇒ 在「一天走完」处停止，台账停在当天（暂停真的生效）', async () => {
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
    // 第一天结束后还不停，第二天结束后停
    let asked = 0;
    deps.shouldAbort = async () => {
      asked++;
      return asked >= 2;
    };

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
    if (result.ok) {
      expect(result.aborted).toBe(true);
      expect(result.stage).toContain('已暂停');
      // 已写的两天照常计入
      expect(result.rowsWritten).toBe(2);
    }
    const wm = watermarks.get('bar.byDate/bar')!;
    expect(wm.lastDate).toBe('2026-01-06'); // 停在第二天，第三天没拉
  });

  it('countRows 存在 ⇒ 台账记录数以库为准（修正重复提交导致的虚高）', async () => {
    const calendarDays = ['2026-01-05'].map((date) => ({ date, isOpen: true }));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', [rec('sh.600000')]],
    ]);
    const { deps, watermarks } = makeDeps({ calendarDays, recordsByDate });
    deps.countRows = async () => 25_000_000;

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-05',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步全市场日线' },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    expect(watermarks.get('bar.byDate/bar')!.rows).toBe(25_000_000);
  });

  it('条数骤降哨兵：降幅超过 30% 时调 warn（不再是一个空块）', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({ date, isOpen: true }));
    const many = Array.from({ length: 10 }, (_unused, index) => rec(`sh.60000${index}`));
    const few = Array.from({ length: 3 }, (_unused, index) => rec(`sh.60000${index}`));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', many],
      ['2026-01-06', few],
    ]);
    const { deps } = makeDeps({ calendarDays, recordsByDate });
    const warnings: string[] = [];
    deps.warn = (message: string) => {
      warnings.push(message);
    };

    const result = await runDailyBatch(
      SYNC_TARGET.BAR_BY_DATE,
      'bar',
      '2026-01-05',
      '2026-01-06',
      deps,
      (date) => ({ messageType: '98', bodyFields: ['x', 'anonymous', date], recordIndex: 4, fieldIndex: 5 }),
      ['code'],
      async (_date, records) => records.length,
      { progressStage: '同步全市场日线', warnOnCountDrop: true },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2026-01-06');
    expect(warnings[0]).toContain('30%');
  });

  it('未开启 warnOnCountDrop 时条数骤降不告警', async () => {
    const calendarDays = ['2026-01-05', '2026-01-06'].map((date) => ({ date, isOpen: true }));
    const many = Array.from({ length: 10 }, (_unused, index) => rec(`sh.60000${index}`));
    const recordsByDate = new Map<string, BaostockRecord[]>([
      ['2026-01-05', many],
      ['2026-01-06', [rec('sh.600009')]],
    ]);
    const { deps } = makeDeps({ calendarDays, recordsByDate });
    const warnings: string[] = [];
    deps.warn = (message: string) => {
      warnings.push(message);
    };

    await runDailyBatch(
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

    expect(warnings).toHaveLength(0);
  });
});
