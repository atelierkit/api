// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  displayNameOf,
  isCodeScoped,
  SYNC_TARGET,
  unitCodeForTradeDate,
} from './sync.types.js';
import { targetFromScope } from './watermark.js';
import { BaostockQueries } from '../source/baostock.query.js';

describe('sync.types 补充', () => {
  it('displayNameOf 四个目标都有中文名', () => {
    expect(displayNameOf(SYNC_TARGET.SECURITY)).toBe('证券基础信息');
    expect(displayNameOf(SYNC_TARGET.CALENDAR)).toBe('交易日历');
    expect(displayNameOf(SYNC_TARGET.BAR_BY_DATE)).toBe('日 K 线（按交易日，全市场）');
    expect(displayNameOf(SYNC_TARGET.ADJUST_FACTOR)).toBe('复权因子（按交易日）');
  });

  it('isCodeScoped 只有 Bar 为 true', () => {
    expect(isCodeScoped(SYNC_TARGET.BAR)).toBe(true);
    expect(isCodeScoped(SYNC_TARGET.SECURITY)).toBe(false);
    expect(isCodeScoped(SYNC_TARGET.CALENDAR)).toBe(false);
  });

  it('unitCodeForTradeDate 只接受按交易日类型', () => {
    expect(unitCodeForTradeDate(SYNC_TARGET.BAR_BY_DATE)).toBe('bar');
    expect(unitCodeForTradeDate(SYNC_TARGET.ADJUST_FACTOR)).toBe('adjustFactor');
    expect(() => unitCodeForTradeDate(SYNC_TARGET.SECURITY)).toThrow();
  });
});

describe('watermark.targetFromScope', () => {
  it('反向映射作用域 → 目标', () => {
    expect(targetFromScope('security')).toBe('Security');
    expect(targetFromScope('calendar')).toBe('Calendar');
    expect(targetFromScope('bar')).toBe('Bar');
    expect(targetFromScope('bar.byDate')).toBe('BarByDate');
    expect(targetFromScope('adjustFactor')).toBe('AdjustFactor');
    expect(targetFromScope('unknown')).toBeNull();
  });
});

describe('baostock.query 补充', () => {
  it('login/logout 构造', () => {
    const login = BaostockQueries.login('anonymous', '123456');
    expect(login.messageType).toBe('00');
    expect(login.bodyFields).toEqual(['login', 'anonymous', '123456', '0']);

    const logout = BaostockQueries.logout('anonymous', new Date('2026-01-05T00:00:00Z'));
    expect(logout.messageType).toBe('02');
    expect(logout.bodyFields).toEqual(['logout', 'anonymous', '20260105000000']);
  });
});
