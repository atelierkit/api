// 外部依赖
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { RemoteSshService } from './remote.ssh.js';
import type { SshChannelLike, SshClientLike } from './remote.ssh.js';
import {
  MAX_SESSIONS_PER_HOST,
  MAX_SESSIONS_PER_USER,
  RemoteSessionService,
  SESSION_IDLE_TIMEOUT,
  SESSION_MAX_LIFETIME,
  TICKET_TTL,
} from './remote.session.js';
import { RemoteError } from './remote.types.js';

/** 固定的「当前时刻」，注：全部用例都基于它推算，避免读真实时钟 */
const NOW = 1_700_000_000_000;

/**
 * 组装被测服务
 *
 * @returns 被测服务与 SSH 服务替身
 */
function serviceOf() {
  /** SSH 服务替身，注：会话层只用到 `close` */
  const sshSrv = { close: vi.fn() };
  return {
    service: new RemoteSessionService(sshSrv as unknown as RemoteSshService),
    sshSrv,
  };
}

/**
 * 造一个会话
 *
 * @param socketId socket 标识
 * @param userId 用户ID
 * @param remoteId 主机ID
 * @param openedAt 建立时刻
 * @returns 会话
 */
function sessionOf(
  socketId: string,
  userId = 1,
  remoteId = 1,
  openedAt = NOW,
) {
  /** 终端通道替身 */
  const channel = { write: vi.fn(), end: vi.fn() } as unknown as SshChannelLike;
  return {
    socketId,
    userId,
    remoteId,
    client: {} as SshClientLike,
    channel,
    openedAt,
    lastActiveAt: openedAt,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('票据', () => {
  it('签发后可用一次，第二次即失效（一次性）', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 票据 */
    const { ticket, expiresAt } = service.issue(7, 3, { cols: 120, rows: 40 });
    expect(expiresAt).toBe(NOW + TICKET_TTL);
    expect(service.consume(ticket, 7)).toMatchObject({
      userId: 7,
      remoteId: 3,
      cols: 120,
      rows: 40,
    });
    expect(() => service.consume(ticket, 7)).toThrow(RemoteError);
    try {
      service.consume(ticket, 7);
    } catch (err) {
      expect((err as RemoteError).code).toBe('TICKET_INVALID');
    }
  });

  it('超过 60 秒即过期', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 票据 */
    const { ticket } = service.issue(7, 3, { cols: 80, rows: 24 });
    vi.setSystemTime(NOW + TICKET_TTL + 1);
    try {
      service.consume(ticket, 7);
      throw new Error('本应抛出过期错误');
    } catch (err) {
      expect((err as RemoteError).code).toBe('TICKET_EXPIRED');
    }
  });

  it('票据绑定用户：换个用户来用直接拒绝', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 票据 */
    const { ticket } = service.issue(7, 3, { cols: 80, rows: 24 });
    try {
      service.consume(ticket, 8);
      throw new Error('本应抛出用户不匹配');
    } catch (err) {
      expect((err as RemoteError).code).toBe('TICKET_MISMATCH');
    }
  });

  it('伪造的票据被拒', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    try {
      service.consume('not-a-ticket', 7);
      throw new Error('本应抛出票据无效');
    } catch (err) {
      expect((err as RemoteError).code).toBe('TICKET_INVALID');
    }
  });
});

describe('并发上限', () => {
  it('单用户超限返回 429', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    for (let index = 0; index < MAX_SESSIONS_PER_USER; index += 1) {
      service.register(sessionOf(`s${index}`, 7, index + 1));
    }
    expect(() => service.issue(7, 99, { cols: 80, rows: 24 })).toThrow(
      HttpException,
    );
  });

  it('单主机超限返回 429（防止把目标机 sshd 顶住）', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    for (let index = 0; index < MAX_SESSIONS_PER_HOST; index += 1) {
      service.register(sessionOf(`s${index}`, index + 1, 5));
    }
    expect(() => service.issue(99, 5, { cols: 80, rows: 24 })).toThrow(
      HttpException,
    );
  });

  it('未超限时正常签发', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    service.register(sessionOf('s0', 7, 1));
    expect(service.issue(7, 2, { cols: 80, rows: 24 }).ticket).not.toBe('');
  });
});

describe('会话回收', () => {
  it('release 会真正关闭 SSH 连接并移除会话', () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    /** 会话 */
    const session = sessionOf('s1');
    service.register(session);
    expect(service.release('s1')).toBe(session);
    expect(sshSrv.close).toHaveBeenCalledWith(session.client, session.channel);
    expect(service.size).toBe(0);
    expect(service.release('s1')).toBeUndefined();
  });

  it('find 会刷新活动时间（输出也算活动，否则看日志的会话会被判空闲）', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 会话 */
    const session = sessionOf('s1', 1, 1, NOW - 10_000);
    service.register(session);
    vi.setSystemTime(NOW);
    service.find('s1');
    expect(session.lastActiveAt).toBe(NOW);
  });

  it('空闲超时的会话被关闭并写入提示', () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    /** 会话 */
    const session = sessionOf('s1', 1, 1, NOW - SESSION_IDLE_TIMEOUT - 1);
    session.lastActiveAt = NOW - SESSION_IDLE_TIMEOUT - 1;
    /** 通道写入替身，注：单独持有引用，避免把 `channel.write` 当方法引用传出去 */
    const write = vi.fn();
    session.channel = { write } as unknown as SshChannelLike;
    service.register(session);
    expect(service.sweep(NOW)).toBe(1);
    expect(sshSrv.close).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('空闲超时'));
    expect(service.size).toBe(0);
  });

  it('超过最长存活时间的会话被关闭（防止开着终端过夜）', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 会话 */
    const session = sessionOf('s1', 1, 1, NOW - SESSION_MAX_LIFETIME - 1);
    session.lastActiveAt = NOW;
    /** 通道写入替身 */
    const write = vi.fn();
    session.channel = { write } as unknown as SshChannelLike;
    service.register(session);
    expect(service.sweep(NOW)).toBe(1);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('最长会话时长'));
  });

  it('正常会话不被清理，过期票据被清掉', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    service.register(sessionOf('s1'));
    /** 票据 */
    const { ticket } = service.issue(7, 2, { cols: 80, rows: 24 });
    expect(service.sweep(NOW)).toBe(0);
    vi.setSystemTime(NOW + TICKET_TTL + 1);
    service.sweep(NOW + TICKET_TTL + 1);
    // 注：票据被清掉后再消费得到「无效」而不是「过期」
    try {
      service.consume(ticket, 7);
      throw new Error('本应抛出票据无效');
    } catch (err) {
      expect((err as RemoteError).code).toBe('TICKET_INVALID');
    }
  });

  it('通道已失效时写入提示抛错不影响回收', () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    /** 会话 */
    const session = sessionOf('s1', 1, 1, NOW - SESSION_IDLE_TIMEOUT - 1);
    session.lastActiveAt = NOW - SESSION_IDLE_TIMEOUT - 1;
    session.channel = {
      write: () => {
        throw new Error('channel closed');
      },
    } as unknown as SshChannelLike;
    service.register(session);
    expect(() => service.sweep(NOW)).not.toThrow();
    expect(sshSrv.close).toHaveBeenCalled();
  });

  it('模块销毁时清空票据与全部会话', () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    service.register(sessionOf('s1'));
    service.register(sessionOf('s2'));
    service.onModuleInit();
    service.onModuleDestroy();
    expect(sshSrv.close).toHaveBeenCalledTimes(2);
    expect(service.size).toBe(0);
  });
});
