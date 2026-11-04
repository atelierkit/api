// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// 内部依赖
import { CLIENT_CERT, OTHER_KEY } from './docker.cert.fixture.js';
import {
  DOCKER_STREAM_IDLE,
  dockerStream,
  dockerTargetOf,
  requestOptionsOf,
} from './docker.request.js';

/** 假 daemon 的行为 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** 假 daemon */
let server: Server;
/** 假 daemon 端口 */
let port = 0;
/** 当前测试的行为 */
let handler: Handler;

/**
 * 构造连接参数
 *
 * @param extra 覆盖项
 * @returns 指向假 daemon 的连接参数
 */
function targetOf(extra: Record<string, unknown> = {}) {
  return {
    ...dockerTargetOf(`tcp://127.0.0.1:${port}`, false, { verify: true }),
    ...extra,
  };
}

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200);
    res.end();
  };
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('requestOptionsOf', () => {
  it('版本前缀在路径侧拼，调用方不用自己带', () => {
    expect(
      requestOptionsOf(targetOf({ apiVersion: '1.47' }), '/containers/x/logs'),
    ).toMatchObject({ path: '/v1.47/containers/x/logs', method: 'GET' });
    expect(requestOptionsOf(targetOf(), 'containers/json').path).toBe(
      '/containers/json',
    );
  });

  it('只有带正文时才声明 Content-Type 与长度', () => {
    /** 无正文 */
    const plain = requestOptionsOf(targetOf(), '/x');
    expect(plain.headers).not.toHaveProperty('Content-Type');

    /** 有正文 */
    const withBody = requestOptionsOf(targetOf(), '/x', 'POST', '{"a":1}');
    expect(withBody.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Content-Length': '7',
    });
  });
});

describe('dockerStream', () => {
  it('按分片产出响应，流结束后迭代器正常结束', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write('first');
      res.write('second');
      res.end();
    };
    /** 句柄 */
    const handle = await dockerStream(targetOf(), '/containers/x/logs?follow=1');
    /** 收到的分片 */
    const chunks: string[] = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk.toString('utf8'));
    }
    expect(chunks.join('')).toBe('firstsecond');
  });

  it('4xx 时读完错误体再抛出，状态码原样透传', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"No such container: x"}');
    };
    /** 抛出的异常 */
    const err = await dockerStream(targetOf(), '/containers/x/logs').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).message).toBe('No such container: x');
  });

  it('403 等非 2xx 按原状态码透传（不是一律 502）', async () => {
    handler = (_req, res) => {
      res.writeHead(403);
      res.end('{"message":"forbidden"}');
    };
    /** 抛出的异常 */
    const err = await dockerStream(targetOf(), '/x').catch((error: unknown) => error);
    expect((err as HttpException).getStatus()).toBe(403);
  });

  it('abort() 后迭代器静默结束，不当成错误', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('one');
      // 注：故意不 end —— 模拟 follow 一直开着
    };
    /** 句柄 */
    const handle = await dockerStream(targetOf(), '/x');
    /** 收到的分片 */
    const chunks: string[] = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk.toString('utf8'));
      handle.abort();
    }
    expect(chunks).toEqual(['one']);
  });

  it('连接被拒绝时是 502 且文案不提「超时」', async () => {
    /** 一个几乎肯定没人监听的端口 */
    const dead = { ...targetOf(), port: 1 };
    /** 抛出的异常 */
    const err = await dockerStream(dead, '/x').catch((error: unknown) => error);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('宿主机请求失败');
    expect((err as HttpException).message).not.toContain('超时');
  });

  it('连接后迟迟没有响应 → 首字节超时转 504', async () => {
    handler = () => {
      // 注：故意不响应
    };
    /** 抛出的异常 */
    const err = await dockerStream(targetOf(), '/x', { timeout: 200 }).catch(
      (error: unknown) => error,
    );
    expect((err as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect((err as HttpException).message).toContain('超时');
  });

  it('建立后长时间无数据 → 静默超时，迭代器给出可读原因', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      // 注：只给响应头，之后一直没有数据
      res.flushHeaders();
    };
    /** 句柄 */
    const handle = await dockerStream(targetOf(), '/x', {
      timeout: 1000,
      idleTimeout: 200,
    });
    /** 抛出的异常 */
    const err = await (async () => {
      try {
        for await (const _chunk of handle.chunks) {
          // 不应有数据
        }
      } catch (error) {
        return error;
      }
    })();
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect((err as HttpException).message).toContain('静默');
  });

  it('证书与私钥不匹配时给 422（构造期同步抛，不进网络）', async () => {
    /** TLS 连接参数 */
    const target = dockerTargetOf(`tcp://127.0.0.1:${port}`, true, {
      cert: CLIENT_CERT,
      key: OTHER_KEY,
      verify: true,
    });
    /** 抛出的异常 */
    const err = await dockerStream(target, '/x').catch((error: unknown) => error);
    expect((err as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((err as HttpException).message).toContain('连接参数不正确');
  });

  it('静默超时的缺省值是 30 分钟（安静的服务不能被 15 秒掐断）', () => {
    expect(DOCKER_STREAM_IDLE).toBe(30 * 60 * 1000);
  });
});
