// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SyncController } from './sync.controller.js';
import { DataQueryController } from './query.controller.js';
import { DataModule } from './data.module.js';

describe('SyncController', () => {
  it('start 转发 syncSrv.start', async () => {
    const syncSrv = { start: vi.fn(async () => ({ enqueued: 1, blocked: 0, note: '' })) };
    const ctrl = new SyncController(syncSrv as never);
    await ctrl.start({ target: 'BarByDate' });
    expect(syncSrv.start).toHaveBeenCalledWith('BarByDate');
  });

  it('pause 转发 syncSrv.pause', async () => {
    const syncSrv = { pause: vi.fn(async () => ({ paused: 1 })) };
    const ctrl = new SyncController(syncSrv as never);
    await ctrl.pause({ target: 'AdjustFactor' });
    expect(syncSrv.pause).toHaveBeenCalledWith('AdjustFactor');
  });

  it('snapshot 转发 syncSrv.snapshot', async () => {
    const syncSrv = { snapshot: vi.fn(async () => ({ cards: [], queue: {}, recent: [] })) };
    const ctrl = new SyncController(syncSrv as never);
    await ctrl.snapshot();
    expect(syncSrv.snapshot).toHaveBeenCalled();
  });
});

describe('DataQueryController', () => {
  it('security 转发 querySrv.securities', () => {
    const querySrv = { securities: vi.fn(async () => ({ rows: [], total: 0, marketTotal: 0 })) };
    const ctrl = new DataQueryController(querySrv as never);
    const dto = { keyword: '平安', page: 1, size: 50 };
    void ctrl.security(dto as never);
    expect(querySrv.securities).toHaveBeenCalledWith(dto);
  });

  it('calendar 转发 querySrv.calendar', () => {
    const querySrv = { calendar: vi.fn(async () => []) };
    const ctrl = new DataQueryController(querySrv as never);
    void ctrl.calendar({ year: '2026' } as never);
    expect(querySrv.calendar).toHaveBeenCalledWith('2026');
  });

  it('bar 转发 querySrv.bars', () => {
    const querySrv = { bars: vi.fn(async () => ({ rows: [], total: 0, truncated: false })) };
    const ctrl = new DataQueryController(querySrv as never);
    const dto = { code: 'sh.600000', from: '2026-01-01', to: '2026-01-31' };
    void ctrl.bar(dto as never);
    expect(querySrv.bars).toHaveBeenCalledWith(dto);
  });
});

describe('DataModule', () => {
  it('同步与查询两套控制器、三个 provider 都在模块里注册', () => {
    expect(Reflect.getMetadata('controllers', DataModule)).toEqual([
      SyncController,
      DataQueryController,
    ]);
    expect(Reflect.getMetadata('providers', DataModule).length).toBe(3);
  });
});
