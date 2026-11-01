// 外部依赖
import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'node:net';
// 内部依赖
import { BaostockProtocol } from './baostock.protocol.js';
import type { BaostockQuery } from './baostock.query.js';
import { BaostockQueries } from './baostock.query.js';
import { RecordParser, type BaostockRecord } from './baostock.record.js';
import {
  ERROR_CODE,
  MESSAGE_END_MARK,
  SERVER_HOST,
  SERVER_PORT,
} from './baostock.schema.js';

/** 建立连接的超时（裸 TCP 对端静默丢包时会一直挂着，必须自带超时） */
const CONNECT_TIMEOUT_MS = 10 * 1000;

/** 单次请求的超时（超时后废弃整条连接） */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** 登出请求的超时（登出失败无所谓，给短一点） */
const LOGOUT_TIMEOUT_MS = 5 * 1000;

/**
 * 客户端可调参数（生产用默认值）
 *
 * 抽成参数只为让「重试 / 空闲断连」这两条慢路径可测：默认值下跑一遍重试要等 1+2+3 秒、
 * 跑一遍空闲断连要等 10 分钟，单测里没法直接覆盖。
 */
export interface BaostockClientOptions {
  /** 单次请求的最大尝试次数（含首次）—— 建连与登录失败也计入 */
  attempts: number;
  /** 重试退避基数：第 n 次失败后等待 n × 本值 */
  backoffMs: number;
  /** 单次请求超时 */
  requestTimeoutMs: number;
  /** 空闲多久后主动登出 */
  idleTimeoutMs: number;
}

/** 默认参数 */
const DEFAULT_OPTIONS: BaostockClientOptions = {
  attempts: 4,
  backoffMs: 1000,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  idleTimeoutMs: 10 * 60 * 1000,
};

/** 响应结束标记的字节序列（长度用于维护尾部窗口） */
const END_MARK_BYTES = Buffer.from(MESSAGE_END_MARK, 'utf8');

/** baostock 异常码 */
export const BAOSTOCK_EXCEPTION = {
  TIMEOUT: 'timeout',
  DISCONNECTED: 'disconnected',
  CONNECT_FAILED: 'connect_failed',
  LOGIN_FAILED: 'login_failed',
  SERVER_ERROR: 'server_error',
  NOT_LOGGED_IN: 'not_logged_in',
  MALFORMED_RESPONSE: 'malformed_response',
} as const;

/** baostock 协议异常 */
export class BaostockException extends Error {
  constructor(
    public readonly code: string,
    message: string,
    cause?: Error,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'BaostockException';
  }
}

/**
 * baostock 协议客户端（裸 TCP，无 TLS，匿名登录）
 *
 * 本类的全部复杂度都来自一件事：协议层没有请求 ID。请求与响应只能靠「一问一答」配对，由此推出
 * 三条硬约束：必须串行；超时必须废弃整条连接；重试必须在「一次请求」的粒度。
 *
 * 重试覆盖「建连 / 登录 / 收发」三类失败（它们都是同一类可自愈故障）；服务端返回的业务错误码
 * 与「响应无法解析」不重试 —— 那属数据问题，重试只会白等。
 */
@Injectable()
export class BaostockClient {
  private readonly logger = new Logger(BaostockClient.name);

  /** 收发串行化 —— 协议无请求 ID，必须串行 */
  private readonly gate = new Gate();

  private socket: Socket | null = null;
  private userId = 'anonymous';

  /** 空闲断连计时器（触发时经 gate 排队，避免与进行中的请求抢 socket） */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** 生效参数（默认值 + 覆盖项） */
  private readonly options: BaostockClientOptions;

  /**
   * @param options 重试 / 超时 / 空闲断连参数，缺省用生产值
   */
  constructor(options: Partial<BaostockClientOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 是否已连接（有 socket 且未销毁） */
  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** 当前用户 ID（供查询构造器回显） */
  getUserId(): string {
    return this.userId;
  }

  /**
   * 执行一次查询（自动确保连接 + 串行 + 重试）
   *
   * @returns 记录列表
   */
  async query(query: BaostockQuery): Promise<BaostockRecord[]> {
    return this.gate.run(async () => {
      const records = await this.runWithRelogin(query);
      // 只有真正跑完一次请求才重置空闲计时；失败重试期间连接是热的，不该被计时器打断
      this.touchIdleTimer();
      return records;
    });
  }

  /**
   * 登出并断开连接（登出失败无所谓，不阻断停机）
   *
   * 走 gate 排队：停机时可能有请求正在收数据，抢同一个 socket 会串帧。
   */
  async logout(): Promise<void> {
    if (this.socket === null) {
      this.clearIdleTimer();
      return;
    }
    await this.gate.run(() => this.closeSession());
  }

  /**
   * 一次业务查询，会话过期（`10001001`）时重登后重试一次
   *
   * 该错误码出现时本次请求根本没被受理，没有「迟到响应」风险，重新登录即可。
   */
  private async runWithRelogin(query: BaostockQuery): Promise<BaostockRecord[]> {
    try {
      return this.readRecords(query, await this.sendWithRetry(query));
    } catch (err) {
      if (!isNotLoggedIn(err)) {
        throw err;
      }
      this.logger.warn('服务端报告未登录，将重新登录后重试本次请求。');
      this.dropConnection();
      return this.readRecords(query, await this.sendWithRetry(query));
    }
  }

  /** 确保连接可用：未连接时自动发起登录 */
  private async ensureLogin(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    await this.connect();

    const response = await this.sendOnce(
      BaostockQueries.login(),
      this.options.requestTimeoutMs,
    );
    if (response.length === 0 || response[0] !== ERROR_CODE.SUCCESS) {
      const code = response.length > 0 ? response[0] : '-';
      const message = response.length > 1 ? response[1] : '无响应体';
      this.dropConnection();
      // 登录失败也纳入重试：服务端繁忙 / 建连抖动都会让它偶发失败，一次就放弃太脆
      throw new BaostockException(
        BAOSTOCK_EXCEPTION.LOGIN_FAILED,
        `登录失败：${message}（错误码 ${code}）。`,
      );
    }
    this.logger.log(`已连接到 ${SERVER_HOST}:${SERVER_PORT} 并完成匿名登录。`);
  }

  /** 建立 TCP 连接（自带超时） */
  private async connect(): Promise<void> {
    this.dropConnection();

    const socket = new Socket();
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      /** 收尾：清掉连接超时与本次的 error 监听（常驻监听在连接成功后单独挂） */
      const cleanup = () => {
        socket.setTimeout(0);
        socket.removeListener('error', onError);
      };
      const onTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket.destroy();
        reject(
          new BaostockException(
            BAOSTOCK_EXCEPTION.CONNECT_FAILED,
            `连接 baostock 超时（${CONNECT_TIMEOUT_MS / 1000} 秒，目标 ${SERVER_HOST}:${SERVER_PORT}）—— 请检查该端口出网是否被拦截。`,
          ),
        );
      };
      const onError = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, onTimeout);
      socket.once('error', onError);
      socket.connect(SERVER_PORT, SERVER_HOST, () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
    });

    // ⚠ 常驻 error 监听：两次请求之间这条 socket 上没有别的监听者，对端 RST 会以
    // 「未捕获的 error 事件」直接终止进程（日志里没有任何业务线索）。只记录 + 丢弃连接，
    // 不在这里处理请求失败 —— 那是 sendOnce 自己那次 once('error') 的职责。
    socket.on('error', (err: Error) => this.handleIdleError(socket, err));

    this.socket = socket;
  }

  /** 空闲期（或请求期，与 sendOnce 的监听并存）的 socket 错误：只记录并丢弃连接 */
  private handleIdleError(socket: Socket, err: Error): void {
    this.logger.warn(`baostock 连接异常：${err.message}`);
    if (this.socket === socket) {
      this.dropConnection();
    }
  }

  /**
   * 带重试地完成一次请求（建连 + 登录 + 收发）
   *
   * 三类失败都计入尝试次数：建连超时 / 登录失败 / 收发超时与 socket 异常。
   */
  private async sendWithRetry(query: BaostockQuery): Promise<string[]> {
    let lastFailure: unknown = null;
    for (let attempt = 1; attempt <= this.options.attempts; attempt++) {
      try {
        // 建连与登录放在重试体内：冷启动的第一次失败不该让整段同步直接失败
        await this.ensureLogin();
        return await this.sendOnce(query, this.options.requestTimeoutMs);
      } catch (err) {
        if (!this.isRetryable(err)) {
          throw err;
        }
        lastFailure = err;
        this.dropConnection();
        if (attempt >= this.options.attempts) {
          break;
        }
        const wait = this.options.backoffMs * attempt;
        this.logger.warn(
          `baostock 请求失败（消息类型 ${query.messageType}，第 ${attempt} 次）：` +
            `${err instanceof Error ? err.message : String(err)}；${wait / 1000} 秒后重试。`,
        );
        await sleep(wait);
      }
    }
    throw new BaostockException(
      BAOSTOCK_EXCEPTION.DISCONNECTED,
      `baostock 请求最终失败（消息类型 ${query.messageType}，共尝试 ${this.options.attempts} 次）：` +
        `${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`,
    );
  }

  /**
   * 发送一次请求并读取完整响应
   *
   * ⚠ 超时与传输异常都会废弃连接后再抛 —— 迟到的响应无法与后续请求配对。
   */
  private async sendOnce(query: BaostockQuery, timeoutMs: number): Promise<string[]> {
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      throw new Error('尚未连接到 baostock 服务器。');
    }

    const payload = Buffer.from(
      BaostockProtocol.buildMessage(query.messageType, query.bodyFields),
      'utf8',
    );

    const chunks: Buffer[] = [];
    /** 尾部窗口：每来一块只比最后 13 字节，避免每块都全量 concat（O(n²)） */
    let tail = Buffer.alloc(0);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.setTimeout(0);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
      };
      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.dropConnection();
        reject(err);
      };
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > END_MARK_BYTES.length) {
          tail = tail.subarray(tail.length - END_MARK_BYTES.length);
        }
        if (tail.equals(END_MARK_BYTES)) {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error) => {
        fail(err);
      };

      socket.setTimeout(timeoutMs, () => {
        fail(
          new BaostockException(
            BAOSTOCK_EXCEPTION.TIMEOUT,
            `baostock 请求超时（${timeoutMs / 1000} 秒，消息类型 ${query.messageType}），已断开连接。`,
          ),
        );
      });
      socket.on('data', onData);
      socket.once('error', onError);
      socket.write(payload, (err) => {
        if (err !== undefined && err !== null) {
          fail(err);
        }
      });
    });

    return BaostockProtocol.splitResponse(Buffer.concat(chunks));
  }

  /** 把响应解析为记录列表，并在此处校验服务端错误码 */
  private readRecords(query: BaostockQuery, response: string[]): BaostockRecord[] {
    if (response.length === 0) {
      throw new BaostockException(
        BAOSTOCK_EXCEPTION.MALFORMED_RESPONSE,
        `响应体为空（消息类型 ${query.messageType}）。`,
      );
    }
    if (response[0] !== ERROR_CODE.SUCCESS) {
      const code = response[0];
      const message = response.length > 1 ? response[1] : '无错误信息';
      throw new BaostockException(
        code === ERROR_CODE.NO_LOGIN
          ? BAOSTOCK_EXCEPTION.NOT_LOGGED_IN
          : BAOSTOCK_EXCEPTION.SERVER_ERROR,
        `查询失败：${message}（错误码 ${code}，消息类型 ${query.messageType}）。`,
      );
    }

    const fieldNames = RecordParser.parseFieldNames(
      response.length > query.fieldIndex ? response[query.fieldIndex] : '',
    );
    const json =
      response.length > query.recordIndex ? response[query.recordIndex] : '';

    if (fieldNames.length === 0) {
      throw new BaostockException(
        BAOSTOCK_EXCEPTION.MALFORMED_RESPONSE,
        `响应中未取到列名列表（消息类型 ${query.messageType}，列名位置 ${query.fieldIndex}）。`,
      );
    }

    return RecordParser.zip(RecordParser.parseRows(json), fieldNames);
  }

  /**
   * 判断异常是否值得重试
   *
   * 只认「可自愈的连接/会话类」失败：超时、建连失败、登录失败、连接已废弃，以及传输层抛出的
   * 裸 `Error`（ECONNREFUSED / EPIPE / ECONNRESET）。业务错误码与解析失败一律不重试。
   */
  private isRetryable(err: unknown): boolean {
    if (err instanceof BaostockException) {
      return (
        err.code === BAOSTOCK_EXCEPTION.TIMEOUT ||
        err.code === BAOSTOCK_EXCEPTION.CONNECT_FAILED ||
        err.code === BAOSTOCK_EXCEPTION.LOGIN_FAILED ||
        err.code === BAOSTOCK_EXCEPTION.DISCONNECTED
      );
    }
    return err instanceof Error;
  }

  /** 重置空闲计时器：到点经 gate 排队登出（登出失败也不影响下次重连） */
  private touchIdleTimer(): void {
    this.clearIdleTimer();
    const timer = setTimeout(() => {
      this.idleTimer = null;
      this.logger.log(
        `连接空闲 ${this.options.idleTimeoutMs}ms，主动断开 baostock。`,
      );
      void this.gate.run(() => this.closeSession());
    }, this.options.idleTimeoutMs);
    // 不阻塞进程退出：常驻服务里这是一颗 10 分钟的定时炸弹，停机时不该等它
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.idleTimer = timer;
  }

  /** 清除空闲计时器 */
  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * 登出并断开当前会话（**不走 gate**，调用方负责排队）
   *
   * 供 `logout()` 与空闲计时器共用；两者都已在 gate 内，直接排队会自锁。
   */
  private async closeSession(): Promise<void> {
    this.clearIdleTimer();
    if (this.socket === null) {
      return;
    }
    try {
      await this.sendOnce(BaostockQueries.logout(), LOGOUT_TIMEOUT_MS);
    } catch {
      // 登出失败无关紧要
    } finally {
      this.dropConnection();
    }
  }

  /** 断开并释放当前连接 */
  private dropConnection(): void {
    this.clearIdleTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.destroy();
      } catch {
        // 释放连接失败无关紧要
      }
    }
  }
}

/** 简易互斥门（串行化收发） */
class Gate {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** 是否「服务端报告未登录」 */
function isNotLoggedIn(err: unknown): boolean {
  return (
    err instanceof BaostockException &&
    err.code === BAOSTOCK_EXCEPTION.NOT_LOGGED_IN
  );
}

/** 等待一段时间 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
