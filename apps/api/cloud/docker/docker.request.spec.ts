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
  DOCKER_MAX_BODY,
  DOCKER_TIMEOUT,
  dockerMessageOf,
  dockerRequest,
  dockerTargetOf,
  isInsecure,
  parseEndpoint,
  tlsOptionsOf,
} from './docker.request.js';

/** 假 daemon 的响应行为 */
type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

/** 假 daemon */
let server: Server;
/** 假 daemon 端口 */
let port = 0;
/** 当前测试的响应行为 */
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
  it('tcp:// 的协议由 TLS 开关决定，端口按惯例补默认值', () => {
    expect(parseEndpoint('tcp://192.168.1.3:2376', true)).toEqual({
      scheme: 'tcp',
      host: '192.168.1.3',
      port: 2376,
    });
    expect(parseEndpoint('tcp://docker.lan', true).port).toBe(2376);
    expect(parseEndpoint('tcp://docker.lan', false).port).toBe(2375);
  });

  it('http:// 与 https:// 以前缀为准', () => {
    expect(parseEndpoint('https://docker.lan:2376', false)).toEqual({
      scheme: 'https',
      host: 'docker.lan',
      port: 2376,
    });
    expect(parseEndpoint('http://127.0.0.1:2375', true).port).toBe(2375);
  });

  it('unix:// 刻意不支持（宿主 socket 不交给服务进程）', () => {
    expect(() => parseEndpoint('unix:///var/run/docker.sock', true)).toThrow(
      /地址格式不正确/,
    );
  });

  it('缺协议、带路径、带查询串都判非法', () => {
    expect(() => parseEndpoint('192.168.1.3:2376', true)).toThrow();
    expect(() => parseEndpoint('tcp://host:2376/v1.47', true)).toThrow();
    expect(() => parseEndpoint('tcp://host:2376?x=1', true)).toThrow();
  });

  it('端口越界判非法', () => {
    expect(() => parseEndpoint('tcp://host:99999', true)).toThrow(/端口不正确/);
    expect(() => parseEndpoint('tcp://host:0', true)).toThrow(/端口不正确/);
  });
});

describe('dockerTargetOf', () => {
  it('tcp + TLS 走 https，tcp 无 TLS 走 http', () => {
    expect(dockerTargetOf('tcp://h:2376', true).protocol).toBe('https');
    expect(dockerTargetOf('tcp://h:2375', false).protocol).toBe('http');
  });

  it('https:// 前缀即使没开客户端证书也走 https（只用系统 CA）', () => {
    expect(dockerTargetOf('https://h:2376', false).protocol).toBe('https');
  });

  it('证书、校验开关与 API 版本原样带上', () => {
    /** 连接参数 */
    const target = dockerTargetOf(
      'tcp://h:2376',
      true,
      { ca: 'CA', cert: 'CERT', key: 'KEY', verify: false },
      '1.47',
    );
    expect(target).toEqual({
      protocol: 'https',
      host: 'h',
      port: 2376,
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
      verify: false,
      apiVersion: '1.47',
    });
  });

  it('缺省的校验开关为 true（默认不放过自签证书）', () => {
    expect(dockerTargetOf('tcp://h:2376', true).verify).toBe(true);
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
    const options = tlsOptionsOf({
      protocol: 'https',
      host: 'h',
      port: 2376,
      ca: '',
      cert: '',
      key: '',
      verify: true,
      apiVersion: '',
    });
    expect(options).not.toHaveProperty('ca');
    expect(options).not.toHaveProperty('cert');
    expect(options).not.toHaveProperty('key');
    expect(options.rejectUnauthorized).toBe(true);
  });

  it('有值时逐项写入，并按开关决定是否校验证书', () => {
    /** TLS 选项 */
    const options = tlsOptionsOf({
      protocol: 'https',
      host: 'h',
      port: 2376,
      ca: 'CA',
      cert: 'CERT',
      key: 'KEY',
      verify: false,
      apiVersion: '',
    });
    expect(options.ca).toBe('CA');
    expect(options.cert).toBe('CERT');
    expect(options.key).toBe('KEY');
    expect(options.rejectUnauthorized).toBe(false);
  });
});

describe('dockerRequest', () => {
  it('API 版本拼进路径前缀，未配置时不带前缀', async () => {
    /** 收到的路径 */
    const paths: string[] = [];
    handler = (req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    };
    await dockerRequest(targetOf({ apiVersion: '1.47' }), '/_ping');
    await dockerRequest(targetOf(), '/_ping');
    expect(paths).toEqual(['/v1.47/_ping', '/_ping']);
  });

  it('自动补前导斜杠，JSON 正文原样解析', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"Id":"abc"}');
    };
    expect(await dockerRequest(targetOf(), 'containers/json')).toEqual({
      Id: 'abc',
    });
  });

  it('raw 模式返回裸文本（/_ping 回的就是 OK）', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    };
    expect(await dockerRequest(targetOf(), '/_ping', { raw: true })).toBe('OK');
  });

  it('POST 带正文时按 JSON 发送并声明长度', async () => {
    /** 收到的请求头与正文 */
    const seen: Array<{ type?: string; length?: string; body: string }> = [];
    handler = (req, res, body) => {
      seen.push({
        type: req.headers['content-type'] as string | undefined,
        length: req.headers['content-length'] as string | undefined,
        body,
      });
      res.writeHead(204);
      res.end();
    };
    await dockerRequest(targetOf(), '/containers/x/start', {
      method: 'POST',
      body: { a: 1 },
    });
    expect(seen[0].type).toBe('application/json');
    expect(seen[0].length).toBe(String(Buffer.byteLength('{"a":1}')));
    expect(seen[0].body).toBe('{"a":1}');
  });

  it('204 空正文返回 undefined（删除成功就是这种）', async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    expect(
      await dockerRequest(targetOf(), '/images/x', { method: 'DELETE' }),
    ).toBeUndefined();
  });

  it('304 按成功处理（Docker 用它表示「已在目标状态」）', async () => {
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    expect(
      await dockerRequest(targetOf(), '/containers/x/start', { method: 'POST' }),
    ).toBeUndefined();
  });

  it('4xx 原状态码抛出，并带上 daemon 的 message', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"No such container: x"}');
    };
    /** 抛出的异常 */
    const err = await dockerRequest(targetOf(), '/containers/x/json').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).message).toBe('No such container: x');
  });

  it('409 冲突同样按原状态码透传（容器在运行、卷被占用）', async () => {
    handler = (_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end('{"message":"container is running"}');
    };
    /** 抛出的异常 */
    const err = await dockerRequest(targetOf(), '/containers/x', {
      method: 'DELETE',
    }).catch((error: unknown) => error);
    expect((err as HttpException).getStatus()).toBe(409);
  });

  it('非 JSON 正文原样带回（反向代理的 HTML 错误页）', async () => {
    handler = (_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>bad gateway</html>');
    };
    /** 抛出的异常 */
    const err = await dockerRequest(targetOf(), '/version').catch(
      (error: unknown) => error,
    );
    expect((err as HttpException).message).toBe('<html>bad gateway</html>');
  });

  it('超时转 504，不能让浏览器一直挂着', async () => {
    handler = () => {
      // 注：故意不响应，等客户端自己超时
    };
    /** 抛出的异常 */
    const err = await dockerRequest(targetOf(), '/info', {
      // 注：留 200ms 而不是贴着 50ms —— 并行跑多个测试套件时机器会被打满，
      // 过窄的超时会让这条用例变成偶发失败
      timeout: 200,
    }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    expect((err as HttpException).message).toContain('超时');
  });

  it('连不上转 502，并带上原因', async () => {
    /** 一个几乎肯定没人监听的端口，注：用假 daemon 的端口 +1 避免误伤 */
    const dead = targetOf({ port: 1 });
    /** 抛出的异常 */
    const err = await dockerRequest(dead, '/version').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('宿主机请求失败');
  });

  it('默认超时 15 秒，响应体上限 2MB', () => {
    expect(DOCKER_TIMEOUT).toBe(15000);
    expect(DOCKER_MAX_BODY).toBe(2 * 1024 * 1024);
  });

  it('证书与私钥不匹配时给 422 而不是裸 500（构造请求时就会同步抛）', async () => {
    /** TLS 连接参数，注：配了一对不匹配的证书与私钥，握手前就会被 OpenSSL 拒绝 */
    const target = dockerTargetOf(
      `tcp://127.0.0.1:${port}`,
      true,
      { cert: CLIENT_CERT, key: OTHER_KEY, verify: true },
    );
    /** 抛出的异常 */
    const err = await dockerRequest(target, '/version').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((err as HttpException).message).toContain('连接参数不正确');
  });
});

describe('dockerMessageOf', () => {
  it('对象取 message', () => {
    expect(dockerMessageOf('{"message":"唯一约束冲突"}', '')).toBe(
      '唯一约束冲突',
    );
  });

  it('非 JSON 正文取原文', () => {
    expect(dockerMessageOf('  炸了 ', 'Conflict')).toBe('  炸了 ');
  });

  it('空正文退回状态文案，全空时给默认文案', () => {
    expect(dockerMessageOf('', 'Conflict')).toBe('Conflict');
    expect(dockerMessageOf('', '')).toBe('宿主机请求失败！');
  });

  it('message 不是字符串时退回原文', () => {
    expect(dockerMessageOf('{"message":123}', '')).toBe('{"message":123}');
  });
});
