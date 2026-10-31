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
  SERVER_HOST,
  SERVER_PORT,
} from './baostock.schema.js';

/** 建立连接的超时（裸 TCP 对端静默丢包时会一直挂着，必须自带超时） */
const CONNECT_TIMEOUT_MS = 10 * 1000;

/** 单次请求的超时（超时后废弃整条连接） */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** 单次请求的最大尝试次数（含首次） */
const REQUEST_ATTEMPTS = 4;

/** 重试退避基数：第 n 次失败后等待 n × 本值 */
const RETRY_BACKOFF_MS = 1000;

/** 登出请求的超时（登出失败无所谓，给短一点） */
const LOGOUT_TIMEOUT_MS = 5 * 1000;

/** baostock 异常码 */
export const BAOSTOCK_EXCEPTION = {
  TIMEOUT: 'timeout',
  DISCONNECTED: 'disconnected',
  CONNECT_FAILED: 'connect_failed',
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
 * 只重试「连接 / 收发」阶段的失败。服务端返回的非 0 错误码与「响应无法解析」不重试。
 */
@Injectable()
export class BaostockClient {
  private readonly logger = new Logger(BaostockClient.name);

  /** 收发串行化 —— 协议无请求 ID，必须串行 */
  private readonly gate = new Gate();

  private socket: Socket | null = null;
  private userId = 'anonymous';

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
      await this.ensureLogin();
      try {
        return this.readRecords(query, await this.sendWithRetry(query));
      } catch (err) {
        if (
          err instanceof BaostockException &&
          err.code === BAOSTOCK_EXCEPTION.NOT_LOGGED_IN
        ) {
          // 连接空闲过久被服务端断开时的表现：本次请求根本没被受理，没有「迟到响应」风险，
          // 重新登录后重试一次即可。
          this.logger.warn('服务端报告未登录，将重新登录后重试本次请求。');
          this.dropConnection();
          await this.ensureLogin();
          return this.readRecords(query, await this.sendWithRetry(query));
        }
        throw err;
      }
    });
  }

  /** 登出并断开连接（登出失败无所谓，不阻断停机） */
  async logout(): Promise<void> {
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

  /** 确保连接可用：未连接时自动发起登录 */
  private async ensureLogin(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    await this.connect();

    const response = await this.sendOnce(
      BaostockQueries.login(),
      REQUEST_TIMEOUT_MS,
    );
    if (response.length === 0 || response[0] !== ERROR_CODE.SUCCESS) {
      const code = response.length > 0 ? response[0] : '-';
      const message = response.length > 1 ? response[1] : '无响应体';
      this.dropConnection();
      throw new BaostockException(
        BAOSTOCK_EXCEPTION.SERVER_ERROR,
        `登录失败：${message}（错误码 ${code}）。`,
      );
    }
    this.logger.log(
      `已连接到 ${SERVER_HOST}:${SERVER_PORT} 并完成匿名登录。`,
    );
  }

  /** 建立 TCP 连接（自带超时） */
  private async connect(): Promise<void> {
    this.dropConnection();

    const socket = new Socket();
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const onTimeout = () => {
        socket.destroy();
        reject(
          new BaostockException(
            BAOSTOCK_EXCEPTION.CONNECT_FAILED,
            `连接 baostock 超时（${CONNECT_TIMEOUT_MS / 1000} 秒，目标 ${SERVER_HOST}:${SERVER_PORT}）—— 请检查该端口出网是否被拦截。`,
          ),
        );
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, onTimeout);
      socket.once('error', reject);
      socket.connect(SERVER_PORT, SERVER_HOST, () => {
        socket.removeListener('error', reject);
        socket.setTimeout(0);
        resolve();
      });
    });

    this.socket = socket;
  }

  /** 带重试地发送一次查询 */
  private async sendWithRetry(query: BaostockQuery): Promise<string[]> {
    let lastFailure: unknown = null;
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
      try {
        return await this.sendOnce(query, REQUEST_TIMEOUT_MS);
      } catch (err) {
        if (!this.isRetryable(err)) {
          throw err;
        }
        lastFailure = err;
        this.dropConnection();
        if (attempt >= REQUEST_ATTEMPTS) {
          break;
        }
        const wait = RETRY_BACKOFF_MS * attempt;
        this.logger.warn(
          `baostock 请求失败（消息类型 ${query.messageType}，第 ${attempt} 次）：` +
            `${err instanceof Error ? err.message : String(err)}；${wait / 1000} 秒后重试。`,
        );
        await sleep(wait);
        // 重试前必须重新建连并登录（上一步已废弃连接）
        await this.ensureLogin();
      }
    }
    throw new BaostockException(
      BAOSTOCK_EXCEPTION.DISCONNECTED,
      `baostock 请求最终失败（消息类型 ${query.messageType}，共尝试 ${REQUEST_ATTEMPTS} 次）：` +
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
        if (BaostockProtocol.endsWithEndMark(Buffer.concat(chunks))) {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.dropConnection();
        reject(err);
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

  /** 判断异常是否值得重试（只针对连接与收发阶段的失败） */
  private isRetryable(err: unknown): boolean {
    if (err instanceof BaostockException) {
      return err.code === BAOSTOCK_EXCEPTION.TIMEOUT;
    }
    return err instanceof Error;
  }

  /** 断开并释放当前连接 */
  private dropConnection(): void {
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

/** 等待一段时间 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
