// 外部依赖
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
// 内部依赖
import { RemoteError } from './remote.types.js';

/** SSH 连接参数 */
export interface SshConfig {
  /** 主机名或 IP */
  host: string;
  /** 端口 */
  port: number;
  /** 登录用户 */
  username: string;
  /** 密码，注：与 `privateKey` 二选一 */
  password?: string;
  /** 私钥 PEM，注：调用方传入的是**解密后**的明文 */
  privateKey?: string;
  /** 私钥口令 */
  passphrase?: string;
  /** 是否启用 keyboard-interactive 认证，注：部分发行版与 Windows OpenSSH 只给这一种 */
  tryKeyboard?: boolean;
  /** 握手超时（毫秒） */
  readyTimeout?: number;
  /** 心跳间隔（毫秒） */
  keepaliveInterval?: number;
  /** 心跳丢包上限 */
  keepaliveCountMax?: number;
  /**
   * 主机公钥校验
   *
   * @param key 主机公钥原始字节
   * @returns 是否信任，返回 false 会以「握手被拒」结束
   */
  hostVerifier: (key: Buffer) => boolean;
}

/** SSH 通道的结构接口，注：只为让测试能用一个 EventEmitter 替身，见 `SshClientFactory` */
export interface SshChannelLike extends EventEmitter {
  /** 标准错误流，注：命令的报错信息在这里，诊断与概览都要收集 */
  stderr: EventEmitter;
  /**
   * 写入数据
   *
   * @param data 待写入内容
   * @returns 是否建议等待 drain
   */
  write(data: Buffer | string): boolean;
  /** 关闭通道 */
  end(): void;
  /**
   * 调整窗口尺寸
   *
   * @param rows 行数
   * @param cols 列数
   * @param height 像素高
   * @param width 像素宽
   */
  setWindow(rows: number, cols: number, height: number, width: number): void;
  /** 暂停读取，注：背压用 */
  pause(): void;
  /** 恢复读取 */
  resume(): void;
}

/** SSH 连接的结构接口 */
export interface SshClientLike extends EventEmitter {
  /**
   * 建立连接
   *
   * @param config 连接参数
   */
  connect(config: SshConfig): void;
  /** 关闭连接 */
  end(): void;
  /** 立即销毁连接 */
  destroy(): void;
  /**
   * 执行一条命令
   *
   * @param command 命令
   * @param callback 回调
   */
  exec(
    command: string,
    callback: (err: Error | undefined, channel: SshChannelLike) => void,
  ): void;
  /**
   * 申请交互式 shell
   *
   * @param options 终端参数
   * @param callback 回调
   */
  shell(
    options: { term: string; cols: number; rows: number },
    callback: (err: Error | undefined, channel: SshChannelLike) => void,
  ): void;
}

/** SSH 客户端工厂类型 */
export type SshClientFactory = () => SshClientLike;

/**
 * SSH 客户端工厂的注入令牌
 *
 * 注：把 `new Client()` 收在工厂里而不是直接 `new`，是为了让会话层与 gateway 的测试
 * 能注入一个 EventEmitter 替身 —— ssh2 的连接行为没法在 ESM 下打桩，
 * 而「会话生命周期」恰恰是最需要单测的部分
 */
export const SSH_CLIENT = Symbol('SSH_CLIENT');

/** 握手超时（毫秒），注：局域网内正常握手在 100 毫秒级，20 秒还没完成基本可以判死 */
export const SSH_READY_TIMEOUT = 20000;

/** 心跳间隔（毫秒） */
export const SSH_KEEPALIVE = 15000;

/** 心跳丢包上限，注：3 次未响应（约 45 秒）即判链路失效 */
export const SSH_KEEPALIVE_COUNT = 3;

/** 单次命令输出的累积上限（字节），注：概览与诊断只要几十行，超出即视为异常输出 */
export const SSH_MAX_OUTPUT = 1024 * 1024;

/** 命令执行超时（毫秒） */
export const SSH_EXEC_TIMEOUT = 30000;

/**
 * 把 ssh2 的错误转成带错误码的会话错误
 *
 * 注：ssh2 的错误只有一句英文，前端无法据此决定「重连 / 去信任 / 改密码」，
 * 故在这里归类；归类不出来的走 `UNKNOWN` 并保留原文
 *
 * @param err 原始异常
 * @returns 会话错误
 */
export function remoteErrorOf(err: Error): RemoteError {
  /** 原始信息 */
  const message = err.message ?? '';
  if (/verification failed|host denied|host key/i.test(message)) {
    return new RemoteError(
      'HOST_KEY_CHANGED',
      '主机公钥与记录不一致，连接已中止。若确认是目标机重装或更换过密钥，请重新信任该指纹。',
    );
  }
  if (/authentication methods failed|authentication failure|permission denied/i.test(message)) {
    return new RemoteError(
      'AUTH_FAILED',
      '认证失败：用户名、密码或私钥不正确（也可能是该用户不允许远程登录）。',
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|timed out|timeout/i.test(message)) {
    return new RemoteError(
      'HOST_UNREACHABLE',
      `无法连接目标主机：${message}（请检查地址、端口与防火墙）。`,
    );
  }
  if (/no such channel|channel closed|Channel open failure/i.test(message)) {
    return new RemoteError('CHANNEL_CLOSED', `目标主机拒绝了会话通道：${message}`);
  }
  return new RemoteError('UNKNOWN', `SSH 连接失败：${message}`);
}

/** SSH 连接服务，注：把 ssh2 的回调式 API 收成 Promise，并统一错误码 */
@Injectable()
export class RemoteSshService {
  /**
   * 构造函数
   *
   * @param clientFactory 客户端工厂
   */
  constructor(
    @Inject(SSH_CLIENT) private readonly clientFactory: SshClientFactory,
  ) {}

  /**
   * 建立 SSH 连接
   *
   * 注：`hostVerifier` 的返回值决定信任与否；校验失败时 ssh2 抛的是
   * `Host denied (verification failed)`，由 `remoteErrorOf` 归到 `HOST_KEY_CHANGED`
   *
   * @param config 连接参数
   * @returns 已就绪的连接
   * @throws RemoteError 握手或认证失败时抛出
   */
  open(config: SshConfig): Promise<SshClientLike> {
    /** 连接对象 */
    const client = this.clientFactory();
    /** 超时（毫秒） */
    const timeout = config.readyTimeout ?? SSH_READY_TIMEOUT;

    return new Promise<SshClientLike>((resolve, reject) => {
      /** 是否已结算，注：error 与 ready 可能先后到达 */
      let settled = false;
      /** 外部超时定时器，注：ssh2 自己的 `readyTimeout` 只管握手阶段，认证卡住时不触发 */
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        client.destroy();
        reject(
          new RemoteError(
            'HOST_UNREACHABLE',
            `连接超时（${timeout} 毫秒）：主机无响应或认证未完成。`,
          ),
        );
      }, timeout);

      /**
       * 失败收尾
       *
       * @param err 原始异常
       */
      const fail = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        client.destroy();
        reject(remoteErrorOf(err));
      };

      client.once('ready', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(client);
      });
      client.once('error', fail);
      // 注：服务端用 PAM 的键盘交互式认证时，必须应答 prompts 才能走完密码认证；
      // 只开了 `password` 的服务器不会触发该事件，无副作用
      client.on(
        'keyboard-interactive',
        (
          _name: string,
          _instructions: string,
          _lang: string,
          prompts: Array<{ prompt: string }>,
          finish: (answers: string[]) => void,
        ) => {
          finish(prompts.map(() => config.password ?? ''));
        },
      );
      client.connect({
        ...config,
        tryKeyboard: config.tryKeyboard ?? true,
        readyTimeout: timeout,
      } as SshConfig);
    });
  }

  /**
   * 执行一条命令并取回全部输出
   *
   * @param client 已就绪的连接
   * @param command 命令
   * @param timeout 超时（毫秒）
   * @returns 标准输出与标准错误的合并文本
   * @throws RemoteError 通道打开失败或超时时抛出
   */
  exec(
    client: SshClientLike,
    command: string,
    timeout: number = SSH_EXEC_TIMEOUT,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      /** 是否已结算 */
      let settled = false;
      /** 超时定时器 */
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new RemoteError('UNKNOWN', `命令执行超时（${timeout} 毫秒）：${command}`),
        );
      }, timeout);

      client.exec(command, (err, channel) => {
        if (err) {
          settled = true;
          clearTimeout(timer);
          reject(remoteErrorOf(err));
          return;
        }
        /** 输出分片 */
        const chunks: Buffer[] = [];
        /** 已累积字节数 */
        let size = 0;
        channel.on('data', (chunk: Buffer) => {
          if (size >= SSH_MAX_OUTPUT) {
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        // 注：命令的报错信息通常在 stderr 上，一并收集 —— 概览里某段失败时才能看出原因
        channel.stderr.on('data', (chunk: Buffer) => {
          if (size >= SSH_MAX_OUTPUT) {
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        channel.once('close', () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        channel.once('error', (channelErr: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(remoteErrorOf(channelErr));
        });
      });
    });
  }

  /**
   * 申请交互式 shell
   *
   * @param client 已就绪的连接
   * @param cols 列数
   * @param rows 行数
   * @returns 终端通道
   * @throws RemoteError 通道打开失败时抛出
   */
  shell(client: SshClientLike, cols: number, rows: number): Promise<SshChannelLike> {
    return new Promise<SshChannelLike>((resolve, reject) => {
      client.shell(
        { term: 'xterm-256color', cols, rows },
        (err, channel) => {
          if (err) {
            reject(remoteErrorOf(err));
            return;
          }
          resolve(channel);
        },
      );
    });
  }

  /**
   * 关闭连接
   *
   * 注：`destroy()` 在已断开时调用是安全的，故不必先判断状态；
   * 不关会留下一条 ssh 进程，目标机的 `who` 里能看到残留会话
   *
   * @param client 连接，可为空
   * @param channel 通道，可为空
   */
  close(client: SshClientLike | null, channel: SshChannelLike | null): void {
    try {
      channel?.end();
    } catch {
      // 注：通道已关闭时 end() 可能抛错，忽略即可 —— 收尾不应再把异常抛给调用方
    }
    try {
      client?.end();
    } catch {
      // 同上
    }
  }
}

/**
 * 把 SSH 错误转成 HTTP 异常
 *
 * 注：诊断接口是 HTTP 的，需要状态码；`AUTH_FAILED` / `HOST_KEY_CHANGED` 属于「用户配置不对」，
 * 用 422 比 502 更准确（502 会被前端当成「服务端挂了」）
 *
 * @param err 异常
 * @returns HTTP 异常
 */
export function httpErrorOf(err: unknown): HttpException {
  if (err instanceof HttpException) {
    return err;
  }
  if (err instanceof RemoteError) {
    return new HttpException(
      err.message,
      err.code === 'HOST_UNREACHABLE'
        ? HttpStatus.BAD_GATEWAY
        : HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  /** 原始信息 */
  const message = err instanceof Error ? err.message : String(err);
  return new HttpException(`SSH 请求失败：${message}`, HttpStatus.BAD_GATEWAY);
}
