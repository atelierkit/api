// 内部依赖
import {
  isCodeScoped,
  SYNC_TARGET,
  unitCodeForTradeDate,
  type SyncTarget,
} from './sync.types.js';

/** 一次同步请求（声明式：只说「要哪类数据的哪个范围」） */
export interface SyncRequest {
  /** 要同步的数据类型 */
  target: SyncTarget;
  /** 证券代码清单；空 = 全市场（整份数据忽略该字段） */
  codes: string[];
  /** 起始日期（含）；null = 由同步器定起点 */
  from?: string | null;
  /** 结束日期（含）；null = 由同步器定上界 */
  to?: string | null;
}

/** 入队选项（source/plan 不进接口 DTO，由服务端写死） */
export interface SyncStartOption {
  source: 'manual' | 'auto';
  plan: string;
}

/** 展开结果 */
export interface SyncPlan {
  /** 实际入队的执行 Id */
  enqueuedIds: number[];
  /** 因幂等约束被挡下的条数 */
  blocked: number;
  /** 本次新建的任务数 */
  newTasks: number;
  /** 给界面的一句话说明 */
  note: string;
}

/** 展开单元 */
interface SyncUnit {
  code: string;
  from: string | null;
  to: string | null;
}

/** 校验错误 */
export interface SyncValidationError {
  code: string;
  message: string;
}

/** 展开所需的仓储依赖（由 SyncService 提供真实实现，测试用内存替身） */
export interface SyncPlanDeps {
  /** 交易日历最早日期（按交易日展开时用）；空 = 日历未同步 */
  earliestCalendarDate(): Promise<string | null>;
  /** 全市场股票代码（按证券展开时用） */
  allStockCodes(): Promise<string[]>;
  /** 确保任务存在，返回 代码 → taskId（必须覆盖全部入参 code） */
  ensureTasks(target: SyncTarget, codes: string[]): Promise<Map<string, number>>;
  /** 入队执行，返回实际入队 id 与被挡条数 */
  enqueue(runs: EnqueueRun[]): Promise<{ enqueuedIds: number[]; blocked: number }>;
  /** 今天（业务时区 Asia/Shanghai） */
  today(): string;
}

/** 待入队的执行 */
export interface EnqueueRun {
  taskId: number;
  target: SyncTarget;
  code: string;
  from: string | null;
  to: string | null;
  source: 'manual' | 'auto';
  plan: string;
}

/**
 * 把「要同步什么」展开成任务定义 + 执行待办
 *
 * 展开规则分两种执行模式：
 * - 整份快照（证券清单 / 交易日历）：一条任务，code 为空串；
 * - 按交易日（日 K 按交易日 / 复权因子）：整个区间一条，code 为固定单元标识。
 */
export class SyncPlanService {
  constructor(private readonly deps: SyncPlanDeps) {}

  /** 校验请求是否可以展开 */
  validate(request: SyncRequest): SyncValidationError | null {
    const byTradeDate =
      request.target === SYNC_TARGET.BAR_BY_DATE ||
      request.target === SYNC_TARGET.ADJUST_FACTOR;

    if (byTradeDate && request.codes.length > 0) {
      return {
        code: 'sync.codes_not_supported',
        message:
          '按交易日展开的数据不接受证券代码 —— 一次请求取当日全市场，请用整份请求表达「整个区间」。',
      };
    }

    if (
      isCodeScoped(request.target) &&
      request.codes.length > 0 &&
      request.codes.some((c) => !c.trim())
    ) {
      return {
        code: 'sync.empty_code',
        message: '证券代码清单里出现了空值，请先清理入参。',
      };
    }

    if (
      request.from &&
      request.to &&
      request.from > request.to
    ) {
      return {
        code: 'sync.invalid_range',
        message: `起始日期（${request.from}）晚于结束日期（${request.to}）。`,
      };
    }

    return null;
  }

  /** 展开并入队 */
  async plan(
    request: SyncRequest,
    option: SyncStartOption = { source: 'manual', plan: '' },
  ): Promise<{ plan: SyncPlan } | { error: SyncValidationError }> {
    const validation = this.validate(request);
    if (validation !== null) {
      return { error: validation };
    }

    const units = await this.resolveUnits(request);
    if (units === null) {
      return { error: units as unknown as SyncValidationError };
    }
    if (units.length === 0) {
      return {
        plan: {
          enqueuedIds: [],
          blocked: 0,
          newTasks: 0,
          note:
            request.target === SYNC_TARGET.BAR_BY_DATE ||
            request.target === SYNC_TARGET.ADJUST_FACTOR
              ? '区间内没有可同步的日期段 —— 起点晚于今天时会出现这种情况。'
              : '没有需要同步的证券 —— 若期望有，请先同步证券基础信息。',
        },
      };
    }

    const ensured = await this.deps.ensureTasks(
      request.target,
      units.map((u) => u.code),
    );

    const runs: EnqueueRun[] = units.map((unit) => {
      const taskId = ensured.get(unit.code);
      if (taskId === undefined) {
        throw new Error(
          `任务表没有返回单元「${unit.code}」对应的任务 Id —— 违反 ensureTasks 契约。`,
        );
      }
      return {
        taskId,
        target: request.target,
        code: unit.code,
        from: unit.from,
        to: unit.to,
        source: option.source,
        plan: option.plan,
      };
    });

    const outcome = await this.deps.enqueue(runs);

    const note =
      outcome.blocked > 0
        ? `已排 ${outcome.enqueuedIds.length} 条执行（${outcome.blocked} 条因同任务已在队列中而跳过）。`
        : `已排 ${outcome.enqueuedIds.length} 条执行。`;

    return {
      plan: {
        enqueuedIds: outcome.enqueuedIds,
        blocked: outcome.blocked,
        newTasks: ensured.size,
        note,
      },
    };
  }

  /** 把请求展开成同步单元清单；返回 null 表示校验失败 */
  private async resolveUnits(
    request: SyncRequest,
  ): Promise<SyncUnit[] | null> {
    const byTradeDate =
      request.target === SYNC_TARGET.BAR_BY_DATE ||
      request.target === SYNC_TARGET.ADJUST_FACTOR;

    if (byTradeDate) {
      const today = this.deps.today();
      const to =
        request.to && request.to < today ? request.to : today;

      let from: string;
      if (request.from) {
        from = request.from;
      } else {
        const earliest = await this.deps.earliestCalendarDate();
        if (earliest === null) {
          // 日历为空 ⇒ 无法确定起点，明确失败
          return null;
        }
        from = earliest;
      }

      if (from > to) {
        return [];
      }

      return [
        { code: unitCodeForTradeDate(request.target), from, to },
      ];
    }

    // 整份快照 / 按证券
    let codes: string[];
    if (!isCodeScoped(request.target)) {
      codes = [''];
    } else if (request.codes.length > 0) {
      codes = [...new Set(request.codes.map((c) => c.trim()))].sort();
    } else {
      codes = await this.deps.allStockCodes();
    }

    return codes.map((code) => ({ code, from: request.from ?? null, to: request.to ?? null }));
  }
}
