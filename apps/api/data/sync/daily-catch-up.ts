/**
 * 每日定时补更（业务时区 Asia/Shanghai）
 *
 * 每个交易日 20:00 起，把当天的日 K 与复权因子补进库 —— 19:00 前的手动同步被刻意
 * 限制在「前一交易日」（见 `daily-window.ts`），当天数据由这里收口。
 *
 * 幂等有两层：
 * ① 应用层：`sync_runs.plan_date` 写入 `auto:daily:<today>`，同一任务当天已有记录就不再排；
 * ② 数据库层：`IDX_sync_runs_plan`（`task_id, plan_date WHERE plan_date <> ''`）唯一索引兜底，
 *    开发库若没手工建这条索引，只剩第 ① 层。
 */

/** 补更时刻（业务时区小时，含）：收盘后数据源已发布当天数据 */
export const DAILY_CATCH_UP_HOUR = 20;

/**
 * 补更的 `plan_date` 标记
 *
 * ⚠ 必须是非空串：`IDX_sync_runs_plan` 的唯一约束只对 `plan_date <> ''` 生效，
 * 手工执行（`plan_date = ''`）不受它约束、也就不会挡住定时补更。
 *
 * @param today 业务日（YYYY-MM-DD）
 * @returns 形如 `auto:daily:2026-11-05`
 */
export function dailyCatchUpPlanDate(today: string): string {
  return `auto:daily:${today}`;
}

/**
 * 该不该为今天排一次补更
 *
 * @param input 判定入参
 * @returns 需要补更时为 true
 */
export function shouldScheduleDailyCatchUp(input: {
  /** 业务时区当前小时（0-23） */
  hour: number;
  /** 今天是否开市 */
  todayIsOpen: boolean;
  /** 今天该任务是否已经排过（含已成功 / 正在跑 / 已失败） */
  alreadyPlanned: boolean;
}): boolean {
  // 非交易日没有当天数据；凌晨（hour 回到 0）也不再补「昨天」——那属于第二天的补更范畴
  if (!input.todayIsOpen || input.hour < DAILY_CATCH_UP_HOUR) {
    return false;
  }
  return !input.alreadyPlanned;
}
