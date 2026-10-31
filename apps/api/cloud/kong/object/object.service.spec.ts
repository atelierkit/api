// 外部依赖
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KongService } from '../kong.service.js';
import { TEST_CERT_PEM } from './certificate.fixture.js';
import { ObjectService } from './object.service.js';

/**
 * 组装被测服务
 *
 * @param url 站点 Admin API 地址
 * @returns 被测服务与站点服务替身
 */
function serviceOf(url = 'http://kong:8001') {
  /** 站点服务替身，注：只用到 url() */
  const kongSrv = { url: vi.fn(async (_id: number) => url) };
  return {
    service: new ObjectService(kongSrv as unknown as KongService),
    kongSrv,
  };
}

/**
 * 替换全局 fetch，按调用顺序返回给定响应
 *
 * 注：翻页用例需要「第一次带游标、第二次不带」，单个固定响应测不出来
 *
 * @param answers 响应正文与状态码，用尽后重复最后一个
 * @returns fetch 替身
 */
function stubFetch(...answers: Array<unknown>) {
  /** 已调用次数 */
  let count = 0;
  /** fetch 替身 */
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      /** 本次响应正文 */
      const answer = answers[Math.min(count, answers.length - 1)];
      count++;
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('ObjectService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('index', () => {
    it('请求 /{type}，方法为 GET', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch({ data: [{ id: 'a', name: '服务一' }] });
      /** 被测服务与替身 */
      const { service, kongSrv } = serviceOf();
      expect(await service.index(3, 'services')).toEqual([
        { id: 'a', name: '服务一' },
      ]);
      expect(kongSrv.url).toHaveBeenCalledWith(3);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/services',
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    });

    it('按 offset 自行翻页并汇总（不用 Kong 给的 next，它可能是完整 URL）', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch(
        { data: [{ id: 'a' }], offset: 'abc/def==' },
        { data: [{ id: 'b' }] },
      );
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.index(3, 'routes')).toEqual([
        { id: 'a' },
        { id: 'b' },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe(
        'http://kong:8001/routes?offset=abc%2Fdef%3D%3D',
      );
    });

    it('网关的 data 不是数组时按空清单处理（不抛错）', async () => {
      stubFetch({});
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.index(3, 'upstreams')).toEqual([]);
    });

    it('翻页永不到头时报 502，而不是静默返回半份数据', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch({ data: [], offset: 'same' });
      /** 被测服务 */
      const { service } = serviceOf();
      /** 抛出的异常 */
      const err = await service.index(3, 'plugins').catch(
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(fetchMock).toHaveBeenCalledTimes(100);
    });

    it('站点不存在时 404 透出（不去请求空地址）', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch({ data: [] });
      /** 站点服务替身 */
      const kongSrv = {
        url: vi.fn(async (_id: number) => {
          throw new NotFoundException('指定网关不存在！');
        }),
      };
      /** 被测服务 */
      const service = new ObjectService(kongSrv as unknown as KongService);
      await expect(service.index(9, 'routes')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('证书类型补上域名与有效期', async () => {
      stubFetch({
        data: [{ id: 'cert-1', cert: TEST_CERT_PEM }],
      });
      /** 被测服务 */
      const { service } = serviceOf();
      /** 补齐后的证书 */
      const [row] = await service.index(3, 'certificates');
      expect(row['snis']).toEqual(['example.com', 'www.example.com']);
      expect(row['start']).toBe(Date.UTC(2026, 9, 31, 1, 58, 22) / 1000);
    });

    it('证书解析失败时不影响整页（原样返回，不加字段）', async () => {
      stubFetch({ data: [{ id: 'cert-2', cert: '脏数据' }] });
      /** 被测服务 */
      const { service } = serviceOf();
      /** 原始证书对象 */
      const [row] = await service.index(3, 'certificates');
      expect(row).toEqual({ id: 'cert-2', cert: '脏数据' });
    });

    it('非证书类型不做任何加工', async () => {
      stubFetch({ data: [{ id: 'r1', cert: '脏数据' }] });
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.index(3, 'routes')).toEqual([
        { id: 'r1', cert: '脏数据' },
      ]);
    });
  });

  describe('show', () => {
    it('请求 /{type}/{id}', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch({ id: 'abc', name: '路由一' });
      /** 被测服务 */
      const { service } = serviceOf();
      expect(await service.show(3, 'routes', 'abc')).toEqual({
        id: 'abc',
        name: '路由一',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/routes/abc',
      );
    });
  });

  describe('create', () => {
    it('POST 到 /{type}，正文原样透传', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch({ id: 'new' });
      /** 被测服务 */
      const { service } = serviceOf();
      /** 对象数据 */
      const value = { name: '用户一', username: 'u1' };
      expect(await service.create(3, 'consumers', value)).toEqual({
        id: 'new',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/consumers',
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
      expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(value));
    });
  });

  describe('update', () => {
    it('PATCH 到 /{type}/{id}', async () => {
      /** fetch 替身 */
      const fetchMock = stubFetch({ id: 'abc' });
      /** 被测服务 */
      const { service } = serviceOf();
      await service.update(3, 'services', 'abc', { enabled: false });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/services/abc',
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
      expect(fetchMock.mock.calls[0][1]?.body).toBe(
        JSON.stringify({ enabled: false }),
      );
    });
  });

  describe('destroy', () => {
    it('DELETE 到 /{type}/{id}，204 空正文不解析', async () => {
      /** fetch 替身 */
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 204 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      /** 被测服务 */
      const { service } = serviceOf();
      await expect(service.destroy(3, 'routes', 'abc')).resolves.toBe(
        undefined,
      );
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://kong:8001/routes/abc',
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
    });
  });
});
