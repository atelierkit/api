// 外部依赖
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { OperateService } from '../../shared/operate/operate.service.js';
import { QueueService } from '../../shared/queue/queue.service.js';
import { KongEntity, KongLogEntity } from './kong.entity.js';
import { KongService } from './kong.service.js';

/**
 * 组装被测服务
 *
 * @param kong 站点查询结果，null 表示站点不存在
 * @returns 被测服务与全部替身
 */
function serviceOf(kong: unknown = { id: 1, url: 'http://kong:8001' }) {
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async (..._args: unknown[]) => 7) };
  /** 队列服务替身 */
  const queueSrv = { addTask: vi.fn((_task: () => Promise<unknown>) => 0) };
  /** 站点存储器替身 */
  const repository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    findOneBy: vi.fn(async (_where: unknown) => kong as unknown),
    metadata: { tableName: 'kongs', columns: [] as unknown[] },
  };
  /** 站点日志存储器替身 */
  const logRepository = {
    findBy: vi.fn(async (_where: unknown) => [] as unknown[]),
    metadata: { tableName: 'kongs_logs', columns: [] as unknown[] },
  };
  /** 被测服务 */
  const service = new KongService(
    operateSrv as unknown as OperateService,
    queueSrv as unknown as QueueService,
    repository as unknown as Repository<KongEntity>,
    logRepository as unknown as Repository<KongLogEntity>,
  );
  return { service, repository };
}

/**
 * 替换全局 fetch
 *
 * @param answer 响应或需要抛出的异常
 * @returns fetch 替身
 */
function stubFetch(answer: Response | Error) {
  /** fetch 替身 */
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * 构造响应
 *
 * @param body 响应正文
 * @param status 状态码
 * @param statusText 状态文案
 * @returns 响应对象
 */
function responseOf(body: unknown, status = 200, statusText = ''): Response {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, statusText },
  );
}

/**
 * 取请求地址
 *
 * 注：`fetch` 的第一个参数可能是字符串、`URL` 或 `Request`，这里统一成字符串
 *
 * @param input 请求参数
 * @returns 请求地址
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * 替换全局 fetch（按路径返回不同正文）
 *
 * 注：概览要同时请求 `/` 与 `/status`，单个响应替身不够用，这里按路径分发；
 * 未登记的路径按 404 返回，顺便兜住「请求了预期之外的地址」
 *
 * @param routes 路径 → 响应正文
 * @returns fetch 替身
 */
function stubFetchByPath(routes: Record<string, unknown>) {
  /** fetch 替身 */
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      /** 请求地址 */
      const url = urlOf(input);
      /** 命中的路径 */
      const hit = Object.keys(routes).find((path) => url.endsWith(path));
      return hit === undefined
        ? new Response(JSON.stringify({ message: 'Not found' }), { status: 404 })
        : responseOf(routes[hit]);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('KongService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('url', () => {
    it('返回站点的 Admin API 地址', async () => {
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.url(1)).toBe('http://kong:8001');
    });

    it('站点不存在时 404（而不是去请求一个空的地址）', async () => {
      /** 被测服务 */
      const { service } = serviceOf(null);
      await expect(service.url(1)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('info / status', () => {
    it('分别请求 / 与 /status', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetchByPath({
        '/status': { server: { total_requests: 3 } },
        '8001/': { version: '3.9.4' },
      });
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.info(1)).toEqual({ version: '3.9.4' });
      expect(await service.status(1)).toEqual({
        server: { total_requests: 3 },
      });
      expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual([
        'http://kong:8001/',
        'http://kong:8001/status',
      ]);
    });
  });

  describe('summary', () => {
    it('合并 / 与 /status，字段转成前端用的驼峰', async () => {
      stubFetchByPath({
        '8001/': {
          version: '3.9.4',
          edition: 'community',
          hostname: 'home-server',
          node_id: 'node-1',
          lua_version: 'LuaJIT 2.1',
          plugins: {
            available_on_server: { cors: {}, jwt: {} },
            enabled_in_cluster: ['cors'],
          },
        },
        '/status': {
          server: { connections_active: 5, total_requests: 49 },
          database: { reachable: true },
        },
      });
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.summary(1)).toEqual({
        version: '3.9.4',
        edition: 'community',
        hostname: 'home-server',
        nodeId: 'node-1',
        luaVersion: 'LuaJIT 2.1',
        pluginCount: 2,
        enabledCount: 1,
        connectionsActive: 5,
        totalRequests: 49,
        dbReachable: true,
      });
    });

    it('无数据库模式（正文没有 database 段）把可达性记为 null', async () => {
      stubFetchByPath({
        '8001/': { version: '3.9.4' },
        '/status': { server: {} },
      });
      /** 被测服务 */
      const { service } = serviceOf();
      /** 概览 */
      const summary = await service.summary(1);
      // null 表示「不适用」，与 false（不可达）是两件事
      expect(summary.dbReachable).toBeNull();
      expect(summary.version).toBe('3.9.4');
      expect(summary.pluginCount).toBe(0);
    });

    it('任一请求失败就抛错（不返回半真半假的概览）', async () => {
      stubFetchByPath({ '8001/': { version: '3.9.4' } });
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.summary(1).catch((error: unknown) => error);
      expect((err as HttpException).getStatus()).toBe(404);
    });
  });

  describe('plugin', () => {
    it('库里存的地址带结尾斜杠时不会拼出双斜杠', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch(responseOf({ enabled_plugins: [] }));
      /** 被测服务 */
      const { service } = serviceOf({ id: 1, url: 'http://kong:8001//' });
      await service.plugin(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/plugins/enabled',
      );
    });

    it('把 3.x 的 { enabled_plugins } 拆成数组', async () => {
      stubFetch(responseOf({ enabled_plugins: ['cors', 'prometheus'] }));
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.plugin(1)).toEqual(['cors', 'prometheus']);
    });

    it('2.x 直接返回数组时原样给出', async () => {
      stubFetch(responseOf(['cors']));
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.plugin(1)).toEqual(['cors']);
    });

    it('正文既不是数组也没有 enabled_plugins 时给空数组', async () => {
      stubFetch(responseOf({ foo: 1 }));
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.plugin(1)).toEqual([]);
    });
  });

  describe('错误透传', () => {
    it('网关 4xx 带上 Kong 的 message 原状态码抛出（不被吞成 500）', async () => {
      stubFetch(responseOf({ message: 'Unauthorized' }, 401));
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.info(1).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(401);
      expect((err as HttpException).message).toBe('Unauthorized');
    });

    it('非 JSON 正文（如反向代理的 HTML 错误页）退回状态文案', async () => {
      stubFetch(responseOf('<html>bad gateway</html>', 502, 'Bad Gateway'));
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.info(1).catch((error: unknown) => error);
      expect((err as HttpException).getStatus()).toBe(502);
      expect((err as HttpException).message).toBe('<html>bad gateway</html>');
    });

    it('网关不可达时转成 502，并带上原因', async () => {
      stubFetch(new Error('connect ECONNREFUSED'));
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.info(1).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.BAD_GATEWAY,
      );
      expect((err as HttpException).message).toContain('ECONNREFUSED');
    });
  });
});
