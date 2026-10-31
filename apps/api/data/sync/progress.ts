// 内部依赖

/** 一次进度上报（Done/Total 必须同量纲；Total 为 0 表示「总量未知」） */
export interface ProgressReport {
  /** 当前阶段（人类可读） */
  stage: string;
  /** 已完成数量 */
  done: number;
  /** 总数量；0 表示未知 */
  total: number;
  /** 最近一批的实况（可选） */
  fact?: ProgressFact | null;
  /** 本次处理的范围文本（可选） */
  scope?: string | null;
  /** 量纲字（可选） */
  unit?: string | null;
}

/** 最近一个处理单元的实况 —— 预计完成时间的输入 */
export interface ProgressFact {
  /** 按交易日通道：这一批是哪一天；分页通道为 null */
  date?: string | null;
  /** 分页通道：第几页；按交易日通道为 null */
  page?: number | null;
  /** 该批的数据条数 */
  count: number;
  /** 该批实际花掉的时间（毫秒） */
  elapsedMs: number;
  /** 具名单元（可选） */
  label?: string | null;
}

/** 这一批推进了几个进度单元（单位耗时的分母） */
export function factUnits(fact: ProgressFact): number {
  return fact.date === null || fact.date === undefined ? fact.count : 1;
}

/** 按交易日：某一天的实况 */
export function factForDay(date: string, count: number, elapsedMs: number): ProgressFact {
  return { date, page: null, count, elapsedMs, label: null };
}

/** 分页通道：某一页的实况 */
export function factForPage(page: number, count: number, elapsedMs: number): ProgressFact {
  return { date: null, page, count, elapsedMs, label: null };
}

/** 进度接收端（实现须快速返回） */
export interface ProgressSink {
  report(report: ProgressReport): void;
}

/** 丢弃全部进度的实现 */
export class NullProgressSink implements ProgressSink {
  static readonly instance = new NullProgressSink();
  report(_report: ProgressReport): void {
    // 有意为空
  }
}
