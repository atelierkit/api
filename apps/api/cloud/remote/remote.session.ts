// 外部依赖
import {
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
// 内部依赖
import { RemoteSshService } from './remote.ssh.js';
import type { SshChannelLike, SshClientLike } from './remote.ssh.js';
import {
  RemoteError,
  type RemotePendingTicket,
  type RemoteSize,
  type RemoteTicket,
} from './remote.types.js';

/** 票据有效期（毫秒），注：够浏览器从 HTTP 拿到票据再握手即可，越短越安全 */
export const TICKET_TTL = 60 * 1000;

/** 单用户并发会话上限 */
export const MAX_SESSIONS_PER_USER = 5;

/** 全局并发会话上限，注：每个会话在 api 侧占一个 socket 与一个 ssh 进程 */
export const MAX_SESSIONS_TOTAL = 20;

/** 单主机并发会话上限，注：防止一口气开满把目标机的 sshd 顶住 */
export const MAX_SESSIONS_PER_HOST = 4;

/** 空闲超时（毫秒），注：无输入也无输出 */
export const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000;

/** 单会话最长存活时间（毫秒），注：防止开着终端过夜 */
export const SESSION_MAX_LIFETIME = 8 * 60 * 60 * 1000;

/** 巡检间隔（毫秒） */
export const SWEEP_INTERVAL = 60 * 1000;

/** 活跃会话 */
export interface RemoteLiveSession {
  /** 所属 socket */
  socketId: string;
  /** 操作用户ID */
  userId: number;
  /** 主机ID */
  remoteId: number;
  /** SSH 连接 */
  client: SshClientLike;
  /** 终端通道 */
  channel: SshChannelLike;
  /** 建立时刻 */
  openedAt: number;
  /** 最近活动时刻，注：输入与输出都算活动 */
  lastActiveAt: number;
}

/**
 * 终端会话服务
 *
 * 注 1：票据与会话都只存在**进程内存**里 —— api 重启即全部失效，这是可接受的
 * （重启后 ssh 连接本来就断了），也避免了把凭据落到任何持久层
 * 注 2：票据是「HTTP 已鉴权」到「WS 未鉴权」之间唯一的凭证，故一次性 + 60 秒 + 绑定用户
 */
@Injectable()
export class RemoteSessionService implements OnModuleInit, OnModuleDestroy {
  /** 待使用票据：票据串 → 票据信息 */
  private readonly tickets = new Map<string, RemotePendingTicket>();
  /** 活跃会话：socket标识 → 会话 */
  private readonly sessions = new Map<string, RemoteLiveSession>();
  /** 巡检定时器 */
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * 构造函数
   *
   * @param sshSrv SSH 服务，注：会话过期时要由这里负责真正断开连接
   */
  constructor(private readonly sshSrv: RemoteSshService) {}

  /** 模块初始化，注：巡检在这里起，避免构造函数里留定时器（测试会一直挂着手柄） */
  onModuleInit(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL);
    // 注：`unref()` 让定时器不阻止进程退出，否则容器优雅关闭会被它拖住
    this.timer.unref?.();
  }

  /** 模块销毁，注：清定时器并断开全部会话 */
  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const socketId of Array.from(this.sessions.keys())) {
      this.release(socketId);
    }
    this.tickets.clear();
  }

  /**
   * 签发终端票据
   *
   * @param userId 操作用户ID
   * @param remoteId 主机ID
   * @param size 终端尺寸
   * @returns 票据
   * @throws HttpException 超过并发上限时抛出 429
   */
  issue(userId: number, remoteId: number, size: RemoteSize): RemoteTicket {
    this.assertQuota(userId, remoteId);
    /** 票据串 */
    const ticket = randomUUID();
    /** 签发时刻 */
    const at = Date.now();
    this.tickets.set(ticket, { userId, remoteId, cols: size.cols, rows: size.rows, at });
    return { ticket, expiresAt: at + TICKET_TTL };
  }

  /**
   * 消费票据
   *
   * 注：无论成功失败，只要票据存在就会被删掉 —— 失败即作废，避免被反复试探
   *
   * @param ticket 票据串
   * @param userId 当前 socket 的用户ID
   * @returns 票据信息
   * @throws RemoteError 票据无效 / 过期 / 已用 / 不属于该用户时抛出
   */
  consume(ticket: string, userId: number): RemotePendingTicket {
    /** 票据信息 */
    const pending = this.tickets.get(ticket ?? '');
    if (pending === undefined) {
      throw new RemoteError('TICKET_INVALID', '会话票据无效，请重新发起连接。');
    }
    this.tickets.delete(ticket);
    if (Date.now() - pending.at > TICKET_TTL) {
      throw new RemoteError('TICKET_EXPIRED', '会话票据已过期（有效期 60 秒），请重新发起连接。');
    }
    if (pending.userId !== userId) {
      throw new RemoteError('TICKET_MISMATCH', '会话票据与当前登录用户不一致，请重新发起连接。');
    }
    return pending;
  }

  /**
   * 登记活跃会话
   *
   * @param session 会话
   */
  register(session: RemoteLiveSession): void {
    this.sessions.set(session.socketId, session);
  }

  /**
   * 取会话并刷新活动时间
   *
   * @param socketId socket 标识
   * @returns 会话，不存在时为 undefined
   */
  find(socketId: string): RemoteLiveSession | undefined {
    /** 会话 */
    const session = this.sessions.get(socketId);
    if (session !== undefined) {
      session.lastActiveAt = Date.now();
    }
    return session;
  }

  /**
   * 释放会话（断连时调用）
   *
   * @param socketId socket 标识
   * @returns 被释放的会话，不存在时为 undefined
   */
  release(socketId: string): RemoteLiveSession | undefined {
    /** 会话 */
    const session = this.sessions.get(socketId);
    if (session === undefined) {
      return undefined;
    }
    this.sessions.delete(socketId);
    this.sshSrv.close(session.client, session.channel);
    return session;
  }

  /**
   * 清理过期票据与会话
   *
   * @param now 当前时刻，注：测试注入固定时间
   * @returns 被清理的会话数
   */
  sweep(now: number = Date.now()): number {
    for (const [ticket, pending] of this.tickets) {
      if (now - pending.at > TICKET_TTL) {
        this.tickets.delete(ticket);
      }
    }
    /** 被清理的会话数 */
    let closed = 0;
    for (const [socketId, session] of this.sessions) {
      /** 是否空闲超时 */
      const idle = now - session.lastActiveAt > SESSION_IDLE_TIMEOUT;
      /** 是否超过最长存活 */
      const expired = now - session.openedAt > SESSION_MAX_LIFETIME;
      if (idle || expired) {
        this.expire(socketId, session, expired ? '已达到最长会话时长' : '空闲超时');
        closed += 1;
      }
    }
    return closed;
  }

  /**
   * 取当前活跃会话数
   *
   * @returns 会话数
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * 判断是否超过并发上限
   *
   * @param userId 操作用户ID
   * @param remoteId 主机ID
   * @throws HttpException 超限时抛出 429
   */
  private assertQuota(userId: number, remoteId: number): void {
    if (this.sessions.size >= MAX_SESSIONS_TOTAL) {
      throw new HttpException(
        `终端会话已达全局上限（${MAX_SESSIONS_TOTAL} 个），请先关闭其他会话！`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    /** 当前用户的会话数 */
    let mine = 0;
    /** 当前主机的会话数 */
    let host = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        mine += 1;
      }
      if (session.remoteId === remoteId) {
        host += 1;
      }
    }
    if (mine >= MAX_SESSIONS_PER_USER) {
      throw new HttpException(
        `你自己的终端会话已达上限（${MAX_SESSIONS_PER_USER} 个），请先关闭一些！`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (host >= MAX_SESSIONS_PER_HOST) {
      throw new HttpException(
        `该主机的终端会话已达上限（${MAX_SESSIONS_PER_HOST} 个），请先关闭一些！`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * 关闭一个超时会话并向对端发提示
   *
   * @param socketId socket 标识
   * @param session 会话
   * @param reason 关闭原因
   */
  private expire(
    socketId: string,
    session: RemoteLiveSession,
    reason: string,
  ): void {
    this.sessions.delete(socketId);
    // 注：先把提示写进终端再断开 —— 否则用户只看到画面卡住，不知道是被系统收掉了
    try {
      session.channel.write(`\r\n\x1b[33m[${reason}，会话已由服务端断开]\x1b[0m\r\n`);
    } catch {
      // 通道已失效时写入会抛错，忽略即可
    }
    this.sshSrv.close(session.client, session.channel);
  }
}
