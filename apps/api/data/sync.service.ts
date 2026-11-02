// 外部依赖
import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
// 内部依赖
import { QueueService } from '@shared';
import { BaostockClient } from './source/baostock.client.js';
import { DataGateway } from './data.gateway.js';
import { DataCoverageEntity } from './entities/data-coverage.entity.js';
import { SyncTaskEntity } from './entities/sync-task.entity.js';
import { SyncRunEntity } from './entities/sync-run.entity.js';
import { SecurityEntity } from './entities/security.entity.js';
import { BarEntity } from './entities/bar.entity.js';
import { TradeCalendarEntity } from './entities/trade-calendar.entity.js';
import { AdjustFactorEntity } from './entities/adjust-factor.entity.js';
import { SyncPlanService, type SyncStartOption } from './sync/sync-plan.service.js';
import type { SyncRequest } from './sync/sync-plan.service.js';
import {
  coverageScopeOf,
  displayNameOf,
  SYNC_STATE,
  SYNC_TARGET,
  TERMINAL_STATES,
  type SyncTarget,
} from './sync/sync.types.js';
import type { Watermark } from './sync/watermark.js';
import { syncBarByDate } from './sync/bar-by-date.syncer.js';
import { syncAdjustFactor } from './sync/adjust-factor.syncer.js';
import { syncSecurities } from './sync/security.syncer.js';
import { syncCalendar } from './sync/calendar.syncer.js';
import type { ProgressReport } from './sync/progress.js';
import type { SyncResult } from './sync/daily-batch.js';

/**
 * 行情数据同步服务：入队 / 暂停 / 快照 + 进程内消费段
 *
 * ⚠ 队列的权威是 `sync_runs` 表（活跃行就是队列）；`QueueService` 只当「唤醒后的串行宿主」。
 * ⚠ 消费段放 api 进程内 ⇒ 部署必须单实例（见 onApplicationBootstrap 的僵尸对账注释）。
 */
@Injectable()
export class SyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);

  /** 消费循环是否在跑 */
  private consuming = false;
  /** 丢唤醒守卫：判定队列空与真的返回之间入队的信号 */
  private wakeRequested = false;
  /** 取消令牌（停机用） */
  private stopping = false;
  /** 进度写库的串行尾（见 makeProgress 注释） */
  private progressTail: Promise<void> = Promise.resolve();

  private readonly client = new BaostockClient();

  constructor(
    private readonly queueSrv: QueueService,
    private readonly gateway: DataGateway,
    @InjectRepository(SyncTaskEntity)
    private readonly taskRepo: Repository<SyncTaskEntity>,
    @InjectRepository(SyncRunEntity)
    private readonly runRepo: Repository<SyncRunEntity>,
    @InjectRepository(DataCoverageEntity)
    private readonly coverageRepo: Repository<DataCoverageEntity>,
    @InjectRepository(SecurityEntity)
    private readonly securityRepo: Repository<SecurityEntity>,
    @InjectRepository(TradeCalendarEntity)
    private readonly calendarRepo: Repository<TradeCalendarEntity>,
    @InjectRepository(BarEntity)
    private readonly barRepo: Repository<BarEntity>,
    @InjectRepository(AdjustFactorEntity)
    private readonly factorRepo: Repository<AdjustFactorEntity>,
  ) {}

  /** 启动对账：把僵尸执行（state=2）回滚为排队（state=1），再唤醒消费 */
  async onApplicationBootstrap(): Promise<void> {
    // ⚠ 只对单实例成立：两个 api 实例同时启动会互相抢走对方正在跑的执行。
    const zombies = await this.runRepo.update(
      { state: SYNC_STATE.RUNNING },
      { state: SYNC_STATE.QUEUED },
    );
    if ((zombies.affected ?? 0) > 0) {
      this.logger.warn(`启动对账：${zombies.affected} 条执行中记录回滚为排队。`);
    }
    this.wake();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    void this.client.logout();
  }

  /**
   * 唤醒消费（幂等：消费循环已在跑则只记一个信号）
   *
   * ⚠ 信号只在「已在消费」时置位：`consume()` 的 finally 会用 `wake()` 重启循环，
   * 若无条件置位，重启后标志又为真 ⇒ 消费段无限自激重启（队列空时表现为
   * 每秒数百次空 UPDATE，把数据库 CPU 打满）。详见 consume() 的收尾注释。
   */
  wake(): void {
    if (this.consuming) {
      this.wakeRequested = true;
      return;
    }
    this.consuming = true;
    this.queueSrv.addTask(() => this.consume());
  }

  /**
   * 消费段：claim → 分派 → 写终态 → 空则自退
   *
   * ⚠ 丢唤醒守卫：判定队列空与真的返回之间有一个窗口，此时必须再确认一次
   * （wakeRequested），否则刚入队那条永远躺着。
   */
  private async consume(): Promise<void> {
    try {
      while (!this.stopping) {
        const run = await this.claimNext();
        if (run === null) {
          break;
        }
        await this.executeRun(run);
      }
    } finally {
      this.consuming = false;
      // 收尾前再确认一次：窗口期内若有新入队，重新唤醒
      // ⚠ 这里的「先清标志、再 wake()」依赖 wake() 只在 consuming 为真时置标志：
      // 此时已经置 false，wake() 走的是启动分支，标志才真正被消费掉；否则会自激。
      if (this.wakeRequested && !this.stopping) {
        this.wakeRequested = false;
        this.wake();
      }
    }
  }

  /** 原子取号：排队 → 执行中 */
  private async claimNext(): Promise<SyncRunEntity | null> {
    const result = await this.runRepo
      .createQueryBuilder()
      .update()
      .set({ state: SYNC_STATE.RUNNING, startedAt: () => 'now()' })
      .where('id = (SELECT id FROM sync_runs WHERE state = :state ORDER BY id ASC LIMIT 1)', {
        state: SYNC_STATE.QUEUED,
      })
      .returning('id')
      .execute();

    // ⚠ RETURNING 给的是数据库列名（蛇形），`create(raw)` 不会把它映射成实体驼峰属性
    // （taskId/fromDate/toDate 会静默变成 undefined）。只取回 id，再按 id 回查一次拿完整实体。
    const raw = result.raw?.[0] as { id?: string } | undefined;
    if (!raw?.id) {
      return null;
    }
    return this.runRepo.findOneBy({ id: raw.id });
  }

  /** 分派执行（按 target 走对应同步器） */
  private async executeRun(run: SyncRunEntity): Promise<void> {
    const task = await this.taskRepo.findOneBy({ id: run.taskId });
    if (task === null) {
      await this.finishRun(run.id, 'skip', '任务已不存在');
      return;
    }

    const progress = this.makeProgress(run.id);

    try {
      const target = run.target as SyncTarget;
      const code = run.code;
      const from = run.fromDate;
      const to = run.toDate;

      let result: SyncResult;

      switch (target) {
        case SYNC_TARGET.SECURITY:
          result = await syncSecurities(
            {
              client: this.client,
              store: {
                upsertSecurities: (rows) =>
                  this.upsertSecurities(rows as SecurityEntity[]),
              },
              saveWatermark: (wm) => this.saveWatermark(wm),
              today: () => this.today(),
              countSecurities: () => this.securityRepo.count(),
              shouldAbort: () => this.isAborted(run.id),
            },
            progress,
          );
          break;
        case SYNC_TARGET.CALENDAR:
          result = await syncCalendar(
            {
              client: this.client,
              store: {
                upsertCalendar: (rows) => this.upsertCalendar(rows as TradeCalendarEntity[]),
                countCalendar: () => this.calendarRepo.count(),
              },
              findWatermark: (scope, dataset) => this.findWatermark(scope, dataset),
              saveWatermark: (wm) => this.saveWatermark(wm),
              today: () => this.today(),
            },
            from,
            to,
            progress,
          );
          break;
        case SYNC_TARGET.BAR_BY_DATE:
          result = await syncBarByDate(
            code,
            from,
            to,
            {
              ...this.makeDailyDeps(run.id, () => this.barRepo.count()),
              store: { upsertBars: (rows) => this.upsertBars(rows as BarEntity[]) },
            },
            progress,
          );
          break;
        case SYNC_TARGET.ADJUST_FACTOR:
          result = await syncAdjustFactor(
            code,
            from,
            to,
            {
              ...this.makeDailyDeps(run.id, () => this.factorRepo.count()),
              store: { upsertFactors: (rows) => this.upsertFactors(rows as AdjustFactorEntity[]) },
            },
            progress,
          );
          break;
        default:
          await this.finishRun(run.id, 'skip', `未知的同步类型：${target}`);
          return;
      }

      if (result.ok) {
        await this.finishRun(run.id, 'success', result.stage, result.rowsWritten);
      } else {
        await this.finishRun(run.id, 'fail', result.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`执行 ${run.id} 失败：${message}`);
      await this.finishRun(run.id, 'fail', message);
    }
  }

  /**
   * 按交易日同步器的依赖装配
   *
   * @param runId 当前执行 Id（取消检查要用它回读状态）
   * @param countRows 该数据集的总行数（用于校正台账记录数）
   */
  private makeDailyDeps(runId: string, countRows: () => Promise<number>) {
    return {
      client: this.client,
      findWatermark: (scope: string, dataset: string) => this.findWatermark(scope, dataset),
      saveWatermark: (wm: Watermark) => this.saveWatermark(wm),
      countRows,
      shouldAbort: () => this.isAborted(runId),
      warn: (message: string) => this.logger.warn(message),
      latestCalendarDate: async () => {
        const latest = await this.calendarRepo
          .createQueryBuilder('c')
          .select('MAX(c.calendarDate)', 'max')
          .getRawOne<{ max: string | null }>();
        return latest?.max ?? null;
      },
      calendarRange: async (from: string, to: string) => {
        const rows = await this.calendarRepo
          .createQueryBuilder('c')
          .where('c.calendarDate >= :from AND c.calendarDate <= :to', { from, to })
          .orderBy('c.calendarDate', 'ASC')
          .getMany();
        return rows.map((r) => ({ date: r.calendarDate, isOpen: r.isOpen }));
      },
    };
  }

  /**
   * 进度上报（写回 sync_runs）
   *
   * ⚠ 必须串行：`report` 会被同步器连续调用（一页一次 / 一天一次），并发发出去的 UPDATE
   *    到达顺序无保证，进度条会「回退」。这里挂到一条 Promise 链上，顺序与调用顺序一致。
   */
  private makeProgress(runId: string): { report: (p: ProgressReport) => void } {
    return {
      report: (p) => {
        this.progressTail = this.progressTail
          .then(async () => {
            const result = await this.runRepo.update(
              { id: runId, state: SYNC_STATE.RUNNING },
              { stage: p.stage, done: String(p.done), total: String(p.total) },
            );
            if ((result.affected ?? 0) > 0) {
              this.gateway.broadcast('progress');
            }
          })
          .catch((err: unknown) => {
            // 进度写不进去不该影响同步本身：记一条日志即可
            this.logger.warn(
              `执行 ${runId} 的进度写库失败：${err instanceof Error ? err.message : String(err)}`,
            );
          });
      },
    };
  }

  /**
   * 该执行是否已被取消（暂停 / 被别处改成别的状态 / 行被删）
   *
   * 同步器在「一天或一页走完」的边界上问一次 —— 这是暂停唯一能生效的位置，
   * 中途打断会让当天写了一半的数据失去台账保护。
   */
  private async isAborted(runId: string): Promise<boolean> {
    const row = await this.runRepo.findOneBy({ id: runId });
    return row === null || row.state !== SYNC_STATE.RUNNING;
  }

  /**
   * 写终态
   *
   * ⚠ 条件更新（`WHERE state = RUNNING`）：执行期间可能已被 `pause()` 改成 PAUSED，
   *   此时不能再把成功 / 失败盖上去 —— 那会让「暂停」看起来像「跑完了」。
   */
  private async finishRun(
    runId: string,
    outcome: 'success' | 'fail' | 'skip',
    stage: string,
    rowsWritten = 0,
  ): Promise<void> {
    const state =
      outcome === 'success'
        ? SYNC_STATE.SUCCEEDED
        : outcome === 'skip'
          ? SYNC_STATE.SKIPPED
          : SYNC_STATE.FAILED;
    const result = await this.runRepo.update(
      { id: runId, state: SYNC_STATE.RUNNING },
      {
        state,
        stage,
        rowsWritten: String(rowsWritten),
        finishedAt: () => 'now()',
      },
    );
    if ((result.affected ?? 0) === 0) {
      // 状态已被别处改写（最常见就是暂停）⇒ 保留它，不当成正常收尾
      this.logger.warn(
        `执行 ${runId} 收尾时已不是「执行中」（可能被暂停），保留现有状态：${stage}`,
      );
      return;
    }
    this.gateway.broadcast('finish');
  }

  // ── 仓储适配 ────────────────────────────────────────────────────────────

  private async findWatermark(scope: string, dataset: string): Promise<Watermark | null> {
    const row = await this.coverageRepo.findOneBy({
      scope,
      dataset,
      parameters: '',
    });
    if (row === null) {
      return null;
    }
    return {
      scope: row.scope,
      dataset: row.dataset,
      parameters: row.parameters,
      lastDate: row.lastDate,
      rows: Number(row.recordCount ?? 0),
    };
  }

  private async saveWatermark(wm: Watermark): Promise<void> {
    await this.coverageRepo.upsert(
      {
        scope: wm.scope,
        dataset: wm.dataset,
        parameters: wm.parameters,
        lastDate: wm.lastDate,
        recordCount: String(wm.rows),
      },
      ['scope', 'dataset', 'parameters'],
    );
  }

  private async upsertSecurities(rows: SecurityEntity[]): Promise<number> {
    const result = await this.securityRepo.upsert(rows, ['code']);
    return result.identifiers.length;
  }

  private async upsertCalendar(rows: TradeCalendarEntity[]): Promise<number> {
    const result = await this.calendarRepo.upsert(rows, ['calendarDate']);
    return result.identifiers.length;
  }

  private async upsertBars(rows: BarEntity[]): Promise<number> {
    const result = await this.barRepo.upsert(rows, ['code', 'date']);
    return result.identifiers.length;
  }

  private async upsertFactors(rows: AdjustFactorEntity[]): Promise<number> {
    const result = await this.factorRepo.upsert(rows, ['code', 'operateDate']);
    return result.identifiers.length;
  }

  private today(): string {
    // 业务时区钉死 Asia/Shanghai
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    return now.toISOString().slice(0, 10);
  }

  // ── 对外接口（控制器调用）───────────────────────────────────────────────

  /** 入队（从台账断点续） */
  async start(target: SyncTarget): Promise<{ enqueued: number; blocked: number; note: string }> {
    const request: SyncRequest = {
      target,
      codes: [],
      from: null,
      to: null,
    };
    const option: SyncStartOption = { source: 'manual', plan: '' };

    const svc = new SyncPlanService({
      earliestCalendarDate: async () => {
        const earliest = await this.calendarRepo
          .createQueryBuilder('c')
          .select('MIN(c.calendarDate)', 'min')
          .getRawOne<{ min: string | null }>();
        return earliest?.min ?? null;
      },
      allStockCodes: async () => {
        const rows = await this.securityRepo
          .createQueryBuilder('s')
          .where("s.type = 'Stock'")
          .select('s.code', 'code')
          .orderBy('s.code', 'ASC')
          .getRawMany<{ code: string }>();
        return rows.map((r) => r.code);
      },
      ensureTasks: async (t, codes) => {
        const map = new Map<string, number>();
        for (const code of codes) {
          let task = await this.taskRepo.findOneBy({ target: t, code });
          if (task === null) {
            task = await this.taskRepo.save(
              this.taskRepo.create({ target: t, code, enabled: true }),
            );
          }
          map.set(code, Number(task.id));
        }
        return map;
      },
      enqueue: async (runs) => {
        const enqueuedIds: number[] = [];
        let blocked = 0;
        for (const r of runs) {
          try {
            const saved = await this.runRepo.save(
              this.runRepo.create({
                taskId: String(r.taskId),
                target: r.target,
                code: r.code,
                state: SYNC_STATE.QUEUED,
                source: r.source,
                planDate: r.plan,
                fromDate: r.from,
                toDate: r.to,
              }),
            );
            enqueuedIds.push(Number(saved.id));
          } catch {
            // 被部分唯一索引挡下（同一任务已有活跃执行）
            blocked++;
          }
        }
        return { enqueuedIds, blocked };
      },
      today: () => this.today(),
    });

    const result = await svc.plan(request, option);
    if ('error' in result) {
      throw new BadRequestException(result.error.message);
    }
    if (result.plan.enqueuedIds.length > 0) {
      this.gateway.broadcast('enqueue');
      this.wake();
    }
    return {
      enqueued: result.plan.enqueuedIds.length,
      blocked: result.plan.blocked,
      note: result.plan.note,
    };
  }

  /** 暂停该 target 所有 Running 的执行 */
  async pause(target: SyncTarget): Promise<{ paused: number }> {
    const result = await this.runRepo.update(
      { target, state: SYNC_STATE.RUNNING },
      { state: SYNC_STATE.PAUSED, finishedAt: () => 'now()' },
    );
    const paused = result.affected ?? 0;
    if (paused > 0) {
      this.gateway.broadcast('pause');
    }
    return { paused };
  }

  /**
   * 快照：四卡汇总 + 当前进度 + 队列计数 + 最近执行
   *
   * ⚠ 队列计数必须走 `count()`，不能用「取一页行再数」：`take` 会把计数钉死在页长上
   *   （队列 30 条也只显示 20），是「界面上的队列长度不对」的直接来源。
   * ⚠ 「最近执行」要同时给活跃行与刚结束的行：只查活跃行会让一次执行在收尾瞬间从列表里消失，
   *   失败原因（写在 stage 里）就再也看不到了。
   */
  async snapshot(): Promise<SnapshotResult> {
    const cards = await Promise.all([
      this.cardOf(SYNC_TARGET.CALENDAR),
      this.cardOf(SYNC_TARGET.SECURITY),
      this.cardOf(SYNC_TARGET.BAR_BY_DATE),
      this.cardOf(SYNC_TARGET.ADJUST_FACTOR),
    ]);

    const [queued, running, active, finished] = await Promise.all([
      this.runRepo.count({ where: { state: SYNC_STATE.QUEUED } }),
      this.runRepo.count({ where: { state: SYNC_STATE.RUNNING } }),
      this.runRepo.find({
        where: [{ state: SYNC_STATE.QUEUED }, { state: SYNC_STATE.RUNNING }],
        order: { id: 'ASC' },
        take: 20,
      }),
      this.runRepo.find({
        where: { state: In(TERMINAL_STATES) },
        order: { id: 'DESC' },
        take: 10,
      }),
    ]);

    return {
      cards,
      queue: { queued, running },
      recent: [...active.map(toRecentRun), ...finished.map(toRecentRun)],
    };
  }

  /** 单卡汇总（带上最近一次执行的进度，卡面才显示得出百分比） */
  private async cardOf(target: SyncTarget): Promise<CardSummary> {
    const scope = coverageScopeOf(target);
    const wm = await this.findWatermark(scope, this.datasetOf(target));
    const latest = await this.latestRunOf(target);

    return {
      target,
      displayName: displayNameOf(target),
      lastDate: wm?.lastDate ?? null,
      recordCount: wm?.rows ?? 0,
      state: latest?.state ?? null,
      stage: latest?.stage ?? null,
      done: Number(latest?.done ?? 0),
      total: Number(latest?.total ?? 0),
      updatedAt: toIso(latest?.finishedAt ?? latest?.startedAt ?? null),
    };
  }

  private datasetOf(target: SyncTarget): string {
    switch (target) {
      case SYNC_TARGET.CALENDAR:
      case SYNC_TARGET.SECURITY:
        return '*';
      case SYNC_TARGET.BAR_BY_DATE:
        return 'bar';
      case SYNC_TARGET.ADJUST_FACTOR:
        return 'adjustFactor';
      default:
        return '';
    }
  }

  private async latestRunOf(target: SyncTarget): Promise<SyncRunEntity | null> {
    return this.runRepo.findOne({
      where: { target },
      order: { id: 'DESC' },
    });
  }
}

/** 快照结果 */
export interface SnapshotResult {
  cards: CardSummary[];
  queue: { queued: number; running: number };
  recent: RecentRun[];
}

export interface CardSummary {
  target: string;
  displayName: string;
  lastDate: string | null;
  recordCount: number;
  state: number | null;
  /** 最近一次执行的阶段文案（失败原因就在这里） */
  stage: string | null;
  /** 最近一次执行的已完成量 */
  done: number;
  /** 最近一次执行的总量（0 = 未知） */
  total: number;
  /** 最近一次执行的开始/结束时刻（ISO 串，null = 从未执行） */
  updatedAt: string | null;
}

export interface RecentRun {
  id: number;
  target: string;
  state: number;
  stage: string;
  done: number;
  total: number;
}

/** 执行行 → 快照里的一行（bigint 列一律转 number，前端不再处理字符串数值） */
function toRecentRun(row: SyncRunEntity): RecentRun {
  return {
    id: Number(row.id),
    target: row.target,
    state: row.state,
    stage: row.stage ?? '',
    done: Number(row.done ?? 0),
    total: Number(row.total ?? 0),
  };
}

/** 时间列 → ISO 串（数据库可能给 Date，也可能给字符串，两种都认） */
function toIso(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}
