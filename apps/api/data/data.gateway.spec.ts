// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { DataGateway, type DataChangedSignal } from './data.gateway.js';

describe('DataGateway', () => {
  it('broadcast 通过 server.emit 发送 data:changed 信号', () => {
    const gateway = new DataGateway();
    const emit = vi.fn();
    // 用反射塞入替身 server
    (gateway as unknown as { server: { emit: typeof emit } }).server = { emit };

    gateway.broadcast('progress');

    expect(emit).toHaveBeenCalledTimes(1);
    const [event, signal] = emit.mock.calls[0] as [string, DataChangedSignal];
    expect(event).toBe('data:changed');
    expect(signal.reason).toBe('progress');
    expect(typeof signal.at).toBe('number');
  });

  it('载荷不含任何业务数值', () => {
    const gateway = new DataGateway();
    const emit = vi.fn();
    (gateway as unknown as { server: { emit: typeof emit } }).server = { emit };

    gateway.broadcast('finish');
    const signal = emit.mock.calls[0][1] as DataChangedSignal;
    // 只有 reason 与 at 两个键
    expect(Object.keys(signal).sort()).toEqual(['at', 'reason']);
  });
});
