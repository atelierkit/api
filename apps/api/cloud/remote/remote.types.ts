/** 鉴权方式白名单 */
export const REMOTE_AUTH_TYPES = ['password', 'key'] as const;

/** 鉴权方式 */
export type RemoteAuthType = (typeof REMOTE_AUTH_TYPES)[number];

/**
 * 终端字符集白名单
 *
 * 注：只放两种 —— `utf-8` 覆盖绝大多数 Linux；`gb18030` 用于 locale 仍是 GBK 的老系统与容器
 * （它的超集能兼容 GBK 与 GB2312，比单列 `gbk` 稳）。白名单之外的值会让浏览器
 * `TextDecoder` 抛 `RangeError`，故 DTO 必须拦住
 */
export const REMOTE_CHARSETS = ['utf-8', 'gb18030'] as const;

/** 终端字符集 */
export type RemoteCharset = (typeof REMOTE_CHARSETS)[number];

/**
 * 会话错误码
 *
 * 注：WS 不能抛 HTTP 异常，故用这套码区分「该怎么补救」—— 前端按码给不同动作
 * （重连 / 去信任 / 联系管理员），不要只展示一句 message
 */
export const REMOTE_ERROR_CODES = [
  /** 票据不存在（伪造或已随服务重启失效） */
  'TICKET_INVALID',
  /** 票据超过 60 秒有效期 */
  'TICKET_EXPIRED',
  /** 票据已被使用（一次性） */
  'TICKET_USED',
  /** 票据与当前连接的用户不一致 */
  'TICKET_MISMATCH',
  /** TCP 层不可达 */
  'HOST_UNREACHABLE',
  /** 用户名 / 密码 / 私钥不正确 */
  'AUTH_FAILED',
  /** 主机指纹与记录不一致（可能被冒充，或目标机重装过） */
  'HOST_KEY_CHANGED',
  /** 超过并发上限（单用户 / 全局 / 单主机） */
  'LIMIT_EXCEEDED',
  /** 目标主机关闭了 shell（`ForceCommand` 等） */
  'CHANNEL_CLOSED',
  /** 其余未归类的失败 */
  'UNKNOWN',
] as const;

/** 会话错误码 */
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

/** 会话错误，注：gateway 捕获后转成 `error` 事件下发，HTTP 侧不抛它 */
export class RemoteError extends Error {
  /**
   * 构造函数
   *
   * @param code 错误码
   * @param message 可读文案
   */
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

/** 磁盘挂载点 */
export interface RemoteDiskMount {
  /** 设备名，如 `/dev/sda2` / `home-server:/data` */
  filesystem: string;
  /** 挂载点，如 `/` / `/data` */
  mountPoint: string;
  /** 文件系统类型，如 `ext4` / `xfs` / `nfs4`，取不到时为空串 */
  type: string;
  /** 总量（字节） */
  total: number;
  /** 已用（字节） */
  used: number;
  /** 剩余可用（字节） */
  available: number;
  /** 使用率（百分比整数） */
  percent: number;
}

/** 主机概览 */
export interface RemoteSummary {
  /** 发行版名称，如 `Ubuntu 22.04.4 LTS` */
  osName: string;
  /** 内核版本 */
  kernel: string;
  /** CPU 架构 */
  arch: string;
  /** 连续运行秒数 */
  uptime: number;
  /** CPU 核数 */
  cpus: number;
  /** 1 分钟平均负载 */
  load1: number;
  /** 5 分钟平均负载 */
  load5: number;
  /** 15 分钟平均负载 */
  load15: number;
  /** 内存总量（字节） */
  memoryTotal: number;
  /** 可用内存（字节） */
  memoryAvailable: number;
  /**
   * 全部挂载点，注：按「`/` 优先、其余按挂载点升序」排序；
   * 已剔除 tmpfs / squashfs / overlay 等伪文件系统的行（`/` 例外，总是保留）
   */
  disks: RemoteDiskMount[];
  /** 当前登录用户 */
  user: string;
}

/** 诊断单阶段结果 */
export interface RemoteDiagnoseStage {
  /** 阶段名 */
  name: string;
  /** 是否通过 */
  ok: boolean;
  /** 耗时（毫秒），注：不可用时为 0 */
  latencyMs: number;
  /** 附加信息（版本号 / 指纹 / 错误原因） */
  detail: string;
}

/** 主机诊断结果 */
export interface RemoteDiagnose {
  /** 是否全部通过 */
  ok: boolean;
  /** 各阶段结果，注：按 TCP → 握手 → 认证 → 环境 → 指纹 的顺序 */
  stages: RemoteDiagnoseStage[];
  /** 已记录的主机指纹 */
  fingerprint: string;
  /** 当前握手到的主机指纹 */
  currentFingerprint: string;
  /** 目标机 `uname -a` 输出（认证通过时才有） */
  uname: string;
  /** 风险提示，注：由后端判定，前端不重复判断 */
  warnings: string[];
}

/** 终端票据 */
export interface RemoteTicket {
  /** 票据串，注：一次性、60 秒有效 */
  ticket: string;
  /** 失效时刻（Unix 毫秒） */
  expiresAt: number;
}

/** 已签发待使用的票据 */
export interface RemotePendingTicket {
  /** 签发用户ID */
  userId: number;
  /** 主机ID */
  remoteId: number;
  /** 终端列数 */
  cols: number;
  /** 终端行数 */
  rows: number;
  /** 签发时刻 */
  at: number;
}

/** 终端尺寸 */
export interface RemoteSize {
  /** 列数 */
  cols: number;
  /** 行数 */
  rows: number;
}
