// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { syncSecurities } from './security.syncer.js';
import { syncCalendar } from './calendar.syncer.js';
import { syncBarByDate } from './bar-by-date.syncer.js';
import { syncAdjustFactor } from './adjust-factor.syncer.js';
import type { BaostockRecord } from '../source/baostock.record.js';

/** 造一条记录（列名 → 值） */
function rec(entries: Record<string, string>): BaostockRecord {
  return new Map(Object.entries(entries));
}

describe('security.syncer', () => {
  it('映射 type/market/status 为落库枚举名，逐页 upsert', async () => {
    const client = {
      query: (async () => [
        rec({ code: 'sh.600000', code_name: '浦发银行', type: '1', ipoDate: '1999-11-10', outDate: '', status: '1' }),
        rec({ code: 'sh.000001', code_name: '上证指数', type: '2', ipoDate: '', outDate: '', status: '1' }),
      ]) as never,
    };
    const written: unknown[][] = [];
    const store = { upsertSecurities: async (rows: unknown[]) => { written.push(rows); return rows.length; } };

    const result = await syncSecurities(
      { client: client as never, store },
      { report: () => undefined },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowsWritten).toBe(2);
    }
    const first = written[0][0] as Record<string, unknown>;
    expect(first.type).toBe('Stock');
    expect(first.market).toBe('Shanghai');
    expect(first.status).toBe('Listed');
    const second = written[0][1] as Record<string, unknown>;
    expect(second.type).toBe('Index');
    expect(second.market).toBe('Shanghai');
  });

  it('退市证券不丢（status=0 → Delisted）', async () => {
    const client = {
      query: (async () => [
        rec({ code: 'sh.600000', code_name: '已退市', type: '1', ipoDate: '1999-01-01', outDate: '2020-01-01', status: '0' }),
      ]) as never,
    };
    const written: unknown[][] = [];
    const store = { upsertSecurities: async (rows: unknown[]) => { written.push(rows); return rows.length; } };

    await syncSecurities({ client: client as never, store }, { report: () => undefined });

    const row = written[0][0] as Record<string, unknown>;
    expect(row.status).toBe('Delisted');
    expect(row.delistDate).toBe('2020-01-01');
  });

  it('映射全分支：type Bond/Fund/Unknown，market Shenzhen/Beijing/Unknown，status Unknown', async () => {
    const client = {
      query: (async () => [
        rec({ code: 'sh.110000', code_name: '转债', type: '4', ipoDate: '', outDate: '', status: '1' }),
        rec({ code: 'sz.150000', code_name: 'ETF', type: '5', ipoDate: '', outDate: '', status: '1' }),
        rec({ code: 'bj.830000', code_name: '北交所', type: '3', ipoDate: '', outDate: '', status: '9' }),
        rec({ code: 'xx.999999', code_name: '未知交易所', type: '1', ipoDate: '', outDate: '', status: '1' }),
      ]) as never,
    };
    const written: unknown[][] = [];
    const store = { upsertSecurities: async (rows: unknown[]) => { written.push(rows); return rows.length; } };

    await syncSecurities({ client: client as never, store }, { report: () => undefined });

    const rows = written[0] as Record<string, unknown>[];
    expect(rows[0].type).toBe('Bond');
    expect(rows[1].type).toBe('Fund');
    expect(rows[1].market).toBe('Shenzhen');
    expect(rows[2].type).toBe('Unknown'); // type=3 未定义 → Unknown
    expect(rows[2].market).toBe('Beijing');
    expect(rows[2].status).toBe('Unknown'); // status=9 未定义 → Unknown
    expect(rows[3].market).toBe('Unknown'); // xx. 前缀 → Unknown
  });

  it('数据源返回空 ⇒ 明确失败', async () => {
    const client = { query: (async () => [] as BaostockRecord[]) as never };
    const store = { upsertSecurities: async () => 0 };
    const result = await syncSecurities({ client: client as never, store }, { report: () => undefined });
    expect(result.ok).toBe(false);
  });
});

describe('calendar.syncer', () => {
  it('映射 calendar_date/isOpen，逐页 upsert', async () => {
    const client = {
      query: (async () => [
        rec({ calendar_date: '2026-01-05', is_trading_day: '1' }),
        rec({ calendar_date: '2026-01-06', is_trading_day: '0' }),
      ]) as never,
    };
    const store = {
      upsertCalendar: async (rows: { calendarDate: string; isOpen: boolean }[]) => rows.length,
      countCalendar: async () => 2,
    };
    const watermarks = new Map<string, unknown>();
    const deps = {
      client: client as never,
      store,
      findWatermark: async () => null,
      saveWatermark: async (wm: unknown) => { watermarks.set('wm', wm); },
      today: () => '2026-10-31',
    };

    const result = await syncCalendar(deps, null, null, { report: () => undefined });
    expect(result.ok).toBe(true);
    const wm = watermarks.get('wm') as { lastDate: string };
    expect(wm.lastDate).toBe('2026-01-06'); // 取到的最晚日
  });

  it('数据源返回空 ⇒ 明确失败', async () => {
    const client = { query: (async () => [] as BaostockRecord[]) as never };
    const store = { upsertCalendar: async () => 0, countCalendar: async () => 0 };
    const deps = {
      client: client as never,
      store,
      findWatermark: async () => null,
      saveWatermark: async () => undefined,
      today: () => '2026-10-31',
    };
    const result = await syncCalendar(deps, null, null, { report: () => undefined });
    expect(result.ok).toBe(false);
  });

  it('起点晚于上界 ⇒ 已覆盖至（无需拉取）', async () => {
    const client = { query: (async () => [] as BaostockRecord[]) as never };
    const store = { upsertCalendar: async () => 0, countCalendar: async () => 0 };
    const deps = {
      client: client as never,
      store,
      findWatermark: async () => null,
      saveWatermark: async () => undefined,
      today: () => '2026-10-31',
    };
    // from 晚于 upper（2027-12-31）
    const result = await syncCalendar(deps, '2028-01-01', null, { report: () => undefined });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stage).toContain('无需拉取');
    }
  });

  it('空日期记录被丢弃', async () => {
    const client = {
      query: (async () => [
        rec({ calendar_date: '', is_trading_day: '1' }), // 空日期 → 丢弃
        rec({ calendar_date: '2026-01-05', is_trading_day: '1' }),
      ]) as never,
    };
    const written: unknown[][] = [];
    const store = {
      upsertCalendar: async (rows: unknown[]) => { written.push(rows); return rows.length; },
      countCalendar: async () => 1,
    };
    const deps = {
      client: client as never,
      store,
      findWatermark: async () => null,
      saveWatermark: async () => undefined,
      today: () => '2026-10-31',
    };
    const result = await syncCalendar(deps, null, null, { report: () => undefined });
    expect(result.ok).toBe(true);
    // 只有 1 条有效记录
    expect(written[0]).toHaveLength(1);
  });
});

describe('bar-by-date.syncer / adjust-factor.syncer 映射', () => {
  /** 构造按交易日同步器的依赖 */
  function dailyDeps(client: unknown, store: unknown) {
    return {
      client,
      store,
      findWatermark: async () => null,
      saveWatermark: async () => undefined,
      latestCalendarDate: async () => '2026-01-06',
      calendarRange: async () => [
        { date: '2026-01-05', isOpen: true },
        { date: '2026-01-06', isOpen: true },
      ],
    };
  }

  it('bar-by-date 映射 18 列（估值空串落 null、status→Normal/Suspended）', async () => {
    const client = {
      query: (async (q: { bodyFields: string[] }) => {
        // 只给第一天数据，第二天空（数据源未发布 → 停段）
        if (q.bodyFields[2] === '2026-01-05') {
          return [
            rec({
              code: 'sh.600000', date: '2026-01-05', open: '10', high: '11', low: '9', close: '10.5',
              preclose: '10.2', volume: '123', amount: '456', adjustflag: '3', turn: '0.5',
              tradestatus: '1', pctChg: '0.3', peTTM: '', pbMRQ: '1.2', psTTM: '2', pcfNcfTTM: '', isST: '0',
            }),
          ];
        }
        return [] as BaostockRecord[];
      }) as never,
    };
    const written: unknown[][] = [];
    const store = { upsertBars: async (rows: unknown[]) => { written.push(rows); return rows.length; } };

    await syncBarByDate('bar', '2026-01-05', '2026-01-06', dailyDeps(client, store) as never, { report: () => undefined });

    const row = written[0][0] as Record<string, unknown>;
    expect(row.tradeStatus).toBe('Normal');
    expect(row.isSt).toBe(false);
    expect(row.peTtm).toBeNull(); // 空串 → null
    expect(row.pbMrq).toBe('1.2');
  });

  it('bar-by-date tradestatus=0 → Suspended，isST=1 → true', async () => {
    const client = {
      query: (async () => [
        rec({
          code: 'sh.600001', date: '2026-01-05', open: '5', high: '5', low: '5', close: '5',
          preclose: '5', volume: '0', amount: '0', adjustflag: '3', turn: '0',
          tradestatus: '0', pctChg: '0', peTTM: '', pbMRQ: '', psTTM: '', pcfNcfTTM: '', isST: '1',
        }),
      ]) as never,
    };
    const written: unknown[][] = [];
    const store = { upsertBars: async (rows: unknown[]) => { written.push(rows); return rows.length; } };

    await syncBarByDate('bar', '2026-01-05', '2026-01-05', dailyDeps(client, store) as never, { report: () => undefined });

    const row = written[0][0] as Record<string, unknown>;
    expect(row.tradeStatus).toBe('Suspended');
    expect(row.isSt).toBe(true);
  });

  it('adjust-factor 只有 backFactor 落库，坏行丢弃', async () => {
    const client = {
      query: (async () => [
        rec({ code: 'sh.600000', dividOperateDate: '2026-01-05', foreAdjustFactor: '1.1', backAdjustFactor: '2.5', adjustFactor: '3' }),
        rec({ code: 'sh.600001', dividOperateDate: '2026-01-05', foreAdjustFactor: '1', backAdjustFactor: '', adjustFactor: '1' }),
      ]) as never,
    };
    const written: unknown[][] = [];
    const store = { upsertFactors: async (rows: unknown[]) => { written.push(rows); return rows.length; } };

    await syncAdjustFactor('adjustFactor', '2026-01-05', '2026-01-05', dailyDeps(client, store) as never, { report: () => undefined });

    // 只有 backFactor 非空的那条落库
    expect(written[0]).toHaveLength(1);
    const row = written[0][0] as Record<string, unknown>;
    expect(row.code).toBe('sh.600000');
    expect(row.backFactor).toBe('2.5');
    expect(row.operateDate).toBe('2026-01-05');
  });
});
