// 外部依赖
import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
// 内部依赖
import {
  SOCKET_GATEWAY_OPTION,
  TokenService,
  UserService,
  socketIdentityOf,
} from '@shared';
import { ID_PATTERN } from './object.dto.js';
import {
  DockerLogRing,
  tailOf,
  type DockerLogLine,
} from './object.logs.js';
import { DockerLogsService, type DockerLogStream } from './logs.service.js';

/** 输出聚合窗口（毫秒），注：与远程终端一致 —— 逐行 emit 会把 socket 打满 */
export const LOG_FLUSH_INTERVAL = 16;

/** 单帧上限（字节），注：超出切成多帧，避免一个巨型 JSON 卡住浏览器 */
export const LOG_MAX_FRAME = 64 * 1024;

/** 单用户并发日志流上限 */
export const LOG_MAX_SESSIONS_PER_USER = 2;

/** 全局并发日志流上限，注：每条流在 api 侧占一个到宿主机的长连接 */
export const LOG_MAX_SESSIONS_TOTAL = 10;

/**
 * 单条流的最长存活时间（毫秒）
 *
 * 注：日志跟随没有「空闲」概念（安静的服务十几分钟没输出是正常的），所以不能用空闲超时，
 * 改用总时长兜底 —— 否则「开着抽屉过夜」会留下一条永久连接
 */
export const LOG_SESSION_LIFETIME = 4 * 60 * 60 * 1000;

/** `since` 的最大长度，注：正常值不超过 35 个字符，超长的一律当脏数据 */
const SINCE_MAX_LENGTH = 64;

/** 网关错误码 */
export type DockerLogErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'LIMIT_EXCEEDED'
  | 'HOST_UNREACHABLE'
  | 'STREAM_FAILED';

/** open 的 ack 结果 */
export interface DockerLogOpenResult {
  /** 会话标识，成功时存在 */
  sessionId?: string;
  /** 错误码，失败时存在 */
  code?: DockerLogErrorCode;
  /** 可读文案，失败时存在 */
  message?: string;
}

/** 一条日志流的内存会话 */
interface LogSession {
  /** 所属连接 */
  socketId: string;
  /** 操作用户ID，注：限流按用户统计 */
  userId: number;
  /** 宿主机ID */
  dockerId: number;
  /** 容器ID */
  containerId: string;
  /** 日志流 */
  stream: DockerLogStream;
  /** 待推送的行，注：环形缓冲兜住「前端跟不上」的情况 */
  ring: DockerLogRing;
  /** 聚合定时器 */
  timer: ReturnType<typeof setInterval>;
  /** 最长存活定时器 */
  expireTimer: ReturnType<typeof setTimeout>;
  /** 是否已经提示过「丢弃了早期数据」 */
  notified: boolean;
  /** 是否已回收，注：回收后不再 emit */
  closed: boolean;
}

/**
 * 容器日志网关（socket.io 命名空间 `/docker-log`）
 *
 * 注 1：**不用一次性票据**（与 `/remote` 不同）—— 日志是只读操作，票据多一次往返却没有
 * 对应的安全收益；握手的令牌校验（`socketIdentityOf`）已经覆盖「登录 + admin 角色」
 * 注 2：背压策略与终端相反：终端是 `pause()` 上游（字节流不能丢），日志是**丢最旧的行**
 * 并告知前端（用户要看的是最新输出，暂停 TCP 只会让延迟越滚越大）
 * 注 3：`handleDisconnect` 必须 `abort()` 宿主机请求 —— 只从 Map 删引用不会断 TCP，
 * daemon 侧会一直挂着一个日志跟随者
 * 注 4：选项统一来自 `SOCKET_GATEWAY_OPTION`（`@shared`），**不要在这里另写一套** ——
 * 详见该常量的注释（`path` 分叉会让进程直接崩）
 */
@WebSocketGateway({ ...SOCKET_GATEWAY_OPTION, namespace: '/docker-log' })
export class DockerLogGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(DockerLogGateway.name);

  /** 各连接对应的会话 */
  private readonly sessions = new Map<string, LogSession>();

  /**
   * 构造函数
   *
   * @param logsSrv 日志服务
   * @param tokenSrv 令牌服务，注：握手时用它把令牌换成用户
   * @param userSrv 用户服务，注：用它校验启用状态与 admin 角色
   */
  constructor(
    private readonly logsSrv: DockerLogsService,
    private readonly tokenSrv: TokenService,
    private readonly userSrv: UserService,
  ) {}

  /**
   * 建立连接时的鉴权
   *
   * @param socket 连接
   */
  async handleConnection(socket: Socket): Promise<void> {
    /** 校验结果 */
    const result = await socketIdentityOf(socket, this.tokenSrv, this.userSrv);
    if (!result.ok) {
      this.reject(
        socket,
        'UNAUTHORIZED',
        result.reason === 'not-admin'
          ? '没有被授权查看容器日志！'
          : result.message,
      );
    }
  }

  /**
   * 开始跟随一个容器的日志
   *
   * 注：返回值为 socket.io 的 ack 响应，客户端用回调接收
   *
   * @param socket 连接
   * @param body 宿主机ID、容器ID与查询参数
   * @returns 会话标识或错误
   */
  @SubscribeMessage('open')
  async open(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: { dockerId?: unknown; containerId?: unknown; tail?: unknown; since?: unknown } | undefined,
  ): Promise<DockerLogOpenResult> {
    /** 用户ID */
    const userId = Number(socket.data['userId']) || 0;
    if (userId === 0) {
      return this.failure('UNAUTHORIZED', '登录状态无效，请重新登录后再连接！');
    }
    if (this.sessions.has(socket.id)) {
      return this.failure(
        'LIMIT_EXCEEDED',
        '当前连接已有一条日志流，请先关闭再打开！',
      );
    }
    /** 该用户已有的流数量 */
    const mine = [...this.sessions.values()].filter(
      (session) => session.userId === userId,
    ).length;
    if (mine >= LOG_MAX_SESSIONS_PER_USER) {
      return this.failure(
        'LIMIT_EXCEEDED',
        `同一用户最多同时查看 ${LOG_MAX_SESSIONS_PER_USER} 个容器的日志，请先关闭其它窗口！`,
      );
    }
    if (this.sessions.size >= LOG_MAX_SESSIONS_TOTAL) {
      return this.failure(
        'LIMIT_EXCEEDED',
        '服务器的日志流数量已达上限，请稍后重试！',
      );
    }
    /** 宿主机ID */
    const dockerId = Number(body?.dockerId);
    if (!Number.isInteger(dockerId) || dockerId < 1) {
      return this.failure('BAD_REQUEST', '宿主机ID不正确！');
    }
    /** 容器ID */
    const containerId =
      typeof body?.containerId === 'string' ? body.containerId.trim() : '';
    // 注：容器ID会拼进 daemon 的路径，规则与 HTTP 侧完全一致（首字符必须是字母数字）
    if (!ID_PATTERN.test(containerId)) {
      return this.failure('BAD_REQUEST', '容器ID格式不正确！');
    }
    /** 起始时刻，注：会被编码后拼进查询串，这里再限一次长度 */
    const since =
      typeof body?.since === 'string' && body.since.length <= SINCE_MAX_LENGTH
        ? body.since
        : '';
    /** 日志流 */
    let stream: DockerLogStream;
    try {
      stream = await this.logsSrv.open(dockerId, containerId, {
        // 注：跟随的缺省 tail 是 0 —— 历史由快照接口给，这里只要新行
        tail: tailOf(body?.tail, 0),
        since,
        // 注：必须带时间戳，前端要靠它做重连后的去重
        timestamps: true,
      });
    } catch (err) {
      /** 异常状态码 */
      const status = (err as { status?: number })?.status ?? 0;
      /** 可读文案 */
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`打开日志流失败：${status} ${message}`);
      return this.failure(
        status === 404 ? 'BAD_REQUEST' : 'HOST_UNREACHABLE',
        message,
      );
    }

    /** 会话，注：两个定时器的回调都晚于本次赋值执行，可以直接引用 `session` */
    const session: LogSession = {
      socketId: socket.id,
      userId,
      dockerId,
      containerId,
      stream,
      ring: new DockerLogRing(),
      timer: setInterval(() => this.flush(socket, session), LOG_FLUSH_INTERVAL),
      expireTimer: setTimeout(() => {
        socket.emit('ended', { reason: 'expired' });
        this.cleanup(socket.id);
      }, LOG_SESSION_LIFETIME),
      notified: false,
      closed: false,
    };
    session.timer.unref?.();
    session.expireTimer.unref?.();
    this.sessions.set(socket.id, session);
    this.consume(socket, session);
    return { sessionId: socket.id };
  }

  /**
   * 主动关闭日志流
   *
   * @param socket 连接
   */
  @SubscribeMessage('close')
  close(@ConnectedSocket() socket: Socket): void {
    this.cleanup(socket.id);
  }

  /**
   * 连接断开时回收会话
   *
   * @param socket 连接
   */
  handleDisconnect(socket: Socket): void {
    this.cleanup(socket.id);
  }

  /**
   * 后台消费日志流
   *
   * 注：不 `await` —— `open` 的 ack 要立刻返回，否则前端会等到第一条日志才拿到会话标识
   *
   * @param socket 连接
   * @param session 会话
   */
  private consume(socket: Socket, session: LogSession): void {
    void (async () => {
      try {
        for await (const batch of this.logsSrv.batches(session.stream)) {
          if (session.closed) {
            return;
          }
          session.ring.push(batch);
        }
      } catch (err) {
        if (session.closed) {
          return;
        }
        socket.emit('error', {
          code: 'STREAM_FAILED' satisfies DockerLogErrorCode,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (session.closed) {
        return;
      }
      // 注：流自然结束只有一种正常原因 —— 容器停了或被删了（重启也会结束当前实例）
      this.flush(socket, session);
      socket.emit('ended', { reason: 'container-stopped' });
      this.cleanup(socket.id);
    })();
  }

  /**
   * 把缓冲推给前端
   *
   * @param socket 连接
   * @param session 会话
   */
  private flush(socket: Socket, session: LogSession): void {
    if (session.closed) {
      return;
    }
    /** 待推送的行 */
    const lines = session.ring.drain();
    /** 是否首次提示「丢弃了早期数据」 */
    const dropped = session.ring.truncated && !session.notified;
    if (dropped) {
      session.notified = true;
    }
    if (lines.length === 0) {
      if (dropped) {
        socket.emit('output', { lines: [], truncated: true });
      }
      return;
    }
    /** 当前分组 */
    let group: DockerLogLine[] = [];
    /** 当前分组字节数 */
    let size = 0;
    for (const line of lines) {
      /** 本行字节数估算 */
      const bytes = Buffer.byteLength(line.text) + line.ts.length;
      if (group.length > 0 && size + bytes > LOG_MAX_FRAME) {
        socket.emit('output', { lines: group, truncated: false });
        group = [];
        size = 0;
      }
      group.push(line);
      size += bytes;
    }
    socket.emit('output', { lines: group, truncated: dropped });
  }

  /**
   * 回收一条连接的全部资源
   *
   * @param socketId socket 标识
   */
  private cleanup(socketId: string): void {
    /** 会话 */
    const session = this.sessions.get(socketId);
    if (session === undefined) {
      return;
    }
    session.closed = true;
    clearInterval(session.timer);
    clearTimeout(session.expireTimer);
    // 注：必须 abort —— 只删 Map 里的引用不会断开到 daemon 的长连接
    session.stream.handle.abort();
    this.sessions.delete(socketId);
  }

  /**
   * 拒绝一条连接
   *
   * @param socket 连接
   * @param code 错误码
   * @param message 可读文案
   */
  private reject(
    socket: Socket,
    code: DockerLogErrorCode,
    message: string,
  ): void {
    socket.emit('error', { code, message });
    socket.disconnect(true);
  }

  /**
   * 构造失败响应
   *
   * @param code 错误码
   * @param message 可读文案
   * @returns 失败响应
   */
  private failure(
    code: DockerLogErrorCode,
    message: string,
  ): DockerLogOpenResult {
    return { code, message };
  }
}
