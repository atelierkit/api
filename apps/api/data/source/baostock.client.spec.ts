// 外部依赖
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** 待响应的帧队列（write 时逐个取出 emit） */
let responses: Buffer[] = [];

// 顶层 mock node:net
vi.mock('node:net', () => ({
  Socket: class {
    destroyed = false;
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    setNoDelay = vi.fn();
    setTimeout = vi.fn();
    connect = vi.fn((_port: number, _host: string, cb: () => void) => cb());
    on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      (this.handlers[event] ??= []).push(cb);
    });
    once = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      (this.handlers[event] ??= []).push(cb);
    });
    removeListener = vi.fn();
    write = vi.fn((_data: Buffer, cb?: (err?: Error | null) => void) => {
      cb?.(null);
      const payload = responses.shift();
      if (payload) {
        setTimeout(() => {
          for (const h of this.handlers['data'] ?? []) {
            h(payload);
          }
        }, 0);
      }
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
  },
}));

import { BaostockClient, BaostockException } from './baostock.client.js';

/** 组一条明文响应帧 */
function frame(messageType: string, body: string): Buffer {
  const header = `00.9.20\x01${messageType}\x01${String(body.length).padStart(10, '0')}`;
  return Buffer.from(`${header}${body}\x01${0}\n<![CDATA[]]>\n`, 'utf8');
}

const LOGIN_FRAME = frame('01', '0\x01success');

describe('BaostockClient', () => {
  beforeEach(() => {
    responses = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('query 自动登录后发请求并解析记录', async () => {
    const businessFrame = frame(
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
    responses = [LOGIN_FRAME, businessFrame];

    const client = new BaostockClient();
    const records = await client.query({
      messageType: '33',
      bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
      recordIndex: 6,
      fieldIndex: 9,
    });

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
    responses = [LOGIN_FRAME, frame('34', '10001002\x01some error')];
    const client = new BaostockClient();

    await expect(
      client.query({
        messageType: '33',
        bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
        recordIndex: 6,
        fieldIndex: 9,
      }),
    ).rejects.toThrow(BaostockException);
  });

  it('响应列名为空抛 MalformedResponse', async () => {
    const badFrame = frame(
      '34',
      ['0', 'success', 'a', 'b', '1', '500', '{"record":[]}', 'x', 'y', ''].join('\x01'),
    );
    responses = [LOGIN_FRAME, badFrame];
    const client = new BaostockClient();

    await expect(
      client.query({
        messageType: '33',
        bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
        recordIndex: 6,
        fieldIndex: 9,
      }),
    ).rejects.toThrow(BaostockException);
  });

  it('服务端报未登录（10001001）时重新登录并重试成功', async () => {
    const businessFrame = frame(
      '34',
      [
        '0', 'success', 'query_trade_dates', 'anonymous', '1', '500',
        '{"record":[["2026-01-05","1"]]}', '2026-01-05', '2026-12-31',
        'calendar_date,is_trading_day',
      ].join('\x01'),
    );
    const notLoggedIn = frame('34', '10001001\x01user not login');
    // 首次登录 → 业务请求报未登录 → 重登 → 重试成功
    responses = [LOGIN_FRAME, notLoggedIn, LOGIN_FRAME, businessFrame];
    const client = new BaostockClient();

    const records = await client.query({
      messageType: '33',
      bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
      recordIndex: 6,
      fieldIndex: 9,
    });

    expect(records).toHaveLength(1);
    expect(records[0].get('calendar_date')).toBe('2026-01-05');
  });

  it('登录响应错误码非 0 时抛 ServerError', async () => {
    responses = [frame('01', '10001002\x01login failed')];
    const client = new BaostockClient();

    await expect(
      client.query({
        messageType: '33',
        bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
        recordIndex: 6,
        fieldIndex: 9,
      }),
    ).rejects.toThrow(BaostockException);
  });

  it('logout 在已连接时发送登出请求', async () => {
    const businessFrame = frame(
      '34',
      [
        '0', 'success', 'query_trade_dates', 'anonymous', '1', '500',
        '{"record":[]}', '2026-01-05', '2026-12-31',
        'calendar_date,is_trading_day',
      ].join('\x01'),
    );
    // 登录 + 一次完整业务请求（建立连接）
    responses = [LOGIN_FRAME, businessFrame];
    const client = new BaostockClient();
    await client.query({
      messageType: '33',
      bodyFields: ['query_trade_dates', 'anonymous', '1', '500', '2026-01-05', '2026-12-31'],
      recordIndex: 6,
      fieldIndex: 9,
    });
    // 补一条登出响应
    responses = [frame('03', '0\x01success')];
    await expect(client.logout()).resolves.toBeUndefined();
  });
});
