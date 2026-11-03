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
import { CLIENT_CERT, OTHER_KEY } from '../docker/docker.cert.fixture.js';
import {
  KUBERNETES_MAX_BODY,
  KUBERNETES_TIMEOUT,
  authModeOf,
  isInsecure,
  kubernetesMessageOf,
  kubernetesRequest,
  kubernetesTargetOf,
  parseEndpoint,
  tlsOptionsOf,
} from './kubernetes.request.js';

/** 假 API Server 的响应行为 */
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

/** 假 API Server */
let server: Server;
/** 假 API Server 端口 */
let port = 0;
/** 当前测试的响应行为 */
let handler: Handler;

/**
 * 构造连接参数
 *
 * @param extra 覆盖项
 * @returns 指向假 API Server 的连接参数
 */
function targetOf(extra: Record<string, unknown> = {}) {
  return {
    ...kubernetesTargetOf(`http://127.0.0.1:${port}`, {}),
    ...extra,
  };
}

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  };
  server = createServer((req, res) => {
    /** 请求正文 */
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  // 注：默认 agent 会保留 keep-alive 连接，不主动断开的话 close 会一直等下去
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('parseEndpoint', () => {
  it('端口缺省按 6443 补齐，http / https 以前缀为准', () => {
    expect(parseEndpoint('https://192.168.1.3')).toEqual({
      scheme: 'https',
      host: '192.168.1.3',
      port: 6443,
    });
    expect(parseEndpoint('https://k8s.lan:16443')).toEqual({
      scheme: 'https',
      host: 'k8s.lan',
      port: 16443,
    });
    expect(parseEndpoint('http://127.0.0.1:8001').scheme).toBe('http');
  });

  it('缺协议、带路径、带查询串、tcp:// 都判非法', () => {
    for (const endpoint of [
      '192.168.1.3:6443',
      'https://host:6443/api',
      'https://host:6443?x=1',
      'tcp://host:2376',
      '',
    ]) {
      expect(() => parseEndpoint(endpoint)).toThrow(/地址格式不正确/);
    }
  });

  it('端口越界判非法', () => {
    expect(() => parseEndpoint('https://host:99999')).toThrow(/端口不正确/);
    expect(() => parseEndpoint('https://host:0')).toThrow(/端口不正确/);
  });
});

describe('kubernetesTargetOf', () => {
  it('凭据、校验开关与默认命名空间原样带上', () => {
    expect(
      kubernetesTargetOf(
        'https://h:6443',
        { ca: 'CA', cert: 'CERT', key: 'KEY', token: 'TOKEN', verify: false },
        'kube-system',
      ),
    ).toEqual({
      protocol: 'https',
      host: 'h',
      port: 6443,
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
      token: 'TOKEN',
      verify: false,
      namespace: 'kube-system',
    });
  });

  it('缺省的校验开关为 true（默认不放过自签证书）', () => {
    expect(kubernetesTargetOf('https://h:6443').verify).toBe(true);
    expect(kubernetesTargetOf('https://h:6443').namespace).toBe('');
  });
});

describe('authModeOf', () => {
  it('有 token 走 token，只有证书走 cert，都没有是 anonymous', () => {
    expect(authModeOf({ token: 'T', cert: 'C' })).toBe('token');
    expect(authModeOf({ token: 'T', cert: '' })).toBe('token');
    expect(authModeOf({ token: '', cert: 'C' })).toBe('cert');
    expect(authModeOf({ token: '', cert: '' })).toBe('anonymous');
  });
});

describe('isInsecure', () => {
  it('明文协议才算不安全', () => {
    expect(isInsecure({ protocol: 'http' })).toBe(true);
    expect(isInsecure({ protocol: 'https' })).toBe(false);
  });
});

describe('tlsOptionsOf', () => {
  it('空串不写进选项（Node 会把空串当成空证书）', () => {
    /** TLS 选项 */
    const options = tlsOptionsOf(kubernetesTargetOf('https://h:6443'));
    expect(options).not.toHaveProperty('ca');
    expect(options).not.toHaveProperty('cert');
    expect(options).not.toHaveProperty('key');
    expect(options.rejectUnauthorized).toBe(true);
  });

  it('有值时逐项写入，并按开关决定是否校验证书', () => {
    /** TLS 选项 */
    const options = tlsOptionsOf(
      kubernetesTargetOf('https://h:6443', {
        ca: 'CA',
        cert: 'CERT',
        key: 'KEY',
        verify: false,
      }),
    );
    expect(options.ca).toBe('CA');
    expect(options.cert).toBe('CERT');
    expect(options.key).toBe('KEY');
    expect(options.rejectUnauthorized).toBe(false);
  });
});

describe('kubernetesRequest', () => {
  it('有 token 时带 Bearer 头，没有时不带头', async () => {
    /** 收到的 Authorization */
    const seen: Array<string | undefined> = [];
    handler = (req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };
    await kubernetesRequest(targetOf({ token: 'TOKEN' }), '/version');
    await kubernetesRequest(targetOf(), '/version');
    expect(seen).toEqual(['Bearer TOKEN', undefined]);
  });

  it('PATCH 正文按传入的 Content-Type 发送（Kubernetes 只认 merge-patch）', async () => {
    /** 收到的请求头与正文 */
    const seen: Array<{ type?: string; body: string }> = [];
    handler = (req, res, body) => {
      seen.push({
        type: req.headers['content-type'] as string | undefined,
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    };
    await kubernetesRequest(targetOf(), '/api/v1/nodes/n1', {
      method: 'PATCH',
      body: { spec: { unschedulable: true } },
      contentType: 'application/merge-patch+json',
    });
    expect(seen[0].type).toBe('application/merge-patch+json');
    expect(seen[0].body).toBe('{"spec":{"unschedulable":true}}');
  });

  it('raw 模式返回裸文本（/healthz 回的就是 ok）', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    };
    expect(
      await kubernetesRequest(targetOf(), '/healthz', { raw: true }),
    ).toBe('ok');
  });

  it('204 空正文返回 undefined（删除成功就是这种）', async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    expect(
      await kubernetesRequest(targetOf(), '/api/v1/pods/web', {
        method: 'DELETE',
      }),
    ).toBeUndefined();
  });

  it('403 原状态码抛出，并带上 Status.message', async () => {
    handler = (_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        '{"kind":"Status","status":"Failure","message":"pods is forbidden","reason":"Forbidden","code":403}',
      );
    };
    /** 抛出的异常 */
    const err = await kubernetesRequest(targetOf(), '/api/v1/pods').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(403);
    expect((err as HttpException).message).toBe('pods is forbidden');
  });

  it('404 同样按原状态码透传（资源不存在不是 500）', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"reason":"NotFound","message":"pods \\"x\\" not found"}');
    };
    /** 抛出的异常 */
    const err = await kubernetesRequest(
      targetOf(),
      '/api/v1/namespaces/default/pods/x',
    ).catch((error: unknown) => error);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).message).toContain('not found');
  });

  it('超时转 504，不能让浏览器一直挂着', async () => {
    handler = () => {
      // 注：故意不响应，等客户端自己超时
    };
    /** 抛出的异常 */
    const err = await kubernetesRequest(targetOf(), '/api/v1/pods', {
      // 注：留 200ms 而不是贴着 50ms —— 并行跑多个测试套件时机器会被打满
      timeout: 200,
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect((err as HttpException).message).toContain('超时');
  });

  it('连不上转 502，并带上原因', async () => {
    /** 一个几乎肯定没人监听的端口 */
    const dead = targetOf({ port: 1 });
    /** 抛出的异常 */
    const err = await kubernetesRequest(dead, '/version').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('集群请求失败');
  });

  it('默认超时 15 秒，响应体上限 4MB', () => {
    expect(KUBERNETES_TIMEOUT).toBe(15000);
    expect(KUBERNETES_MAX_BODY).toBe(4 * 1024 * 1024);
  });

  it('证书与私钥不匹配时给 422 而不是裸 500（构造请求时就会同步抛）', async () => {
    /** TLS 连接参数，注：配了一对不匹配的证书与私钥，握手前就会被 OpenSSL 拒绝 */
    const target = kubernetesTargetOf(`https://127.0.0.1:${port}`, {
      cert: CLIENT_CERT,
      key: OTHER_KEY,
      verify: true,
    });
    /** 抛出的异常 */
    const err = await kubernetesRequest(target, '/version').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((err as HttpException).message).toContain('连接参数不正确');
  });
});

describe('kubernetesMessageOf', () => {
  it('优先取 message', () => {
    expect(
      kubernetesMessageOf(
        '{"message":"pods is forbidden","reason":"Forbidden"}',
        '',
      ),
    ).toBe('pods is forbidden');
  });

  it('没有 message 时退回 reason', () => {
    expect(kubernetesMessageOf('{"reason":"Forbidden"}', '')).toBe('Forbidden');
  });

  it('非 JSON 正文取原文', () => {
    expect(kubernetesMessageOf('  炸了 ', 'Unavailable')).toBe('  炸了 ');
  });

  it('空正文退回状态文案，全空时给默认文案', () => {
    expect(kubernetesMessageOf('', 'Unavailable')).toBe('Unavailable');
    expect(kubernetesMessageOf('   ', '')).toBe('集群请求失败！');
  });

  it('message 与 reason 都不是字符串时退回原文', () => {
    expect(kubernetesMessageOf('{"message":123}', '')).toBe('{"message":123}');
  });
});
