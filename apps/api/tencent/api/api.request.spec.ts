// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { TENCENT_TIMEOUT, tencentRequest } from './api.request.js';

/** 请求头（内容与签名无关，本文件只测传输层） */
const HEADERS = { Authorization: 'TC3-HMAC-SHA256 ...' };

describe('tencentRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST 到 https 域名根路径，并带上正文与头部', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{"Response":{"ok":1}}'));
    vi.stubGlobal('fetch', fetchMock);

    expect(
      await tencentRequest('cdn.tencentcloudapi.com', HEADERS, '{"a":1}'),
    ).toEqual({ Response: { ok: 1 } });

    /** 调用参数 */
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal: AbortSignal;
      },
    ];
    expect(url).toBe('https://cdn.tencentcloudapi.com/');
    expect(init.method).toBe('POST');
    expect(init.headers).toBe(HEADERS);
    expect(init.body).toBe('{"a":1}');
    // 挂超时，避免云厂商长尾把浏览器一直吊着
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(TENCENT_TIMEOUT).toBeGreaterThan(0);
  });

  it('业务错误仍是 200，正文原样返回（不在传输层抛）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"Response":{"Error":{"Code":"AuthFailure.SignatureFailure","Message":"签名错误"},"RequestId":"x"}}',
          ),
      ),
    );
    expect(
      await tencentRequest('ssl.tencentcloudapi.com', HEADERS, '{}'),
    ).toEqual({
      Response: {
        Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' },
        RequestId: 'x',
      },
    });
  });

  it('非 2xx 转成同状态码的 HttpException 并带上正文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway timeout', { status: 504 })),
    );
    /** 捕获的异常 */
    const err = await tencentRequest('cdn.tencentcloudapi.com', HEADERS, '{}').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(504);
    expect((err as HttpException).message).toBe('gateway timeout');
  });

  it('连不上时转 502，不把网络故障伪装成业务失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    /** 捕获的异常 */
    const err = await tencentRequest('cdn.tencentcloudapi.com', HEADERS, '{}').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('ENOTFOUND');
  });

  it('200 但正文不是 JSON 时原样返回文本', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>')),
    );
    expect(
      await tencentRequest('cdn.tencentcloudapi.com', HEADERS, '{}'),
    ).toBe('<html>oops</html>');
  });
});
