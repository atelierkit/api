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

  describe('report', () => {
    it('请求 /default/license/report 并原样返回正文', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch(responseOf({ version: '3.6.1' }));
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.report(1)).toEqual({ version: '3.6.1' });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/default/license/report',
      );
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
  });

  describe('错误透传', () => {
    it('网关 4xx 带上 Kong 的 message 原状态码抛出（不被吞成 500）', async () => {
      stubFetch(responseOf({ message: 'Unauthorized' }, 401));
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.report(1).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(401);
      expect((err as HttpException).message).toBe('Unauthorized');
    });

    it('非 JSON 正文（如反向代理的 HTML 错误页）退回状态文案', async () => {
      stubFetch(responseOf('<html>bad gateway</html>', 502, 'Bad Gateway'));
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.report(1).catch((error: unknown) => error);
      expect((err as HttpException).getStatus()).toBe(502);
      expect((err as HttpException).message).toBe('<html>bad gateway</html>');
    });

    it('网关不可达时转成 502，并带上原因', async () => {
      stubFetch(new Error('connect ECONNREFUSED'));
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.report(1).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.BAD_GATEWAY,
      );
      expect((err as HttpException).message).toContain('ECONNREFUSED');
    });
  });
});
