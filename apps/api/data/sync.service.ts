// 外部依赖
import {
  BadRequestException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  /** 唤醒消费（幂等：消费循环已在跑则只记一个信号） */
  wake(): void {
    this.wakeRequested = true;
    if (!this.consuming) {
      this.consuming = true;
      this.queueSrv.addTask(() => this.consume());
    }
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
      .returning('*')
      .execute();

    const raw = result.raw?.[0];
    if (!raw) {
      return null;
    }
    return this.runRepo.create(raw as SyncRunEntity);
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
            { client: this.client, store: { upsertSecurities: (rows) => this.upsertSecurities(rows as SecurityEntity[]) } },
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
              ...this.makeDailyDeps(),
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
              ...this.makeDailyDeps(),
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

  private makeDailyDeps() {
    return {
      client: this.client,
      findWatermark: (scope: string, dataset: string) => this.findWatermark(scope, dataset),
      saveWatermark: (wm: Watermark) => this.saveWatermark(wm),
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

  /** 进度上报（写回 sync_runs，节流由 report 频率决定） */
  private makeProgress(runId: string): { report: (p: ProgressReport) => void } {
    return {
      report: (p) => {
        void this.runRepo
          .update(
            { id: runId, state: SYNC_STATE.RUNNING },
            { stage: p.stage, done: String(p.done), total: String(p.total) },
          )
          .then((r) => {
            if ((r.affected ?? 0) > 0) {
              this.gateway.broadcast('progress');
            }
          });
      },
    };
  }

  /** 写终态 */
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
    await this.runRepo.update(
      { id: runId },
      {
        state,
        stage,
        rowsWritten: String(rowsWritten),
        finishedAt: () => 'now()',
      },
    );
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

  /** 快照：四卡汇总 + 当前进度 + 队列计数 */
  async snapshot(): Promise<SnapshotResult> {
    const cards = await Promise.all([
      this.cardOf(SYNC_TARGET.CALENDAR),
      this.cardOf(SYNC_TARGET.SECURITY),
      this.cardOf(SYNC_TARGET.BAR_BY_DATE),
      this.cardOf(SYNC_TARGET.ADJUST_FACTOR),
    ]);

    const active = await this.runRepo.find({
      where: [{ state: SYNC_STATE.QUEUED }, { state: SYNC_STATE.RUNNING }],
      order: { id: 'ASC' },
      take: 20,
    });

    return {
      cards,
      queue: {
        queued: active.filter((r) => r.state === SYNC_STATE.QUEUED).length,
        running: active.filter((r) => r.state === SYNC_STATE.RUNNING).length,
      },
      recent: active.map((r) => ({
        id: Number(r.id),
        target: r.target,
        state: r.state,
        stage: r.stage,
        done: Number(r.done ?? 0),
        total: Number(r.total ?? 0),
      })),
    };
  }

  /** 单卡汇总 */
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
      updatedAt: null,
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
