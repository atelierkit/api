// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SyncService } from './sync.service.js';
import { DataGateway } from './data.gateway.js';
import { SYNC_STATE, SYNC_TARGET } from './sync/sync.types.js';
import type { QueueService } from '@shared';

/** 造一个 mock repository */
function mockRepo(overrides: Record<string, unknown> = {}) {
  return { ...overrides } as never;
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
    mockRepo(deps.calendarRepo),
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
      find: vi.fn(async () => []), // 无活跃执行
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

  it('snapshot 的队列计数区分排队与执行中', async () => {
    const coverageRepo = { findOneBy: vi.fn(async () => null) };
    const runRepo = {
      find: vi.fn(async () => [
        { id: '1', state: SYNC_STATE.QUEUED, target: 'BarByDate', stage: '', done: '0', total: '0' },
        { id: '2', state: SYNC_STATE.RUNNING, target: 'AdjustFactor', stage: '同步中', done: '3', total: '10' },
      ]),
      findOne: vi.fn(async () => null),
    };
    const { svc } = makeService({ coverageRepo, runRepo });

    const result = await svc.snapshot();
    expect(result.queue).toEqual({ queued: 1, running: 1 });
    expect(result.recent).toHaveLength(2);
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
    // 日历最早日期 + 全市场证券代码（BarByDate 不需要证券代码，但需要日历最早日）
    const calendarRepo = {
      createQueryBuilder: vi.fn(() => {
        const qb = {
          select: vi.fn(() => qb),
          getRawOne: vi.fn(async () => ({ min: '1990-12-19' })),
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

  it('executeRun 处理 Security 目标：调用证券同步器并写终态', async () => {
    const taskRepo = {
      findOneBy: vi.fn(async () => ({ id: '1' })),
    };
    const runRepo = {
      update: vi.fn(async () => ({ affected: 1 })),
    };
    const securityRepo = {
      upsert: vi.fn(async () => ({ identifiers: [{ code: 'sh.600000' }] })),
    };

    const { svc, gateway } = makeService({ taskRepo, runRepo, securityRepo });

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
      { id: '10' },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
    expect(gateway.broadcast).toHaveBeenCalledWith('finish');
  });

  it('executeRun 任务不存在时写跳过终态', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => null) };
    const runRepo = { update: vi.fn(async () => ({ affected: 1 })) };

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
      { id: '10' },
      expect.objectContaining({ state: SYNC_STATE.SKIPPED }),
    );
  });

  it('executeRun 处理 Calendar 目标：走日历同步器', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = { update: vi.fn(async () => ({ affected: 1 })) };
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
      { id: '11' },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
  });

  it('executeRun 处理 BarByDate 目标：走按交易日日 K 同步器', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = { update: vi.fn(async () => ({ affected: 1 })) };
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
      { id: '12' },
      expect.objectContaining({ state: SYNC_STATE.SUCCEEDED }),
    );
  });

  it('executeRun 处理 AdjustFactor 目标：走复权因子同步器', async () => {
    const taskRepo = { findOneBy: vi.fn(async () => ({ id: '1' })) };
    const runRepo = { update: vi.fn(async () => ({ affected: 1 })) };
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
      { id: '13' },
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

  it('onModuleDestroy 停止并登出', async () => {
    const { svc } = makeService();
    const client = { logout: vi.fn(async () => undefined) };
    (svc as unknown as { client: unknown }).client = client;
    svc.onModuleDestroy();
    expect(client.logout).toHaveBeenCalled();
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
});
