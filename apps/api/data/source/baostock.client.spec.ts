// 外部依赖
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * `node:net` 的 Socket 替身
 *
 * ⚠ 必须与真机同构：`on` / `once` / `removeListener` 都按 Node 的语义实现（`once` 触发后自动移除），
 * `emit('error')` 在没有监听者时**抛错**。替身若把 removeListener 写成空操作，就会掩盖
 * 「两次请求之间 socket 上没有 error 监听者、对端 RST 会打挂进程」这类缺陷 —— 测试越绿越没人查。
 *
 * 放在 `vi.hoisted` 里：`vi.mock` 的工厂会被提升到 import 之前执行，引用普通 top-level 类会撞 TDZ。
 */
const hoisted = vi.hoisted(() => {
  /** 待响应的帧队列（write 时逐个取出 emit） */
  const responses: Buffer[] = [];

  /** 建连阶段模拟「对端静默丢包」：connect 不回调，只能靠连接超时兜底 */
  const state = {
    connectHangs: false,
    instances: [] as MockSocket[],
  };

  class MockSocket {
    destroyed = false;
    /** 最近一次注册的超时回调（供 fireTimeout 触发） */
    timeoutCallback: (() => void) | undefined;

    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor() {
      state.instances.push(this);
    }

    setNoDelay = vi.fn();

    setTimeout = vi.fn((_ms: number, callback?: () => void) => {
      this.timeoutCallback = callback;
    });

    connect = vi.fn((_port: number, _host: string, callback: () => void) => {
      if (state.connectHangs) {
        // 连不上也不报错：只能靠连接超时定论
        return;
      }
      callback();
    });

    on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const list = this.handlers.get(event) ?? [];
      list.push(callback);
      this.handlers.set(event, list);
      return this;
    });

    once = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const wrapper = (...args: unknown[]) => {
        this.removeListener(event, wrapper);
        callback(...args);
      };
      return this.on(event, wrapper);
    });

    removeListener = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const list = this.handlers.get(event);
      if (list === undefined) {
        return this;
      }
      const index = list.indexOf(callback);
      if (index >= 0) {
        list.splice(index, 1);
      }
      return this;
    });

    off = this.removeListener;

    /** 与 Node 同语义：`error` 无监听者时抛错（真机上就是未捕获异常 → 进程终止） */
    emit(event: string, ...args: unknown[]): void {
      const list = this.handlers.get(event) ?? [];
      if (event === 'error' && list.length === 0) {
        throw args[0] instanceof Error ? args[0] : new Error('Unhandled error');
      }
      // 快照后再调用：Node 的 emit 也先拷贝监听者列表，避免回调内部增删导致跳过
      for (const callback of list.slice()) {
        callback(...args);
      }
    }

    /** 当前有几个该事件的监听者 */
    listenersOf(event: string): number {
      return (this.handlers.get(event) ?? []).length;
    }

    write = vi.fn((_data: Buffer, callback?: (err?: Error | null) => void) => {
      callback?.(null);
      const payload = responses.shift();
      if (payload !== undefined) {
        setTimeout(() => this.emit('data', payload), 0);
      }
    });

    destroy = vi.fn(() => {
      this.destroyed = true;
    });
  }

  return { MockSocket, responses, state };
});

vi.mock('node:net', () => ({ Socket: hoisted.MockSocket }));

import { BaostockClient, BaostockException } from './baostock.client.js';

/** 替换待响应的帧队列（保持同一个数组引用，替身拿得到） */
function setResponses(frames: Buffer[]): void {
  hoisted.responses.length = 0;
  hoisted.responses.push(...frames);
}

/** 触发某次注册的 socket 超时回调（模拟 socket.setTimeout 到点） */
function fireTimeout(socket: { timeoutCallback?: () => void }): void {
  socket.timeoutCallback?.();
}

/** 组一条明文响应帧 */
function frame(messageType: string, body: string): Buffer {
  const header = `00.9.20\x01${messageType}\x01${String(body.length).padStart(10, '0')}`;
  return Buffer.from(`${header}${body}\x01${0}\n<![CDATA[]]>\n`, 'utf8');
}

/** 一条成功的日历查询响应 */
const TRADE_DATES_FRAME = frame(
  '34',
  [
    '0',
    'success',
    'query_trade_dates',
    'anonymous',
    '1',
    '500',
    '{"record":[["2026-01-05","1"]]}',
    '2026-01-05',
    '2026-12-31',
    'calendar_date,is_trading_day',
  ].join('\x01'),
);

const LOGIN_FRAME = frame('01', '0\x01success');

const LOGOUT_FRAME = frame('03', '0\x01success');

/** 一个交易日历查询（「按证券」类，记录位 6 / 列名位 9） */
const TRADE_DATES_QUERY = {
  messageType: '33',
  bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
  recordIndex: 6,
  fieldIndex: 9,
};

describe('BaostockClient', () => {
  beforeEach(() => {
    setResponses([]);
    hoisted.state.connectHangs = false;
    hoisted.state.instances.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('query 自动登录后发请求并解析记录', async () => {
    setResponses([LOGIN_FRAME, TRADE_DATES_FRAME]);

    const client = new BaostockClient();
    const records = await client.query(TRADE_DATES_QUERY);

    expect(records).toHaveLength(1);
    expect(records[0].get('calendar_date')).toBe('2026-01-05');
  });

  it('getUserId 默认 anonymous', () => {
    const client = new BaostockClient();
    expect(client.getUserId()).toBe('anonymous');
  });

  it('logout 未连接时不报错', async () => {
    const client = new BaostockClient();
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it('服务端返回错误码抛 ServerError', async () => {
    setResponses([LOGIN_FRAME, frame('34', '10001002\x01some error')]);
    const client = new BaostockClient();

    await expect(client.query(TRADE_DATES_QUERY)).rejects.toThrow(BaostockException);
  });

  it('响应列名为空抛 MalformedResponse', async () => {
    const badFrame = frame(
      '34',
      ['0', 'success', 'a', 'b', '1', '500', '{"record":[]}', 'x', 'y', ''].join('\x01'),
    );
    setResponses([LOGIN_FRAME, badFrame]);
    const client = new BaostockClient();

    await expect(client.query(TRADE_DATES_QUERY)).rejects.toThrow(BaostockException);
  });

  it('服务端报未登录（10001001）时重新登录并重试成功', async () => {
    const notLoggedIn = frame('34', '10001001\x01user not login');
    // 首次登录 → 业务请求报未登录 → 重登 → 重试成功
    setResponses([LOGIN_FRAME, notLoggedIn, LOGIN_FRAME, TRADE_DATES_FRAME]);
    const client = new BaostockClient();

    const records = await client.query(TRADE_DATES_QUERY);

    expect(records).toHaveLength(1);
    expect(records[0].get('calendar_date')).toBe('2026-01-05');
  });

  it('登录响应错误码非 0 ⇒ 登录失败计入重试，用尽后抛 Disconnected', async () => {
    // 每次尝试都会重连 + 重新登录，故要给足 2 条登录失败响应
    setResponses([
      frame('01', '10001002\x01login failed'),
      frame('01', '10001002\x01login failed'),
    ]);
    const client = new BaostockClient({ attempts: 2, backoffMs: 0 });

    await expect(client.query(TRADE_DATES_QUERY)).rejects.toThrow(/最终失败/);
    // 登录失败 ⇒ 重新建连，所以确实尝试了 2 次
    expect(hoisted.state.instances).toHaveLength(2);
  });

  it('建连超时（CONNECT_FAILED）也重试，不再一次就放弃', async () => {
    hoisted.state.connectHangs = true;
    const client = new BaostockClient({ attempts: 3, backoffMs: 0 });

    // 先挂上拒绝处理器：否则重试期间 promise 先进入 rejected，vitest 会记成未处理拒绝
    const pending = client.query(TRADE_DATES_QUERY).catch((err: unknown) => err);
    // 建连不回调 ⇒ 逐个把等待中的「连接超时」打掉
    for (let index = 0; index < 3; index++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fireTimeout(hoisted.state.instances[index]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/最终失败/);
    expect(hoisted.state.instances.length).toBeGreaterThan(1);
  });

  it('两次请求之间 socket 上仍有 error 监听者（对端 RST 不会打挂进程）', async () => {
    setResponses([LOGIN_FRAME, TRADE_DATES_FRAME]);
    const client = new BaostockClient();
    await client.query(TRADE_DATES_QUERY);

    const socket = hoisted.state.instances[0];
    expect(socket.listenersOf('error')).toBeGreaterThan(0);
    // 真机上这里没有监听者会抛未捕获异常 —— 替身同样抛，故必须 not.toThrow
    expect(() => socket.emit('error', new Error('read ECONNRESET'))).not.toThrow();
    // 异常后连接被丢弃，下次请求自动重建
    expect(socket.destroyed).toBe(true);
    expect(client.isConnected).toBe(false);
  });

  it('空闲超过阈值后主动登出并断开连接', async () => {
    setResponses([LOGIN_FRAME, TRADE_DATES_FRAME]);
    const client = new BaostockClient({ idleTimeoutMs: 20 });
    await client.query(TRADE_DATES_QUERY);
    expect(client.isConnected).toBe(true);

    const socket = hoisted.state.instances[0];
    setResponses([LOGOUT_FRAME]);
    // 等空闲计时器到点 + 登出响应回来
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(socket.destroyed).toBe(true);
    expect(client.isConnected).toBe(false);
  });

  it('logout 在已连接时发送登出请求', async () => {
    setResponses([LOGIN_FRAME, TRADE_DATES_FRAME]);
    const client = new BaostockClient();
    await client.query(TRADE_DATES_QUERY);
    // 补一条登出响应
    setResponses([LOGOUT_FRAME]);
    await expect(client.logout()).resolves.toBeUndefined();
  });
});
