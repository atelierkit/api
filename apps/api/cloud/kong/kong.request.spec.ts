// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KONG_TIMEOUT, kongRequest, messageOf } from './kong.request.js';

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
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText,
  });
}

describe('kongRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('拼出完整地址，并带上超时（网关不可达时不能挂死）', async () => {
    /** fetch 替身 */
    const fetchMock = stubFetch(responseOf({ data: [] }));
    await kongRequest('http://kong:8001', '/routes');
    expect(fetchMock.mock.calls[0][0]).toBe('http://kong:8001/routes');
    /** 请求参数 */
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('地址带结尾斜杠时不会拼出双斜杠', async () => {
    /** fetch 替身 */
    const fetchMock = stubFetch(responseOf({}));
    await kongRequest('http://kong:8001//', '/plugins/enabled');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://kong:8001/plugins/enabled',
    );
  });

  it('带正文时按 JSON 发送并声明 Content-Type', async () => {
    /** fetch 替身 */
    const fetchMock = stubFetch(responseOf({ id: 'abc' }));
    await kongRequest('http://kong:8001', '/routes', {
      method: 'POST',
      body: { name: '路由一', paths: ['/a'] },
    });
    /** 请求参数 */
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(
      JSON.stringify({ name: '路由一', paths: ['/a'] }),
    );
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('不带正文时不声明 Content-Type（否则 DELETE 会被 Kong 当成空表单）', async () => {
    /** fetch 替身 */
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    expect(
      await kongRequest('http://kong:8001', '/routes/abc', {
        method: 'DELETE',
      }),
    ).toBe('');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({});
  });

  it('响应正文按 JSON 解析', async () => {
    stubFetch(responseOf({ id: 'abc', name: '路由一' }));
    expect(await kongRequest('http://kong:8001', '/routes/abc')).toEqual({
      id: 'abc',
      name: '路由一',
    });
  });

  it('网关 4xx 原状态码抛出，并带 Kong 的 message', async () => {
    stubFetch(responseOf({ message: 'Unauthorized' }, 401));
    /** 抛出的异常 */
    const err = await kongRequest('http://kong:8001', '/routes').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).message).toBe('Unauthorized');
  });

  it('非 JSON 正文逐级兜底（先原文、再状态文案）', async () => {
    stubFetch(responseOf('<html>bad gateway</html>', 502, 'Bad Gateway'));
    /** 抛出的异常 */
    const err = await kongRequest('http://kong:8001', '/routes').catch(
      (error: unknown) => error,
    );
    expect((err as HttpException).getStatus()).toBe(502);
    expect((err as HttpException).message).toBe('<html>bad gateway</html>');
  });

  it('网关不可达时转成 502，并带上原因', async () => {
    stubFetch(new Error('connect ECONNREFUSED'));
    /** 抛出的异常 */
    const err = await kongRequest('http://kong:8001', '/routes').catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('ECONNREFUSED');
  });

  it('超时取 10 秒', () => {
    expect(KONG_TIMEOUT).toBe(10000);
  });
});

describe('messageOf', () => {
  it('对象取 message', () => {
    expect(messageOf({ message: '唯一键冲突' }, '')).toBe('唯一键冲突');
  });

  it('字符串正文取原文', () => {
    expect(messageOf('  网关炸了 ', 'Bad Gateway')).toBe('  网关炸了 ');
  });

  it('空正文退回状态文案，全空时给默认文案', () => {
    expect(messageOf('', 'Bad Gateway')).toBe('Bad Gateway');
    expect(messageOf('', '')).toBe('网关请求失败！');
  });
});
