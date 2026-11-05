// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  dailyUpperBoundNote,
  resolveDailyUpperBound,
  SAME_DAY_PUBLISH_HOUR,
  type TradeDayWindow,
} from './daily-window.js';

/** 交易日历窗口替身 */
function windowOf(todayIsOpen: boolean, previousOpenDay: string | null): TradeDayWindow {
  return { todayIsOpen, previousOpenDay };
}

describe('resolveDailyUpperBound', () => {
  it('交易日 19:00 前只到前一交易日（不含当天）', () => {
    const bound = resolveDailyUpperBound({
      today: '2026-11-05',
      hour: 9,
      window: windowOf(true, '2026-11-04'),
      includeToday: false,
    });

    expect(bound).toEqual({ date: '2026-11-04', reason: 'before-publish' });
  });

  it('18:59 仍算「19:00 前」（切点是整点，不是 18:00）', () => {
    const bound = resolveDailyUpperBound({
      today: '2026-11-05',
      hour: SAME_DAY_PUBLISH_HOUR - 1,
      window: windowOf(true, '2026-11-04'),
      includeToday: false,
    });

    expect(bound.reason).toBe('before-publish');
    expect(bound.date).toBe('2026-11-04');
  });

  it('交易日 19:00 起含当天', () => {
    const bound = resolveDailyUpperBound({
      today: '2026-11-05',
      hour: SAME_DAY_PUBLISH_HOUR,
      window: windowOf(true, '2026-11-04'),
      includeToday: false,
    });

    expect(bound).toEqual({ date: '2026-11-05', reason: 'same-day' });
  });

  it('显式 includeToday 时 19:00 前也取当天（定时补更的语义）', () => {
    const bound = resolveDailyUpperBound({
      today: '2026-11-05',
      hour: 18,
      window: windowOf(true, '2026-11-04'),
      includeToday: true,
    });

    expect(bound).toEqual({ date: '2026-11-05', reason: 'same-day' });
  });

  it('非交易日一律落在最近一个交易日，与时刻无关', () => {
    const bound = resolveDailyUpperBound({
      today: '2026-11-07',
      hour: 21,
      window: windowOf(false, '2026-11-06'),
      includeToday: false,
    });

    expect(bound).toEqual({ date: '2026-11-06', reason: 'non-trading-day' });
  });

  it('非交易日即便显式含当天也不越过前一个交易日', () => {
    const bound = resolveDailyUpperBound({
      today: '2026-11-07',
      hour: 21,
      window: windowOf(false, '2026-11-06'),
      includeToday: true,
    });

    expect(bound.date).toBe('2026-11-06');
  });

  it('日历里没有更早的交易日 ⇒ 上界为 null（开市 / 不开市都一样）', () => {
    expect(
      resolveDailyUpperBound({
        today: '2026-11-05',
        hour: 9,
        window: windowOf(true, null),
        includeToday: false,
      }),
    ).toEqual({ date: null, reason: 'no-trade-day' });

    expect(
      resolveDailyUpperBound({
        today: '2026-11-05',
        hour: 21,
        window: windowOf(false, null),
        includeToday: true,
      }),
    ).toEqual({ date: null, reason: 'no-trade-day' });
  });
});

describe('dailyUpperBoundNote', () => {
  it('19:00 前的说明点明「只到前一交易日 + 20:00 补更」', () => {
    const note = dailyUpperBoundNote(
      { date: '2026-11-04', reason: 'before-publish' },
      '2026-11-05',
    );

    expect(note).toContain('2026-11-04');
    expect(note).toContain('19:00');
    expect(note).toContain('20:00');
  });

  it('含当天 / 非交易日 / 无交易日各有对应文案', () => {
    expect(dailyUpperBoundNote({ date: '2026-11-05', reason: 'same-day' }, '2026-11-05')).toContain(
      '含当天',
    );
    expect(
      dailyUpperBoundNote({ date: '2026-11-06', reason: 'non-trading-day' }, '2026-11-07'),
    ).toContain('不是交易日');
    expect(dailyUpperBoundNote({ date: null, reason: 'no-trade-day' }, '2026-11-07')).toContain(
      '先同步交易日历',
    );
  });
});
