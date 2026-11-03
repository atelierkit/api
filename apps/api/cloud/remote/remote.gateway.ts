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
import { TokenService, UserService } from '@shared';
import { RemoteSshService } from './remote.ssh.js';
import { RemoteService } from './remote.service.js';
import { RemoteSessionService } from './remote.session.js';
import { RemoteError, type RemoteErrorCode } from './remote.types.js';

/** 输出聚合窗口（毫秒），注：SSH 每次 read 可能只有几十字节，逐包发会把 socket 打满 */
export const FLUSH_INTERVAL = 16;

/** 单帧上限（字节），注：超出切成多帧，避免一个巨型 JSON/HTML 卡住浏览器 */
export const MAX_FRAME = 32 * 1024;

/** 背压水位（帧数），注：socket.io 内部写缓冲超过它就让 SSH 侧暂停读 */
export const HIGH_WATER = 64;

/** 恢复水位（帧数） */
export const LOW_WATER = 8;

/** 终端尺寸上下限，注：与 `RemoteTicketDto` 的白名单保持一致 */
export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 300;

/** 单连接的输出缓冲 */
interface StreamState {
  /** 待发送的分片 */
  chunks: Buffer[];
  /** 已缓冲字节数 */
  size: number;
  /** 聚合定时器 */
  timer: ReturnType<typeof setInterval> | null;
  /** SSH 侧是否已被暂停 */
  paused: boolean;
}

/**
 * 把缓冲切成不超过上限的帧
 *
 * 注：抽成纯函数是为了能单测「切帧边界」—— 直接对 socket 断言需要造一个假传输层
 *
 * @param buffer 待发送内容
 * @param max 单帧上限（字节）
 * @returns 帧列表
 */
export function framesOf(buffer: Buffer, max: number = MAX_FRAME): Buffer[] {
  if (buffer.length <= max) {
    return buffer.length === 0 ? [] : [buffer];
  }
  /** 帧列表 */
  const frames: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += max) {
    frames.push(buffer.subarray(offset, Math.min(offset + max, buffer.length)));
  }
  return frames;
}

/**
 * 收敛终端尺寸
 *
 * @param value 原始值
 * @param min 下限
 * @param max 上限
 * @param fallback 无法解析时的缺省值
 * @returns 收敛后的整数
 */
export function clampSize(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  /** 解析后的数值 */
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 远程终端网关（socket.io 命名空间 `/remote`）
 *
 * 注 1：**不能靠全局 `TokenGuard`** —— 它只处理 HTTP 上下文（`switchToHttp()`），对 WS 完全不生效。
 * 故这里自己校验三件事：握手令牌 → 用户存在且启用 → `admin` 角色；
 * 之后再用一次性票据换会话（票据由 `POST /cloud/remote/ticket` 签发）
 * 注 2：只做「换票建连 + 转发字节」，认证与凭据全在 `RemoteService` / `RemoteSshService` 里
 * 注 3：`cors.origin: true` 是必须的 —— web 与 api 不同源，socket.io 默认不发 CORS 头，
 * 浏览器会在握手阶段静默失败
 */
@WebSocketGateway({
  namespace: '/remote',
  path: '/socket.io',
  cors: { origin: true },
  // 注：粘贴大段文本时单帧可能较大，2 MB 足够；上限本身也是防线，别调太大
  maxHttpBufferSize: 2 * 1024 * 1024,
})
export class RemoteGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(RemoteGateway.name);

  /** 各连接的输出缓冲 */
  private readonly streams = new Map<string, StreamState>();

  /**
   * 构造函数
   *
   * @param sshSrv SSH 服务
   * @param sessionSrv 会话服务
   * @param remoteSrv 主机服务
   * @param tokenSrv 令牌服务，注：握手时用它把令牌换成用户
   * @param userSrv 用户服务，注：用它校验启用状态与 admin 角色
   */
  constructor(
    private readonly sshSrv: RemoteSshService,
    private readonly sessionSrv: RemoteSessionService,
    private readonly remoteSrv: RemoteService,
    private readonly tokenSrv: TokenService,
    private readonly userSrv: UserService,
  ) {}

  /**
   * 建立连接时的鉴权
   *
   * 注：鉴权失败立即断开 —— 不能让未鉴权的 socket 停留在命名空间里等 `open`
   *
   * @param socket 连接
   */
  async handleConnection(socket: Socket): Promise<void> {
    /** 握手载荷里的令牌，注：WS 不能自定义请求头，走 `auth` 载荷 */
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    /** 原始值，注：也可能有客户端把令牌塞在请求头里，一并兜住 */
    const raw = auth?.token ?? socket.handshake.headers.token;
    /** 令牌串 */
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (token === '') {
      this.reject(socket, 'TICKET_MISMATCH', '未携带登录令牌，请重新登录后再连接！');
      return;
    }
    /** 令牌内容 */
    const info = await this.tokenSrv.show(token);
    /** 用户ID */
    const userId = Number((info as { id?: unknown } | null)?.id) || 0;
    if (userId === 0) {
      this.reject(socket, 'TICKET_MISMATCH', '登录状态已失效，请重新登录！');
      return;
    }
    /** 用户 */
    const user = await this.userSrv.show(userId, 'status');
    if (user === null || user === undefined) {
      this.reject(socket, 'TICKET_MISMATCH', '用户不存在，请重新登录！');
      return;
    }
    if (!user.status) {
      this.reject(socket, 'TICKET_MISMATCH', '该用户已被禁用！');
      return;
    }
    if (!(user.roles ?? []).includes('admin')) {
      this.reject(socket, 'TICKET_MISMATCH', '没有被授权访问终端！');
      return;
    }
    // 注：`data` 挂在 socket 上，后续事件据此判断「这条连接属于谁」，
    // 票据消费时还会与票据里的 userId 再比一次
    socket.data['userId'] = userId;
    socket.data['username'] = user.username;
  }

  /**
   * 打开终端
   *
   * 注：返回值为 socket.io 的 ack 响应，客户端用回调接收
   *
   * @param socket 连接
   * @param body 票据
   * @returns 会话标识或错误
   */
  @SubscribeMessage('open')
  async open(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { ticket?: string } | undefined,
  ): Promise<{ sessionId: string } | { code: RemoteErrorCode; message: string }> {
    /** 用户ID */
    const userId = Number(socket.data['userId']) || 0;
    if (userId === 0) {
      return this.failure('TICKET_MISMATCH', '登录状态无效，请重新登录后再连接！');
    }
    if (this.sessionSrv.find(socket.id) !== undefined) {
      return this.failure('LIMIT_EXCEEDED', '当前连接已有一个终端会话，请勿重复打开！');
    }
    /** 已建立的连接，注：出错时要确保关掉，否则会在目标机上留下残留会话 */
    let client: Awaited<ReturnType<RemoteSshService['open']>> | null = null;
    try {
      /** 票据信息 */
      const pending = this.sessionSrv.consume(
        String(body?.ticket ?? ''),
        userId,
      );
      /** 连接信息 */
      const target = await this.remoteSrv.target(pending.remoteId);
      client = await this.sshSrv.open(target.config);
      // 注：首次连接（未记录指纹）在**握手成功之后**才回写 TOFU 记录 ——
      // 先记后连会留下「连都没连上却已信任」的假记录
      /** 本次握手观察到的主机指纹 */
      const observed = target.observed();
      if (target.fingerprint === '' && observed !== '') {
        await this.remoteSrv.rememberFingerprint(pending.remoteId, observed, userId);
      }
      /** 终端通道 */
      const channel = await this.sshSrv.shell(client, pending.cols, pending.rows);
      this.sessionSrv.register({
        socketId: socket.id,
        userId,
        remoteId: pending.remoteId,
        client,
        channel,
        openedAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      this.wire(socket, client, channel);
      return { sessionId: socket.id };
    } catch (err) {
      this.sshSrv.close(client, null);
      /** 会话错误 */
      const remoteErr =
        err instanceof RemoteError
          ? err
          : new RemoteError(
              'UNKNOWN',
              err instanceof Error ? err.message : String(err),
            );
      this.logger.warn(`打开终端失败：${remoteErr.code} ${remoteErr.message}`);
      return { code: remoteErr.code, message: remoteErr.message };
    }
  }

  /**
   * 接收键盘输入
   *
   * @param socket 连接
   * @param data 字节（socket.io 会把浏览器的 `ArrayBuffer` 转成 `Buffer`）
   */
  @SubscribeMessage('input')
  input(@ConnectedSocket() socket: Socket, @MessageBody() data: unknown): void {
    /** 会话 */
    const session = this.sessionSrv.find(socket.id);
    if (session === undefined) {
      return;
    }
    /** 待写入内容 */
    const payload = Buffer.isBuffer(data)
      ? data
      : Buffer.from(typeof data === 'string' ? data : '', 'utf8');
    if (payload.length === 0) {
      return;
    }
    session.channel.write(payload);
  }

  /**
   * 调整终端尺寸
   *
   * @param socket 连接
   * @param body 尺寸
   */
  @SubscribeMessage('resize')
  resize(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { cols?: unknown; rows?: unknown } | undefined,
  ): void {
    /** 会话 */
    const session = this.sessionSrv.find(socket.id);
    if (session === undefined) {
      return;
    }
    /** 列数 */
    const cols = clampSize(body?.cols, MIN_COLS, MAX_COLS, 80);
    /** 行数 */
    const rows = clampSize(body?.rows, MIN_ROWS, MAX_ROWS, 24);
    // 注：ssh2 的顺序是 (rows, cols, height, width)，与 xterm 的 (cols, rows) 相反
    session.channel.setWindow(rows, cols, 0, 0);
  }

  /**
   * 主动关闭终端
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
   * 注：必须在此处真正 `end()` SSH 连接 —— 只从 Map 里删掉引用不会断开 TCP，
   * 目标机的 `who` 里会一直挂着这个会话
   *
   * @param socket 连接
   */
  handleDisconnect(socket: Socket): void {
    this.cleanup(socket.id);
  }

  /**
   * 挂接通道事件
   *
   * @param socket 连接
   * @param client SSH 连接
   * @param channel 终端通道
   */
  private wire(
    socket: Socket,
    client: Awaited<ReturnType<RemoteSshService['open']>>,
    channel: Awaited<ReturnType<RemoteSshService['shell']>>,
  ): void {
    /** 输出缓冲 */
    const state: StreamState = {
      chunks: [],
      size: 0,
      timer: null,
      paused: false,
    };
    this.streams.set(socket.id, state);
    state.timer = setInterval(() => this.flush(socket, state), FLUSH_INTERVAL);
    state.timer.unref?.();

    channel.on('data', (chunk: Buffer) => {
      if (state.size >= 4 * 1024 * 1024) {
        // 注：超过 4 MB 还没发出去，说明对端已经不读了；继续缓冲只会把 api 内存吃光
        return;
      }
      state.chunks.push(Buffer.from(chunk));
      state.size += chunk.length;
    });
    channel.once('close', (code?: number, signal?: string) => {
      this.flush(socket, state);
      socket.emit('exit', {
        code: code ?? 0,
        signal: signal ?? '',
        reason: '通道已关闭',
      });
      this.cleanup(socket.id);
    });
    channel.on('error', (err: Error) => {
      socket.emit('error', { code: 'CHANNEL_CLOSED', message: err.message });
    });
    // 注：`ready` 之后仍可能收到 error（如链路被 RST），此时先告诉前端再回收
    client.on('error', (err: Error) => {
      socket.emit('error', { code: 'CHANNEL_CLOSED', message: err.message });
      this.cleanup(socket.id);
    });
  }

  /**
   * 冲刷输出缓冲
   *
   * @param socket 连接
   * @param state 缓冲状态
   */
  private flush(socket: Socket, state: StreamState): void {
    if (state.size === 0) {
      return;
    }
    /** 待发送内容 */
    const buffer = Buffer.concat(state.chunks, state.size);
    state.chunks = [];
    state.size = 0;
    for (const frame of framesOf(buffer)) {
      socket.emit('output', frame);
    }
    // 注：socket.io 的内部写队列无法从公开 API 读取，这里读 `writeBuffer`；
    // 升级 socket.io 大版本时要复查该字段（读不到就退化成「不背压」，不会报错）
    /** 写队列长度 */
    const queued = (socket.conn as unknown as { writeBuffer?: unknown[] })
      .writeBuffer;
    /** 队列中的帧数 */
    const depth = Array.isArray(queued) ? queued.length : 0;
    /** 会话 */
    const session = this.sessionSrv.find(socket.id);
    if (session === undefined) {
      return;
    }
    if (depth > HIGH_WATER && !state.paused) {
      state.paused = true;
      session.channel.pause();
    } else if (depth < LOW_WATER && state.paused) {
      state.paused = false;
      session.channel.resume();
    }
  }

  /**
   * 回收一个连接的全部资源
   *
   * @param socketId socket 标识
   */
  private cleanup(socketId: string): void {
    /** 输出缓冲 */
    const state = this.streams.get(socketId);
    if (state !== undefined) {
      if (state.timer !== null) {
        clearInterval(state.timer);
      }
      this.streams.delete(socketId);
    }
    this.sessionSrv.release(socketId);
  }

  /**
   * 拒绝一条连接
   *
   * @param socket 连接
   * @param code 错误码
   * @param message 可读文案
   */
  private reject(socket: Socket, code: RemoteErrorCode, message: string): void {
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
    code: RemoteErrorCode,
    message: string,
  ): { code: RemoteErrorCode; message: string } {
    return { code, message };
  }
}
