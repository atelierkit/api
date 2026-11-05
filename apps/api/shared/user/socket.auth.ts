// 外部依赖
import type { Socket } from 'socket.io';
// 内部依赖
import type { TokenService } from '../token/token.service.js';
import type { UserService } from './user.service.js';

/**
 * 握手鉴权失败的原因
 *
 * 注：用原因码而不是直接返回文案，是为了让调用方按场景替换 `not-admin` 的说法
 * （终端是「访问终端」、日志是「访问日志」），同时保持其余四条文案完全一致
 */
export type SocketAuthFailure =
  | 'no-token'
  | 'token-invalid'
  | 'user-missing'
  | 'user-disabled'
  | 'not-admin';

/** 失败原因的缺省文案 */
export const SOCKET_AUTH_MESSAGES: Record<SocketAuthFailure, string> = {
  'no-token': '未携带登录令牌，请重新登录后再连接！',
  'token-invalid': '登录状态已失效，请重新登录！',
  'user-missing': '用户不存在，请重新登录！',
  'user-disabled': '该用户已被禁用！',
  'not-admin': '没有被授权访问该功能！',
};

/** 鉴权结果 */
export type SocketAuthResult =
  | { ok: true; userId: number; username: string }
  | { ok: false; reason: SocketAuthFailure; message: string };

/**
 * 缓存在 `socket.data` 上的鉴权任务键
 *
 * 注：用字符串键而不是 Symbol —— `socket.data` 会跟着适配器走，字符串更便于调试时查看
 */
const AUTH_TASK_KEY = 'authTask';

/**
 * 校验 WebSocket 连接的登录状态与角色
 *
 * 注 1：**不能依赖全局 `TokenGuard`** —— 它按 HTTP 上下文写（`switchToHttp()` 在 WS 侧拿到的是
 * socket 与消息载荷），故对 `ws` 类型上下文一律直接放行，鉴权必须由网关自己做
 * 注 2：令牌从 `socket.handshake.auth.token` 取（WS 不能自定义请求头），
 * 同时兜住 `headers.token`（少数客户端会塞在这里）
 * 注 3：校验通过时**顺手把身份写到 `socket.data`** —— 业务事件都靠它判断「这条连接属于谁」，
 * 让每个调用方各写一遍容易漏
 * 注 4：**同一条连接只真正校验一次**，后续调用复用同一个 Promise —— 握手（`handleConnection`）
 * 与业务事件（如 `open`）是并发的：两次 await 令牌与用户（各一次 Redis / DB 查询）期间，
 * 业务事件读到的 `socket.data.userId` 还是空的 ⇒ 表现为「刚连上就提示登录状态无效」
 *
 * @param socket 连接
 * @param tokenSrv 令牌服务
 * @param userSrv 用户服务
 * @returns 校验结果，注：失败时调用方负责 emit 错误并断开
 */
export async function socketIdentityOf(
  socket: Socket,
  tokenSrv: TokenService,
  userSrv: UserService,
): Promise<SocketAuthResult> {
  /** 已在进行中的鉴权任务 */
  const running = socket.data[AUTH_TASK_KEY] as
    | Promise<SocketAuthResult>
    | undefined;
  if (running !== undefined) {
    return running;
  }
  // 注：**先写缓存再 await** —— 否则并发的第二路调用会看到空值，又发起一次校验
  /** 本次鉴权任务 */
  const task = verifySocketIdentity(socket, tokenSrv, userSrv);
  socket.data[AUTH_TASK_KEY] = task;
  return task;
}

/**
 * 真正执行校验（不做缓存）
 *
 * @param socket 连接
 * @param tokenSrv 令牌服务
 * @param userSrv 用户服务
 * @returns 校验结果
 */
async function verifySocketIdentity(
  socket: Socket,
  tokenSrv: TokenService,
  userSrv: UserService,
): Promise<SocketAuthResult> {
  /** 握手载荷里的令牌 */
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  /** 原始值，注：也可能有客户端把令牌塞在请求头里 */
  const raw = auth?.token ?? socket.handshake.headers.token;
  /** 令牌串 */
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (token === '') {
    return failure('no-token');
  }
  /** 令牌内容 */
  const info = await tokenSrv.show(token);
  /** 用户ID */
  const userId = Number((info as { id?: unknown } | null)?.id) || 0;
  if (userId === 0) {
    return failure('token-invalid');
  }
  /** 用户 */
  const user = await userSrv.show(userId, 'status');
  if (user === null || user === undefined) {
    return failure('user-missing');
  }
  if (!user.status) {
    return failure('user-disabled');
  }
  if (!(user.roles ?? []).includes('admin')) {
    return failure('not-admin');
  }
  // 注：`data` 挂在 socket 上，后续事件据此判断「这条连接属于谁」
  socket.data['userId'] = userId;
  socket.data['username'] = user.username;
  return { ok: true, userId, username: user.username };
}

/**
 * 构造失败结果
 *
 * @param reason 失败原因
 * @returns 失败结果
 */
function failure(reason: SocketAuthFailure): SocketAuthResult {
  return { ok: false, reason, message: SOCKET_AUTH_MESSAGES[reason] };
}
