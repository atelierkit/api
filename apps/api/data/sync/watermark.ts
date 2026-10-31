// 内部依赖
import type { SyncTarget } from './sync.types.js';
import { NO_PARAMETERS } from './sync.types.js';

/** 同步台账（`data_coverage` 表的一行）——「这个数据集已经处理到哪一天」 */
export interface Watermark {
  /** 作用域（哪类数据） */
  scope: string;
  /** 数据集（哪只证券 / 全市场标识 / 固定单元标识） */
  dataset: string;
  /** 参数指纹（行情侧统一空串） */
  parameters: string;
  /** 已处理到的最后日期 */
  lastDate: string | null;
  /** 累计记录数 */
  rows: number;
}

/** 构造一个空台账（「从未同步过」） */
export function emptyWatermark(
  scope: string,
  dataset: string,
  parameters: string = NO_PARAMETERS,
): Watermark {
  return { scope, dataset, parameters, lastDate: null, rows: 0 };
}

/** 推进台账：lastDate 前进到 day，累计条数 = 既有 + 当天写入 */
export function advanceWatermark(
  watermark: Watermark,
  day: string,
  writtenToday: number,
): Watermark {
  return {
    ...watermark,
    lastDate: day,
    rows: watermark.rows + writtenToday,
  };
}

/** 台账作用域 → 目标（反向映射，用于快照展示时把库值读回来） */
export function targetFromScope(scope: string): SyncTarget | null {
  switch (scope) {
    case 'security':
      return 'Security';
    case 'calendar':
      return 'Calendar';
    case 'bar':
      return 'Bar';
    case 'bar.byDate':
      return 'BarByDate';
    case 'adjustFactor':
      return 'AdjustFactor';
    default:
      return null;
  }
}
