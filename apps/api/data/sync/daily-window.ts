/**
 * 「按交易日」数据（日 K / 复权因子）的同步上界
 *
 * 业务背景（2026-11-05 用户需求）：数据源在交易日收盘后约 19:00 才发布当天的
 * 日 K 与复权因子。按交易日同步对「日 K 返回 0 条」的语义是「数据源未发布 ⇒ 停段」，
 * 所以 19:00 前把当天也纳入区间纯属白跑一趟，还会在进度区留下一段无意义的失败/空转。
 *
 * 因此上界分三种情形：
 * - 交易日 19:00 前 ⇒ 前一交易日（当天由 20:00 的定时补更接管）；
 * - 交易日 19:00 起 ⇒ 当天；
 * - 非交易日 ⇒ 最近一个已收盘的交易日（当天本来就没有数据）。
 *
 * 定时补更用 `includeToday` 显式含当天，与时钟解耦：即使 19:00 前被触发（进程重启补跑），
 * 也按「含当天」处理 —— 那正是这个任务的职责。
 */

/** 当天数据发布的时刻（业务时区小时，含） */
export const SAME_DAY_PUBLISH_HOUR = 19;

/** 交易日历给出的两个事实 */
export interface TradeDayWindow {
  /** 今天是否开市 */
  todayIsOpen: boolean;
  /** 严格早于今天的最近一个开市日；null = 日历里没有更早的交易日 */
  previousOpenDay: string | null;
}

/** 上界判定的入参 */
export interface DailyUpperBoundInput {
  /** 业务日（Asia/Shanghai，YYYY-MM-DD） */
  today: string;
  /** 业务时区当前小时（0-23） */
  hour: number;
  /** 交易日历窗口 */
  window: TradeDayWindow;
  /** 是否显式要求含当天（定时补更 / 用户指定） */
  includeToday: boolean;
}

/** 上界的落点与原因 */
export interface DailyUpperBound {
  /** 实际可同步到的最后一天；null = 没有任何可用的交易日 */
  date: string | null;
  /** 为什么停在这一天 */
  reason: 'same-day' | 'before-publish' | 'non-trading-day' | 'no-trade-day';
}

/**
 * 判定按交易日数据的同步上界
 *
 * @param input 判定入参
 * @returns 上界与原因
 */
export function resolveDailyUpperBound(input: DailyUpperBoundInput): DailyUpperBound {
  const { today, hour, window, includeToday } = input;

  // 非交易日：没有「当天数据」这回事，一律停在最近一个开市日
  if (!window.todayIsOpen) {
    return window.previousOpenDay === null
      ? { date: null, reason: 'no-trade-day' }
      : { date: window.previousOpenDay, reason: 'non-trading-day' };
  }

  // 已过发布切点（或显式要求含当天）
  if (includeToday || hour >= SAME_DAY_PUBLISH_HOUR) {
    return { date: today, reason: 'same-day' };
  }

  return window.previousOpenDay === null
    ? { date: null, reason: 'no-trade-day' }
    : { date: window.previousOpenDay, reason: 'before-publish' };
}

/**
 * 上界说明（拼进入队回执，让界面直接说清「这次同步到哪天、为什么」）
 *
 * @param bound 上界判定结果
 * @param today 业务日
 * @returns 一句话说明
 */
export function dailyUpperBoundNote(bound: DailyUpperBound, today: string): string {
  switch (bound.reason) {
    case 'same-day':
      return `上界 ${bound.date}（含当天）。`;
    case 'before-publish':
      return (
        `上界 ${bound.date}：今天（${today}）19:00 前数据源尚未发布当天数据，` +
        '本次只更新到前一交易日，当天由每日 20:00 的定时补更负责。'
      );
    case 'non-trading-day':
      return `上界 ${bound.date}：今天（${today}）不是交易日，本次更新到最近一个交易日。`;
    default:
      return '交易日历里没有早于今天的开市日 —— 请先同步交易日历再重试。';
  }
}
