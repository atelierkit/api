// 内部依赖

/**
 * 同步领域常量：目标 / 状态 / 作用域 / 单元标识 / 量纲
 *
 * 数值与语义照 almanac 桌面端（`SyncTarget` / `SyncState` / `CoverageScopes` /
 * `SyncUnitCodes` / `ProgressUnit`）逐一对齐，避免两边对照排查时错位。
 */

/** 同步的数据类型 */
export const SYNC_TARGET = {
  SECURITY: 'Security',
  CALENDAR: 'Calendar',
  BAR: 'Bar',
  BAR_BY_DATE: 'BarByDate',
  ADJUST_FACTOR: 'AdjustFactor',
} as const;
export type SyncTarget = (typeof SYNC_TARGET)[keyof typeof SYNC_TARGET];

/** 同步状态（0 Draft / 1 Queued / 2 Running / 3 Succeeded / 4 Failed / 5 Skipped / 6 Paused） */
export const SYNC_STATE = {
  DRAFT: 0,
  QUEUED: 1,
  RUNNING: 2,
  SUCCEEDED: 3,
  FAILED: 4,
  SKIPPED: 5,
  PAUSED: 6,
} as const;
export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

/** 是否终态（不会再被消费）—— Paused 也是终态 */
export function isTerminal(state: SyncState): boolean {
  return (
    state === SYNC_STATE.SUCCEEDED ||
    state === SYNC_STATE.FAILED ||
    state === SYNC_STATE.SKIPPED ||
    state === SYNC_STATE.PAUSED
  );
}

/** 是否活跃（已入队但未结束）—— Paused 不在活跃集合里（「继续」重入队的先决条件） */
export function isActive(state: SyncState): boolean {
  return state === SYNC_STATE.QUEUED || state === SYNC_STATE.RUNNING;
}

/** 活跃状态集合（部分唯一索引的谓词里也要用同一份） */
export const ACTIVE_STATES: SyncState[] = [SYNC_STATE.QUEUED, SYNC_STATE.RUNNING];

/** 同步台账作用域 */
export const COVERAGE_SCOPE = {
  SECURITY: 'security',
  CALENDAR: 'calendar',
  BAR: 'bar',
  BAR_BY_DATE: 'bar.byDate',
  ADJUST_FACTOR: 'adjustFactor',
} as const;

/** 全市场级数据集的「数据集」取值 */
export const WHOLE_MARKET = '*';

/** 无参数差异时使用的参数指纹 */
export const NO_PARAMETERS = '';

/** 按交易日数据集的固定单元标识（进 sync_tasks.code / data_coverage.dataset） */
export const UNIT_CODE = {
  BAR_BY_DATE: 'bar',
  ADJUST_FACTOR: 'adjustFactor',
} as const;

/** 目标 → 台账作用域 */
export function coverageScopeOf(target: SyncTarget): string {
  switch (target) {
    case SYNC_TARGET.SECURITY:
      return COVERAGE_SCOPE.SECURITY;
    case SYNC_TARGET.CALENDAR:
      return COVERAGE_SCOPE.CALENDAR;
    case SYNC_TARGET.BAR:
      return COVERAGE_SCOPE.BAR;
    case SYNC_TARGET.BAR_BY_DATE:
      return COVERAGE_SCOPE.BAR_BY_DATE;
    case SYNC_TARGET.ADJUST_FACTOR:
      return COVERAGE_SCOPE.ADJUST_FACTOR;
    default:
      throw new Error(`未知的同步类型：${String(target)}。`);
  }
}

/** 目标 → 界面展示名 */
export function displayNameOf(target: SyncTarget): string {
  switch (target) {
    case SYNC_TARGET.SECURITY:
      return '证券基础信息';
    case SYNC_TARGET.CALENDAR:
      return '交易日历';
    case SYNC_TARGET.BAR:
      return '日 K 线';
    case SYNC_TARGET.BAR_BY_DATE:
      return '日 K 线（按交易日，全市场）';
    case SYNC_TARGET.ADJUST_FACTOR:
      return '复权因子（按交易日）';
    default:
      return '未知';
  }
}

/**
 * 进度量纲（进度区「剩余 N 只 / N 天」的那个字）
 *
 * ⚠ 失败分支抛错而不是兜底：漏配一个新类型时当场抛，而不是让它在界面上以
 * 「剩余 1,017 天」这种读得通但完全错的文案出现。
 */
export function progressUnitOf(target: SyncTarget): string {
  switch (target) {
    case SYNC_TARGET.SECURITY:
    case SYNC_TARGET.BAR:
      return '只';
    case SYNC_TARGET.CALENDAR:
    case SYNC_TARGET.BAR_BY_DATE:
    case SYNC_TARGET.ADJUST_FACTOR:
      return '天';
    default:
      throw new Error(`未知的同步类型：${String(target)}。`);
  }
}

/** 是否按证券展开（整份数据一次请求拿全市场） */
export function isCodeScoped(target: SyncTarget): boolean {
  return target === SYNC_TARGET.BAR;
}

/** 按交易日数据集的固定单元标识 */
export function unitCodeForTradeDate(target: SyncTarget): string {
  switch (target) {
    case SYNC_TARGET.BAR_BY_DATE:
      return UNIT_CODE.BAR_BY_DATE;
    case SYNC_TARGET.ADJUST_FACTOR:
      return UNIT_CODE.ADJUST_FACTOR;
    default:
      throw new Error(
        `数据类型 ${target} 不是按交易日展开的 —— 只接受 BarByDate / AdjustFactor。`,
      );
  }
}
