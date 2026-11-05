// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  DAILY_CATCH_UP_HOUR,
  dailyCatchUpPlanDate,
  shouldScheduleDailyCatchUp,
} from './daily-catch-up.js';

describe('shouldScheduleDailyCatchUp', () => {
  it('交易日 20:00 且今天没排过 ⇒ 补更', () => {
    expect(
      shouldScheduleDailyCatchUp({
        hour: DAILY_CATCH_UP_HOUR,
        todayIsOpen: true,
        alreadyPlanned: false,
      }),
    ).toBe(true);
  });

  it('交易日 19:59 ⇒ 还不补（当天数据源才刚发布）', () => {
    expect(
      shouldScheduleDailyCatchUp({
        hour: DAILY_CATCH_UP_HOUR - 1,
        todayIsOpen: true,
        alreadyPlanned: false,
      }),
    ).toBe(false);
  });

  it('非交易日 ⇒ 不补（没有当天数据这回事）', () => {
    expect(
      shouldScheduleDailyCatchUp({ hour: 21, todayIsOpen: false, alreadyPlanned: false }),
    ).toBe(false);
  });

  it('今天已排过（成功的 / 在跑的 / 失败的）⇒ 不重复排', () => {
    expect(
      shouldScheduleDailyCatchUp({ hour: 21, todayIsOpen: true, alreadyPlanned: true }),
    ).toBe(false);
  });

  it('20:00 之后越晚越应补（进程重启后能自动补上）', () => {
    expect(
      shouldScheduleDailyCatchUp({ hour: 23, todayIsOpen: true, alreadyPlanned: false }),
    ).toBe(true);
  });
});

describe('dailyCatchUpPlanDate', () => {
  it('标记带日期，且非空（空串不受 IDX_sync_runs_plan 唯一约束）', () => {
    const plan = dailyCatchUpPlanDate('2026-11-05');

    expect(plan).toBe('auto:daily:2026-11-05');
    expect(plan).not.toBe('');
  });

  it('不同日期互不相同（一天一条）', () => {
    expect(dailyCatchUpPlanDate('2026-11-05')).not.toBe(dailyCatchUpPlanDate('2026-11-06'));
  });
});
