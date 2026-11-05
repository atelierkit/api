// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SyncService } from './sync.service.js';
import { DataGateway } from './data.gateway.js';
import { SYNC_STATE, SYNC_TARGET } from './sync/sync.types.js';
import { MAX_BIND_PARAMS } from './sync/write-chunk.js';
import type { QueueService } from '@shared';

/** 造一个 mock repository */
function mockRepo(overrides: Record<string, unknown> = {}) {
  return { ...overrides } as never;
}

/**
 * 日历仓储的默认替身：空日历
 *
 * 定时补更巡检在启动时就会跑一次，未显式提供 calendarRepo 的用例若拿到空对象，
 * 会走 catch 分支打一条「createQueryBuilder is not a function」的告警 —— 那是测试噪音，
 * 不是被测行为。空日历让巡检按「日历未覆盖」的既定路径静默返回。
 */
function emptyCalendarRepo(): Record<string, unknown> {
  return {
    findOneBy: vi.fn(async () => null),
    createQueryBuilder: vi.fn(() => {
      const qb = {
        select: vi.fn(() => qb),
        where: vi.fn(() => qb),
        getRawOne: vi.fn(async () => ({ max: null, min: null })),
      };
      return qb;
    }),
  };
}

/** 构造 SyncService（注入 mock 依赖） */
function makeService(deps: {
  coverageRepo?: Record<string, unknown>;
  runRepo?: Record<string, unknown>;
  taskRepo?: Record<string, unknown>;
  securityRepo?: Record<string, unknown>;
  calendarRepo?: Record<string, unknown>;
} = {}): {
  svc: SyncService;
  gateway: { broadcast: ReturnType<typeof vi.fn> };
  queue: { addTask: ReturnType<typeof vi.fn> };
} {
  const gateway = { broadcast: vi.fn() };
  const queue = { addTask: vi.fn() } as unknown as QueueService;

  const svc = new SyncService(
    queue,
    gateway as unknown as DataGateway,
    mockRepo(deps.taskRepo),
    mockRepo(deps.runRepo),
    mockRepo(deps.coverageRepo),
    mockRepo(deps.securityRepo),
    mockRepo(deps.calendarRepo ?? emptyCalendarRepo()),
    mockRepo(),
    mockRepo(),
  );
  return { svc, gateway, queue };
}

describe('SyncService', () => {
  it('snapshot 返回四卡 + 队列计数', async () => {
    const coverageRepo = {
      findOneBy: vi.fn(async () => null), // 四张卡都没台账
    };
    const runRepo = {
      count: vi.fn(async () => 0), // 无活跃执行
      find: vi.fn(async () => []), // 活跃 + 终态都为空
      findOne: vi.fn(async () => null), // 无历史执行
    };
    const { svc } = makeService({ coverageRepo, runRepo });

    const result = await svc.snapshot();

    expect(result.cards).toHaveLength(4);
    expect(result.queue).toEqual({ queued: 0, running: 0 });
    expect(result.recent).toEqual([]);
    // 四张卡的 target
    expect(result.cards.map((c) => c.target)).toEqual([
      SYNC_TARGET.CALENDAR,
      SYNC_TARGET.SECURITY,
      SYNC_TARGET.BAR_BY_DATE,
      SYNC_TARGET.ADJUST_FACTOR,
    ]);
  });

  it('snapshot 的队列计数走 count()，不受分页长度影响', async () => {
    const coverageRepo = { findOneBy: vi.fn(async () => null) };
    // 30 条在排队、2 条在跑：计数不能被 take 截断成页长
    const count = vi.fn(async (options: { where: { state: number } }) =>
      options.where.state === SYNC_STATE.QUEUED ? 30 : 2,
    );
    const runRepo = {
      count,
      // 第一次查活跃、第二次查终态（这里没有已结束的执行）
      find: vi
        .fn()
        .mockResolvedValueOnce([
          { id: '1', state: SYNC_STATE.QUEUED, target: 'BarByDate', stage: '', done: '0', total: '0' },
          { id: '2', state: SYNC_STATE.RUNNING, target: 'AdjustFactor', stage: '同步中', done: '3', total: '10' },
        ])
        .mockResolvedValueOnce([]),
      findOne: vi.fn(async () => null),
    };
    const { svc } = makeService({ coverageRepo, runRepo });

    const result = await svc.snapshot();
    expect(result.queue).toEqual({ queued: 30, running: 2 });
    expect(result.recent).toHaveLength(2);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('snapshot 的最近执行同时包含活跃行与刚结束的行', async () => {
    const coverageRepo = { findOneBy: vi.fn(async () => null) };
    const runRepo = {
      count: vi.fn(async () => 0),
      // 第一次查活跃（ASC），第二次查终态（DESC）
      find: vi
        .fn()
        .mockResolvedValueOnce([
          { id: '9', state: SYNC_STATE.RUNNING, target: 'BarByDate', stage: '同步中', done: '5', total: '10' },
        ])
        .mockResolvedValueOnce([
          { id: '8', state: SYNC_STATE.FAILED, target: 'Calendar', stage: '连接失败', done: '0', total: '0' },
        ]),
      findOne: vi.fn(async () => null),
    };
    const { svc } = makeService({ coverageRepo, runRepo });

    const result = await svc.snapshot();

    // 活跃行在前、刚结束的行在后；失败原因（stage）不会因为收尾而消失
    expect(result.recent).toEqual([
      { id: 9, target: 'BarByDate', state: SYNC_STATE.RUNNING, stage: '同步中', done: 5, total: 10 },
      { id: 8, target: 'Calendar', state: SYNC_STATE.FAILED, stage: '连接失败', done: 0, total: 0 },
    ]);
    // 终态查询按状态集合过滤，不是「除活跃之外的全部」
    expect(runRepo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { state: expect.anything() } }),
    );
  });

  it('snapshot 的卡片带上最近一次执行的进度与更新时刻', async () => {
    const coverageRepo = {
      findOneBy: vi.fn(async () => ({
        scope: 'bar.byDate',
        dataset: 'bar',
        parameters: '',
        lastDate: '2026-01-05',
        recordCount: '123',
      })),
    };
    const runRepo = {
      count: vi.fn(async () => 0),
      find: vi.fn(async () => []),
      // 执行中：没有结束时刻 ⇒ updatedAt 取「进度最后一次写回的时刻」，而不是开始时刻
      findOne: vi.fn(async () => ({
        state: SYNC_STATE.RUNNING,
        stage: '同步全市场日线',
        done: '5',
        total: '10',
        startedAt: new Date('2026-01-05T01:00:00.000Z'),
        progressAt: new Date('2026-01-05T01:07:30.000Z'),
        finishedAt: null,
      })),
    };
    const { svc } = makeService({ coverageRepo, runRepo });

    const result = await svc.snapshot();

    expect(result.cards[0]).toMatchObject({
      target: SYNC_TARGET.CALENDAR,
      stage: '同步全市场日线',
      done: 5,
      total: 10,
      updatedAt: '2026-01-05T01:07:30.000Z',
      state: SYNC_STATE.RUNNING,
    });
  });

  it('snapshot 的更新时刻优先级：结束时刻 > 进度打点 > 开始时刻', async () => {
    const coverageRepo = { findOneBy: vi.fn(async () => null) };
    const runOf = (row: Record<string, unknown>): Record<string, unknown> => ({
      count: vi.fn(async () => 0),
      find: vi.fn(async () => []),
      findOne: vi.fn(async () => ({
        state: SYNC_STATE.RUNNING,
        stage: '',
        done: '0',
        total: '0',
        startedAt: new Date('2026-01-05T01:00:00.000Z'),
        progressAt: null,
        finishedAt: null,
        ...row,
      })),
    });

    // 刚启动、还没上报过进度 ⇒ 退回开始时刻（否则卡片上是空白）
    const started = await makeService({ coverageRepo, runRepo: runOf({}) }).svc.snapshot();
    expect(started.cards[0].updatedAt).toBe('2026-01-05T01:00:00.000Z');

    // 已收尾 ⇒ 结束时刻最准，不被进度打点盖住
    const finished = await makeService({
      coverageRepo,
      runRepo: runOf({
        state: SYNC_STATE.SUCCEEDED,
        progressAt: new Date('2026-01-05T01:07:30.000Z'),
        finishedAt: new Date('2026-01-05T01:09:00.000Z'),
      }),
    }).svc.snapshot();
    expect(finished.cards[0].updatedAt).toBe('2026-01-05T01:09:00.000Z');
  });

  it('进度上报同时写「进度打点时刻」（卡片最后更新的唯一来源）', async () => {
    const runRepo = { update: vi.fn(async () => ({ affected: 1 })) };
    const { svc, gateway } = makeService({ runRepo });

    const sink = (
      svc as unknown as { makeProgress: (id: string) => { report: (p: unknown) => void } }
    ).makeProgress('10');
    sink.report({ stage: '同步全市场日线', done: 5, total: 10 });
    // report 挂在串行 Promise 链上，等它落地再断言
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '10', state: SYNC_STATE.RUNNING },
      expect.objectContaining({
        stage: '同步全市场日线',
        done: '5',
        total: '10',
        // 由库端 now() 求值：执行中每批进度都会刷新这个时刻
        progressAt: expect.any(Function),
      }),
    );
    expect(gateway.broadcast).toHaveBeenCalledWith('progress');
  });

  it('pause 把 Running 的执行置为 Paused 并广播', async () => {
    const runRepo = {
      update: vi.fn(async () => ({ affected: 2 })),
    };
    const { svc, gateway } = makeService({ runRepo });

    const result = await svc.pause(SYNC_TARGET.BAR_BY_DATE);

    expect(result.paused).toBe(2);
    expect(runRepo.update).toHaveBeenCalledWith(
      { target: SYNC_TARGET.BAR_BY_DATE, state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.PAUSED }),
    );
    expect(gateway.broadcast).toHaveBeenCalledWith('pause');
  });

  it('pause 无 Running 时不广播', async () => {
    const runRepo = { update: vi.fn(async () => ({ affected: 0 })) };
    const { svc, gateway } = makeService({ runRepo });

    const result = await svc.pause(SYNC_TARGET.ADJUST_FACTOR);
    expect(result.paused).toBe(0);
    expect(gateway.broadcast).not.toHaveBeenCalled();
  });

  it('start 入队成功后唤醒并广播', async () => {
    // 日历替身：MIN 定起点、MAX 定覆盖末日、今天开市 + 前一交易日定「同步上界」
    const calendarRepo = {
      findOneBy: vi.fn(async () => ({ calendarDate: '2026-11-05', isOpen: true })),
      createQueryBuilder: vi.fn(() => {
        const qb = {
          field: '',
          filtered: false,
          select: vi.fn((field: string) => {
            qb.field = field;
            return qb;
          }),
          where: vi.fn(() => {
            qb.filtered = true;
            return qb;
          }),
          getRawOne: vi.fn(async () => {
            if (qb.field.startsWith('MIN')) {
              return { min: '1990-12-19' };
            }
            return qb.filtered ? { max: '2026-10-30' } : { max: '2026-11-05' };
          }),
        };
        return qb;
      }),
    };
    const taskRepo = {
      findOneBy: vi.fn(async () => ({ id: '1' })),
      save: vi.fn(async (e: unknown) => e),
      create: vi.fn((e: unknown) => e),
    };
    const runRepo = {
      save: vi.fn(async (e: unknown) => e),
      create: vi.fn((e: unknown) => e),
    };
    const securityRepo = {
      createQueryBuilder: vi.fn(() => {
        const qb = {
          where: vi.fn(() => qb),
          select: vi.fn(() => qb),
          orderBy: vi.fn(() => qb),
          getRawMany: vi.fn(async () => []),
        };
        return qb;
      }),
    };

    const { svc, gateway } = makeService({ calendarRepo, taskRepo, runRepo, securityRepo });

    const result = await svc.start(SYNC_TARGET.BAR_BY_DATE);
    expect(result.enqueued).toBe(1);
    expect(gateway.broadcast).toHaveBeenCalledWith('enqueue');
  });

  it('定时补更：交易日 20:00 后把当天补进日 K 与复权因子（含当天）', async () => {
    // 北京时间 2026-11-05 21:00
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T13:00:00.000Z'));
    try {
      const calendarRepo = {
        findOneBy: vi.fn(async () => ({ calendarDate: '2026-11-05', isOpen: true })),
        createQueryBuilder: vi.fn(() => {
          const qb = {
            field: '',
            filtered: false,
            select: vi.fn((field: string) => {
              qb.field = field;
              return qb;
            }),
            where: vi.fn(() => {
              qb.filtered = true;
              return qb;
            }),
            getRawOne: vi.fn(async () => {
              if (qb.field.startsWith('MIN')) {
                return { min: '1990-12-19' };
              }
              // 无 where = 日历覆盖末日；带 where = 前一交易日
              return qb.filtered ? { max: '2026-11-04' } : { max: '2026-11-05' };
            }),
          };
          return qb;
        }),
      };
      const taskRepo = {
        findOneBy: vi.fn(async () => ({ id: '1' })),
        save: vi.fn(async (e: unknown) => e),
        create: vi.fn((e: unknown) => e),
      };
      let seq = 0;
      const runRepo = {
        // 今天还没排过（查重为空）
        findOneBy: vi.fn(async () => null),
        save: vi.fn(async (e: unknown) => ({ ...(e as object), id: String(++seq) })),
        create: vi.fn((e: unknown) => e),
      };

      const { svc, gateway } = makeService({ calendarRepo, taskRepo, runRepo });
      await (
        svc as unknown as { dailyCatchUpTick: () => Promise<void> }
      ).dailyCatchUpTick();

      // 日 K 与复权因子各一条，上界都是当天、来源是 auto、plan_date 带日期（幂等标记）
      expect(runRepo.save).toHaveBeenCalledTimes(2);
      const created = runRepo.create.mock.calls.map(
        (call) =>
          call[0] as { target: string; toDate: string; planDate: string; source: string },
      );
      expect(created.map((r) => r.target)).toEqual([
        SYNC_TARGET.BAR_BY_DATE,
        SYNC_TARGET.ADJUST_FACTOR,
      ]);
      expect(created.map((r) => r.toDate)).toEqual(['2026-11-05', '2026-11-05']);
      expect(created.map((r) => r.source)).toEqual(['auto', 'auto']);
      expect(created.map((r) => r.planDate)).toEqual([
        'auto:daily:2026-11-05',
        'auto:daily:2026-11-05',
      ]);
      expect(gateway.broadcast).toHaveBeenCalledWith('enqueue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('定时补更：日历没覆盖到今天时不排、也不抛错', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T13:00:00.000Z'));
    try {
      const calendarRepo = {
        findOneBy: vi.fn(async () => null),
        createQueryBuilder: vi.fn(() => {
          const qb = {
            select: vi.fn(() => qb),
            where: vi.fn(() => qb),
            // 日历只覆盖到去年年底
            getRawOne: vi.fn(async () => ({ max: '2025-12-31' })),
          };
          return qb;
        }),
      };
      const runRepo = { findOneBy: vi.fn(async () => null), save: vi.fn(), create: vi.fn() };

      const { svc } = makeService({ calendarRepo, runRepo });
      await (
        svc as unknown as { dailyCatchUpTick: () => Promise<void> }
      ).dailyCatchUpTick();

      expect(runRepo.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('executeRun 处理 Security 目标：调用证券同步器并写终态', async () => {
    const taskRepo = {
      findOneBy: vi.fn(async () => ({ id: '1' })),
    };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 1 })),
      findOneBy: vi.fn(async () => ({ id: '10', state: SYNC_STATE.RUNNING })),
    };
    const securityRepo = {
      upsert: vi.fn(async () => ({ identifiers: [{ code: 'sh.600000' }] })),
      count: vi.fn(async () => 1),
    };
    // 证券同步器会写台账（卡片上的「覆盖至 / 记录数」只读台账）
    const coverageRepo = { upsert: vi.fn(async () => ({ identifiers: [{}] })) };

    const { svc, gateway } = makeService({ taskRepo, runRepo, securityRepo, coverageRepo });

    // 替换真实的 BaostockClient 为 mock（避免真连网）
    (svc as unknown as { client: unknown }).client = {
      query: vi.fn(async () => [
        new Map([
          ['code', 'sh.600000'],
          ['code_name', '浦发银行'],
          ['type', '1'],
          ['ipoDate', '1999-11-10'],
          ['outDate', ''],
          ['status', '1'],
        ]),
      ]),
      logout: vi.fn(async () => undefined),
    };

    const run = {
      id: '10',
      taskId: '1',
      target: SYNC_TARGET.SECURITY,
      code: '',
      fromDate: null,
      toDate: null,
      state: SYNC_STATE.RUNNING,
    };

    // 直接调私有 executeRun
    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);

    // 最终写终态（成功）
    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '10', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
    expect(gateway.broadcast).toHaveBeenCalledWith('finish');
  });

  it('executeRun 任务不存在时写跳过终态', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => null) };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 1 })),
      findOneBy: vi.fn(async () => ({ id: '10', state: SYNC_STATE.RUNNING })),
    };

    const { svc } = makeService({ taskRepo, runRepo });

    const run = {
      id: '10',
      taskId: '1',
      target: SYNC_TARGET.SECURITY,
      code: '',
      fromDate: null,
      toDate: null,
      state: SYNC_STATE.RUNNING,
    };

    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);

    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '10', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.SKIPPED }),
    );
  });

  it('executeRun 处理 Calendar 目标：走日历同步器', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 1 })),
      findOneBy: vi.fn(async () => ({ id: '11', state: SYNC_STATE.RUNNING })),
    };
    const coverageRepo = {
      findOneBy: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
    };
    const calendarRepo = {
      count: vi.fn(async () => 2),
      upsert: vi.fn(async () => ({ identifiers: [{}, {}] })),
    };

    const { svc } = makeService({ taskRepo, runRepo, coverageRepo, calendarRepo });
    (svc as unknown as { client: unknown }).client = {
      query: vi.fn(async () => [
        new Map([
          ['calendar_date', '2026-01-05'],
          ['is_trading_day', '1'],
        ]),
      ]),
      logout: vi.fn(async () => undefined),
    };

    const run = {
      id: '11',
      taskId: '1',
      target: SYNC_TARGET.CALENDAR,
      code: '',
      fromDate: null,
      toDate: null,
      state: SYNC_STATE.RUNNING,
    };

    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);
    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '11', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
  });

  it('executeRun 处理 BarByDate 目标：走按交易日日 K 同步器', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 1 })),
      findOneBy: vi.fn(async () => ({ id: '12', state: SYNC_STATE.RUNNING })),
    };
    const coverageRepo = {
      findOneBy: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
    };
    const calendarRepo = {
      createQueryBuilder: vi.fn(() => {
        const qb = {
          select: vi.fn(() => qb),
          getRawOne: vi.fn(async () => ({ max: '2026-01-06' })),
          where: vi.fn(() => qb),
          orderBy: vi.fn(() => qb),
          getMany: vi.fn(async () => [
            { calendarDate: '2026-01-05', isOpen: true },
          ]),
        };
        return qb;
      }),
    };
    const barRepo = {
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
      count: vi.fn(async () => 1),
    };

    const { svc } = makeService({ taskRepo, runRepo, coverageRepo, calendarRepo });
    (svc as unknown as { client: unknown }).client = {
      query: vi.fn(async () => [
        new Map([
          ['code', 'sh.600000'],
          ['date', '2026-01-05'],
          ['open', '10'],
          ['high', '11'],
          ['low', '9'],
          ['close', '10.5'],
          ['preclose', '10.2'],
          ['volume', '100'],
          ['amount', '1000'],
          ['adjustflag', '3'],
          ['turn', '0.5'],
          ['tradestatus', '1'],
          ['pctChg', '0.3'],
          ['peTTM', ''],
          ['pbMRQ', '1.2'],
          ['psTTM', '2'],
          ['pcfNcfTTM', ''],
          ['isST', '0'],
        ]),
      ]),
      logout: vi.fn(async () => undefined),
    };
    // 直接替换 barRepo
    (svc as unknown as { barRepo: unknown }).barRepo = barRepo;

    const run = {
      id: '12',
      taskId: '1',
      target: SYNC_TARGET.BAR_BY_DATE,
      code: 'bar',
      fromDate: '2026-01-05',
      toDate: '2026-01-06',
      state: SYNC_STATE.RUNNING,
    };

    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);
    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '12', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
  });

  it('executeRun 处理 AdjustFactor 目标：走复权因子同步器', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 1 })),
      findOneBy: vi.fn(async () => ({ id: '13', state: SYNC_STATE.RUNNING })),
    };
    const coverageRepo = {
      findOneBy: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
    };
    const calendarRepo = {
      createQueryBuilder: vi.fn(() => {
        const qb = {
          select: vi.fn(() => qb),
          getRawOne: vi.fn(async () => ({ max: '2026-01-05' })),
          where: vi.fn(() => qb),
          orderBy: vi.fn(() => qb),
          getMany: vi.fn(async () => [{ calendarDate: '2026-01-05', isOpen: true }]),
        };
        return qb;
      }),
    };
    const factorRepo = {
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
      count: vi.fn(async () => 1),
    };

    const { svc } = makeService({ taskRepo, runRepo, coverageRepo, calendarRepo });
    (svc as unknown as { client: unknown }).client = {
      query: vi.fn(async () => [
        new Map([
          ['code', 'sh.600000'],
          ['dividOperateDate', '2026-01-05'],
          ['foreAdjustFactor', '1.1'],
          ['backAdjustFactor', '2.5'],
          ['adjustFactor', '3'],
        ]),
      ]),
      logout: vi.fn(async () => undefined),
    };
    (svc as unknown as { factorRepo: unknown }).factorRepo = factorRepo;

    const run = {
      id: '13',
      taskId: '1',
      target: SYNC_TARGET.ADJUST_FACTOR,
      code: 'adjustFactor',
      fromDate: '2026-01-05',
      toDate: '2026-01-05',
      state: SYNC_STATE.RUNNING,
    };

    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);
    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '13', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
  });

  it('onApplicationBootstrap 回滚僵尸执行（affected>0）并唤醒', async () => {
    const runRepo = { update: vi.fn(async () => ({ affected: 2 })) };
    const { svc, queue } = makeService({ runRepo });

    await svc.onApplicationBootstrap();
    expect(runRepo.update).toHaveBeenCalledWith(
      { state: SYNC_STATE.RUNNING },
      { state: SYNC_STATE.QUEUED },
    );
    // wake 被调 → 消费任务入队
    expect(queue.addTask).toHaveBeenCalled();
  });

  it('onApplicationBootstrap 无僵尸执行（affected=0）仍唤醒', async () => {
    const runRepo = { update: vi.fn(async () => ({ affected: 0 })) };
    const { svc, queue } = makeService({ runRepo });

    await svc.onApplicationBootstrap();
    expect(queue.addTask).toHaveBeenCalled();
  });

  it('wake 幂等：消费循环已在跑时不重复入队', async () => {
    const { svc, queue } = makeService();
    // 第一次 wake 触发消费
    svc.wake();
    expect(queue.addTask).toHaveBeenCalledTimes(1);
    // 第二次 wake 不再入队（consuming 已为 true）
    svc.wake();
    expect(queue.addTask).toHaveBeenCalledTimes(1);
  });

  it('消费段结束后队列仍空 ⇒ 不自我重启（否则空转打满数据库 CPU）', async () => {
    // 队列空：claimNext 的 UPDATE 命中 0 行，返回 null
    const qb = {
      update: vi.fn(() => qb),
      set: vi.fn(() => qb),
      where: vi.fn(() => qb),
      returning: vi.fn(() => qb),
      execute: vi.fn(async () => ({ raw: [] })),
    };
    const runRepo = { createQueryBuilder: vi.fn(() => qb) };
    const { svc, queue } = makeService({ runRepo });

    svc.wake();
    expect(queue.addTask).toHaveBeenCalledTimes(1);

    // 执行排队的消费任务：队列空 ⇒ 取号即退出
    const consume = queue.addTask.mock.calls[0][0] as () => Promise<void>;
    await consume();

    // 关键断言：收尾后不许再入队。旧实现在此处会无限自激（每秒数百次空 UPDATE）
    expect(queue.addTask).toHaveBeenCalledTimes(1);
    expect(qb.execute).toHaveBeenCalledTimes(1);
  });

  it('消费期间有新入队 ⇒ 收尾时重启一次，且之后不再自激', async () => {
    const qb = {
      update: vi.fn(() => qb),
      set: vi.fn(() => qb),
      where: vi.fn(() => qb),
      returning: vi.fn(() => qb),
      execute: vi.fn(async () => ({ raw: [] })),
    };
    const runRepo = { createQueryBuilder: vi.fn(() => qb) };
    const { svc, queue } = makeService({ runRepo });

    svc.wake();
    const consume = queue.addTask.mock.calls[0][0] as () => Promise<void>;

    // 消费段还在跑（consuming=true）时又入队 ⇒ 只记信号
    const running = consume();
    svc.wake();
    await running;

    // 丢唤醒守卫生效：收尾时重启一次
    expect(queue.addTask).toHaveBeenCalledTimes(2);

    // 第二次消费仍无任务 ⇒ 标志已被消费掉，不再入队（这里若继续增长即为自激复发）
    const second = queue.addTask.mock.calls[1][0] as () => Promise<void>;
    await second();
    expect(queue.addTask).toHaveBeenCalledTimes(2);
    expect(qb.execute).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy 停止并登出', async () => {
    const { svc } = makeService();
    const client = { logout: vi.fn(async () => undefined) };
    (svc as unknown as { client: unknown }).client = client;
    svc.onModuleDestroy();
    expect(client.logout).toHaveBeenCalled();
  });

  it('收尾时状态已被改成「暂停」⇒ 不覆盖成成功、也不广播 finish', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    // 条件更新（WHERE state = RUNNING）命中 0 行 = 已被暂停
    const runRepo = {
      update: vi.fn(async () => ({ affected: 0 })),
      findOneBy: vi.fn(async () => ({ id: '11', state: SYNC_STATE.PAUSED })),
    };
    const coverageRepo = {
      findOneBy: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
    };
    const calendarRepo = {
      count: vi.fn(async () => 2),
      upsert: vi.fn(async () => ({ identifiers: [{}, {}] })),
    };

    const { svc, gateway } = makeService({ taskRepo, runRepo, coverageRepo, calendarRepo });
    (svc as unknown as { client: unknown }).client = {
      query: vi.fn(async () => [
        new Map([
          ['calendar_date', '2026-01-05'],
          ['is_trading_day', '1'],
        ]),
      ]),
      logout: vi.fn(async () => undefined),
    };

    const run = {
      id: '11',
      taskId: '1',
      target: SYNC_TARGET.CALENDAR,
      code: '',
      fromDate: null,
      toDate: null,
      state: SYNC_STATE.RUNNING,
    };

    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);

    // 终态写入带「必须还是执行中」的条件
    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '11', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
    // 0 行被改 ⇒ 不广播，避免界面把「暂停」显示成「跑完了」
    expect(gateway.broadcast).not.toHaveBeenCalledWith('finish');
  });

  it('执行中检测到已暂停 ⇒ 在日边界提前收尾（阶段文案带「已暂停」）', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 0 })),
      // 第一次（进度）之后就被暂停：所有回读都返回 PAUSED
      findOneBy: vi.fn(async () => ({ id: '12', state: SYNC_STATE.PAUSED })),
    };
    const coverageRepo = {
      findOneBy: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
    };
    const calendarRepo = {
      createQueryBuilder: vi.fn(() => {
        const qb = {
          select: vi.fn(() => qb),
          getRawOne: vi.fn(async () => ({ max: '2026-01-06' })),
          where: vi.fn(() => qb),
          orderBy: vi.fn(() => qb),
          getMany: vi.fn(async () => [
            { calendarDate: '2026-01-05', isOpen: true },
            { calendarDate: '2026-01-06', isOpen: true },
          ]),
        };
        return qb;
      }),
    };
    const barRepo = {
      upsert: vi.fn(async () => ({ identifiers: [{}] })),
      count: vi.fn(async () => 1),
    };

    const { svc } = makeService({ taskRepo, runRepo, coverageRepo, calendarRepo });
    const query = vi.fn(async () => [
      new Map([
        ['code', 'sh.600000'],
        ['date', '2026-01-05'],
        ['open', '10'],
        ['high', '11'],
        ['low', '9'],
        ['close', '10.5'],
        ['preclose', '10.2'],
        ['volume', '100'],
        ['amount', '1000'],
        ['adjustflag', '3'],
        ['turn', '0.5'],
        ['tradestatus', '1'],
        ['pctChg', '0.3'],
        ['peTTM', ''],
        ['pbMRQ', '1.2'],
        ['psTTM', '2'],
        ['pcfNcfTTM', ''],
        ['isST', '0'],
      ]),
    ]);
    (svc as unknown as { client: unknown }).client = { query, logout: vi.fn(async () => undefined) };
    (svc as unknown as { barRepo: unknown }).barRepo = barRepo;

    const run = {
      id: '12',
      taskId: '1',
      target: SYNC_TARGET.BAR_BY_DATE,
      code: 'bar',
      fromDate: '2026-01-05',
      toDate: '2026-01-06',
      state: SYNC_STATE.RUNNING,
    };

    await (svc as unknown as { executeRun: (r: unknown) => Promise<void> }).executeRun(run);

    // 两天都该被拉到 → 实际只拉了一天就停
    expect(query).toHaveBeenCalledTimes(1);
    expect(runRepo.update).toHaveBeenCalledWith(
      { id: '12', state: SYNC_STATE.RUNNING },
      expect.objectContaining({ stage: expect.stringContaining('已暂停') }),
    );
  });

  it('claimNext 按 RETURNING 的 id 回查完整实体（避免蛇形列名丢失 taskId）', async () => {
    const qb = {
      update: vi.fn(() => qb),
      set: vi.fn(() => qb),
      where: vi.fn(() => qb),
      returning: vi.fn(() => qb),
      execute: vi.fn(async () => ({ raw: [{ id: '42' }] })),
    };
    const runRepo = {
      createQueryBuilder: vi.fn(() => qb),
      findOneBy: vi.fn(async () => ({
        id: '42',
        taskId: '7',
        target: SYNC_TARGET.BAR_BY_DATE,
        code: 'sh.600000',
        fromDate: '2026-01-05',
        toDate: '2026-01-06',
        state: SYNC_STATE.RUNNING,
      })),
    };
    const { svc } = makeService({ runRepo });

    const run = await (svc as unknown as { claimNext: () => Promise<unknown> }).claimNext();

    expect(runRepo.findOneBy).toHaveBeenCalledWith({ id: '42' });
    expect(run).toMatchObject({ id: '42', taskId: '7', fromDate: '2026-01-05' });
  });

  it('claimNext 无排队执行时返回 null', async () => {
    const qb = {
      update: vi.fn(() => qb),
      set: vi.fn(() => qb),
      where: vi.fn(() => qb),
      returning: vi.fn(() => qb),
      execute: vi.fn(async () => ({ raw: [] })),
    };
    const runRepo = { createQueryBuilder: vi.fn(() => qb) };
    const { svc } = makeService({ runRepo });

    const run = await (svc as unknown as { claimNext: () => Promise<unknown> }).claimNext();

    expect(run).toBeNull();
  });

  it('upsertBars 按参数预算分批（单条语句不能超过 PostgreSQL 的 65535 参数上限）', async () => {
    const chunkSizes: number[] = [];
    const barRepo = {
      upsert: vi.fn(async (rows: unknown[]) => {
        chunkSizes.push(rows.length);
        return { identifiers: rows.map(() => ({})) };
      }),
    };
    const { svc } = makeService();
    (svc as unknown as { barRepo: unknown }).barRepo = barRepo;

    // 现场规模：一天全市场 5000 行 × 18 列 = 90000 个参数。
    // 旧实现拼成一条语句 ⇒ pg 的 addInt16 截断 ⇒ 「bind message has ... parameter formats」
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      code: `sh.${index}`,
      date: '2020-06-05',
    }));
    const written = await (
      svc as unknown as { upsertBars: (r: unknown[]) => Promise<number> }
    ).upsertBars(rows);

    // 行数与写入量都不能因为分批而少
    expect(written).toBe(5000);
    expect(chunkSizes.reduce((sum, n) => sum + n, 0)).toBe(5000);
    expect(chunkSizes.length).toBeGreaterThan(1);
    for (const size of chunkSizes) {
      expect(size * 18).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    }
  });

  it('upsertBars 行数在预算内时只发一条语句', async () => {
    const upsert = vi.fn(async (rows: unknown[]) => ({ identifiers: rows.map(() => ({})) }));
    const { svc } = makeService();
    (svc as unknown as { barRepo: unknown }).barRepo = { upsert };

    await (
      svc as unknown as { upsertBars: (r: unknown[]) => Promise<number> }
    ).upsertBars([{ code: 'sh.600000', date: '2020-06-04' }]);

    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
