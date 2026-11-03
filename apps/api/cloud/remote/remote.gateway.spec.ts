// 外部依赖
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { TokenService, UserService } from '@shared';
import {
  FLUSH_INTERVAL,
  HIGH_WATER,
  MAX_FRAME,
  RemoteGateway,
  clampSize,
  framesOf,
} from './remote.gateway.js';
import type { RemoteSshService, SshChannelLike, SshClientLike } from './remote.ssh.js';
import type { RemoteService } from './remote.service.js';
import { RemoteSessionService } from './remote.session.js';
import { RemoteError } from './remote.types.js';

/** 终端通道替身 */
class FakeChannel extends EventEmitter {
  /** 写入记录 */
  readonly written: Buffer[] = [];
  /** 窗口尺寸记录 */
  readonly windows: number[][] = [];
  /** 是否被暂停 */
  paused = false;
  /** 写入 */
  write(data: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }
  /** 关闭 */
  end(): void {
    this.emit('close', 0, '');
  }
  /** 调整窗口 */
  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windows.push([rows, cols, height, width]);
  }
  /** 暂停 */
  pause(): void {
    this.paused = true;
  }
  /** 恢复 */
  resume(): void {
    this.paused = false;
  }
}

/**
 * 造一个 socket 替身
 *
 * @returns socket 替身
 */
function socketOf() {
  return {
    id: 'sock-1',
    handshake: { auth: { token: 'tk' } as Record<string, unknown>, headers: {} },
    data: {} as Record<string, unknown>,
    conn: { writeBuffer: [] as unknown[] },
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

/**
 * 组装被测网关
 *
 * @returns 被测网关与全部替身
 */
function gatewayOf() {
  /** 终端通道 */
  const channel = new FakeChannel();
  /** SSH 服务替身 */
  const sshSrv = {
    open: vi.fn(async () => ({ on: vi.fn() }) as unknown as SshClientLike),
    shell: vi.fn(async () => channel as unknown as SshChannelLike),
    exec: vi.fn(async () => ''),
    close: vi.fn(),
  };
  /** 会话服务，注：用真实实现（票据与上限逻辑本身也有单测，这里做集成） */
  const sessionSrv = new RemoteSessionService(sshSrv as unknown as RemoteSshService);
  /** 主机服务替身 */
  const remoteSrv = {
    target: vi.fn(async () => ({
      config: {} as never,
      charset: 'utf-8',
      fingerprint: '',
      observed: () => 'SHA256:host-key',
    })),
    rememberFingerprint: vi.fn(async () => 1),
  };
  /** 令牌服务替身 */
  const tokenSrv = { show: vi.fn(async () => ({ id: '7' }) as unknown) };
  /** 用户服务替身 */
  const userSrv = {
    show: vi.fn(async () => ({ id: 7, username: 'marbl', status: true, roles: ['admin'] }) as unknown),
  };
  return {
    gateway: new RemoteGateway(
      sshSrv as unknown as RemoteSshService,
      sessionSrv,
      remoteSrv as unknown as RemoteService,
      tokenSrv as unknown as TokenService,
      userSrv as unknown as UserService,
    ),
    sshSrv,
    sessionSrv,
    remoteSrv,
    tokenSrv,
    userSrv,
    channel,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('纯函数', () => {
  it('framesOf 按上限切帧', () => {
    expect(framesOf(Buffer.alloc(0))).toEqual([]);
    expect(framesOf(Buffer.alloc(10))).toHaveLength(1);
    /** 两帧半的内容 */
    const frames = framesOf(Buffer.alloc(MAX_FRAME * 2 + 100));
    expect(frames).toHaveLength(3);
    expect(frames[0]?.length).toBe(MAX_FRAME);
    expect(frames[2]?.length).toBe(100);
  });

  it('clampSize 收敛越界与脏值', () => {
    expect(clampSize(120, 20, 500, 80)).toBe(120);
    expect(clampSize(5, 20, 500, 80)).toBe(20);
    expect(clampSize(9999, 20, 500, 80)).toBe(500);
    expect(clampSize('abc', 20, 500, 80)).toBe(80);
    expect(clampSize(-1, 20, 500, 80)).toBe(80);
  });
});

describe('握手鉴权（不能依赖全局 TokenGuard）', () => {
  it('没有令牌直接拒绝并断开', async () => {
    /** 被测网关与替身 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    socket.handshake.auth = {};
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'TICKET_MISMATCH',
      message: expect.stringContaining('令牌'),
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('令牌无效时拒绝', async () => {
    /** 被测网关与替身 */
    const { gateway, tokenSrv } = gatewayOf();
    tokenSrv.show.mockResolvedValue({} as never);
    /** socket */
    const socket = socketOf();
    await gateway.handleConnection(socket as never);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('用户被禁用时拒绝', async () => {
    /** 被测网关与替身 */
    const { gateway, userSrv } = gatewayOf();
    userSrv.show.mockResolvedValue({ id: 7, status: false, roles: ['admin'] } as never);
    /** socket */
    const socket = socketOf();
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'TICKET_MISMATCH',
      message: expect.stringContaining('禁用'),
    });
  });

  it('非 admin 角色拒绝（终端等于目标机 shell）', async () => {
    /** 被测网关与替身 */
    const { gateway, userSrv } = gatewayOf();
    userSrv.show.mockResolvedValue({ id: 7, status: true, roles: ['user'] } as never);
    /** socket */
    const socket = socketOf();
    await gateway.handleConnection(socket as never);
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'TICKET_MISMATCH',
      message: expect.stringContaining('授权'),
    });
  });

  it('校验通过时把用户挂到 socket 上，不断开', async () => {
    /** 被测网关与替身 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    await gateway.handleConnection(socket as never);
    expect(socket.data['userId']).toBe(7);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

describe('打开终端', () => {
  /**
   * 取一张可用票据
   *
   * @param sessionSrv 会话服务
   * @returns 票据串
   */
  function ticketOf(sessionSrv: RemoteSessionService): string {
    return sessionSrv.issue(7, 3, { cols: 120, rows: 40 }).ticket;
  }

  it('未通过握手鉴权时拒绝', async () => {
    /** 被测网关 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    expect(await gateway.open(socket as never, { ticket: 'x' })).toMatchObject({
      code: 'TICKET_MISMATCH',
    });
  });

  it('票据有效时建连、登记会话，并回写首连指纹（TOFU）', async () => {
    /** 被测网关与替身 */
    const { gateway, sessionSrv, remoteSrv, sshSrv } = gatewayOf();
    /** socket */
    const socket = socketOf();
    socket.data['userId'] = 7;
    /** 结果 */
    const result = await gateway.open(socket as never, {
      ticket: ticketOf(sessionSrv),
    });
    expect(result).toEqual({ sessionId: 'sock-1' });
    expect(sshSrv.open).toHaveBeenCalledTimes(1);
    // 注：未记录指纹 ⇒ 握手成功后回写，这就是 TOFU 的第一次写（票据里的主机ID是 3）
    expect(remoteSrv.rememberFingerprint).toHaveBeenCalledWith(3, 'SHA256:host-key', 7);
    expect(sessionSrv.size).toBe(1);
  });

  it('已记录指纹时不再回写', async () => {
    /** 被测网关与替身 */
    const { gateway, sessionSrv, remoteSrv } = gatewayOf();
    remoteSrv.target.mockResolvedValue({
      config: {} as never,
      charset: 'utf-8',
      fingerprint: 'SHA256:host-key',
      observed: () => 'SHA256:host-key',
    });
    /** socket */
    const socket = socketOf();
    socket.data['userId'] = 7;
    await gateway.open(socket as never, { ticket: ticketOf(sessionSrv) });
    expect(remoteSrv.rememberFingerprint).not.toHaveBeenCalled();
  });

  it('票据无效时返回错误码，不建连', async () => {
    /** 被测网关与替身 */
    const { gateway, sshSrv } = gatewayOf();
    /** socket */
    const socket = socketOf();
    socket.data['userId'] = 7;
    expect(await gateway.open(socket as never, { ticket: 'bogus' })).toMatchObject({
      code: 'TICKET_INVALID',
    });
    expect(sshSrv.open).not.toHaveBeenCalled();
  });

  it('同一连接重复打开被拒，并关掉已建立的连接（不在目标机留残留会话）', async () => {
    /** 被测网关与替身 */
    const { gateway, sessionSrv, sshSrv } = gatewayOf();
    /** socket */
    const socket = socketOf();
    socket.data['userId'] = 7;
    await gateway.open(socket as never, { ticket: ticketOf(sessionSrv) });
    expect(await gateway.open(socket as never, { ticket: ticketOf(sessionSrv) })).toMatchObject(
      { code: 'LIMIT_EXCEEDED' },
    );
    // 注：第二次并未真的开连（early return），故 open 仍只被调用一次
    expect(sshSrv.open).toHaveBeenCalledTimes(1);
  });

  it('握手失败时返回对应错误码并关闭连接', async () => {
    /** 被测网关与替身 */
    const { gateway, sessionSrv, sshSrv } = gatewayOf();
    sshSrv.open.mockRejectedValue(new RemoteError('AUTH_FAILED', '认证失败'));
    /** socket */
    const socket = socketOf();
    socket.data['userId'] = 7;
    expect(await gateway.open(socket as never, { ticket: ticketOf(sessionSrv) })).toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(sessionSrv.size).toBe(0);
  });
});

describe('终端事件', () => {
  /**
   * 打开一个已就绪的会话
   *
   * @returns 上下文
   */
  async function opened() {
    /** 上下文 */
    const context = gatewayOf();
    /** socket */
    const socket = socketOf();
    socket.data['userId'] = 7;
    /** 票据 */
    const ticket = context.sessionSrv.issue(7, 3, { cols: 80, rows: 24 }).ticket;
    await context.gateway.open(socket as never, { ticket });
    return { ...context, socket };
  }

  it('输入写入 SSH 通道', async () => {
    /** 上下文 */
    const { gateway, socket, channel } = await opened();
    gateway.input(socket as never, Buffer.from('ls\n'));
    expect(channel.written[0]?.toString()).toBe('ls\n');
  });

  it('字符串输入按 UTF-8 编码', async () => {
    /** 上下文 */
    const { gateway, socket, channel } = await opened();
    gateway.input(socket as never, '中文');
    expect(channel.written[0]?.toString('utf8')).toBe('中文');
  });

  it('空输入不写入', async () => {
    /** 上下文 */
    const { gateway, socket, channel } = await opened();
    gateway.input(socket as never, Buffer.alloc(0));
    expect(channel.written).toHaveLength(0);
  });

  it('尺寸按 xterm 的 (cols, rows) 收，向 ssh2 的 (rows, cols) 传', async () => {
    /** 上下文 */
    const { gateway, socket, channel } = await opened();
    gateway.resize(socket as never, { cols: 9999, rows: 1 });
    expect(channel.windows[0]).toEqual([5, 500, 0, 0]);
  });

  it('输出先聚合再按帧下发', async () => {
    /** 上下文 */
    const { socket, channel } = await opened();
    channel.emit('data', Buffer.from('hel'));
    channel.emit('data', Buffer.from('lo'));
    // 注：16 毫秒聚合窗口内不发
    expect(socket.emit).not.toHaveBeenCalledWith('output', expect.anything());
    vi.advanceTimersByTime(FLUSH_INTERVAL);
    expect(socket.emit).toHaveBeenCalledWith('output', Buffer.from('hello'));
  });

  it('写队列过深时暂停 SSH 读取，回落后恢复', async () => {
    /** 上下文 */
    const { socket, channel } = await opened();
    socket.conn.writeBuffer = Array.from({ length: HIGH_WATER + 10 }).fill(0);
    channel.emit('data', Buffer.from('x'));
    vi.advanceTimersByTime(FLUSH_INTERVAL);
    expect(channel.paused).toBe(true);
    socket.conn.writeBuffer = [];
    channel.emit('data', Buffer.from('y'));
    vi.advanceTimersByTime(FLUSH_INTERVAL);
    expect(channel.paused).toBe(false);
  });

  it('通道关闭时先冲刷残留输出，再发 exit 并回收会话', async () => {
    /** 上下文 */
    const { gateway, socket, channel, sessionSrv, sshSrv } = await opened();
    channel.emit('data', Buffer.from('bye'));
    channel.emit('close', 0, '');
    expect(socket.emit).toHaveBeenCalledWith('output', Buffer.from('bye'));
    expect(socket.emit).toHaveBeenCalledWith('exit', {
      code: 0,
      signal: '',
      reason: '通道已关闭',
    });
    expect(sshSrv.close).toHaveBeenCalled();
    expect(sessionSrv.size).toBe(0);
    expect(gateway).toBeDefined();
  });

  it('断连时回收会话并真正关闭 SSH 连接', async () => {
    /** 上下文 */
    const { gateway, socket, sessionSrv, sshSrv } = await opened();
    gateway.handleDisconnect(socket as never);
    expect(sessionSrv.size).toBe(0);
    expect(sshSrv.close).toHaveBeenCalled();
  });

  it('客户端主动关闭走同一条回收路径', async () => {
    /** 上下文 */
    const { gateway, socket, sessionSrv } = await opened();
    gateway.close(socket as never);
    expect(sessionSrv.size).toBe(0);
  });
});
