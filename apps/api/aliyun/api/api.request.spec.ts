// 外部依赖
import { HttpStatus } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ALIYUN_TIMEOUT, AliyunException, aliyunRequest } from './api.request.js';

/** 服务接入地址 */
const ENDPOINT = 'https://cas.aliyuncs.com';

describe('aliyunRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET 时把查询串拼在问号后，且不带正文', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{"RequestId":"x"}'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await aliyunRequest(ENDPOINT, 'GET', 'Action=A&Signature=s')).toEqual({
      RequestId: 'x',
    });

    /** 调用参数 */
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body?: string; signal: AbortSignal },
    ];
    expect(url).toBe('https://cas.aliyuncs.com/?Action=A&Signature=s');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    // 挂超时，避免云厂商长尾把请求一直吊着
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(ALIYUN_TIMEOUT).toBeGreaterThan(0);
  });

  it('POST 时正文走表单，并带上 Content-Type', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{"RequestId":"x"}'));
    vi.stubGlobal('fetch', fetchMock);

    await aliyunRequest(ENDPOINT, 'POST', 'Action=A&Signature=s', 'Name=a&Cert=b');

    /** 调用参数 */
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('Name=a&Cert=b');
  });

  it('非 2xx 转成同状态码的 AliyunException，并带出原始错误码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"RequestId":"r","Code":"InsufficientQuota","Message":"额度不足。"}',
            { status: 400 },
          ),
      ),
    );
    /** 捕获的异常 */
    const err = await aliyunRequest(ENDPOINT, 'GET', '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliyunException);
    expect((err as AliyunException).getStatus()).toBe(400);
    expect((err as AliyunException).code).toBe('InsufficientQuota');
    expect((err as AliyunException).message).toBe('额度不足。');
  });

  it('非 2xx 且正文不是 JSON 时用原文当说明', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gateway timeout', { status: 504 })),
    );
    /** 捕获的异常 */
    const err = await aliyunRequest(ENDPOINT, 'GET', '').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliyunException);
    expect((err as AliyunException).message).toBe('gateway timeout');
    expect((err as AliyunException).code).toBe('');
  });

  it('连不上时转 502，不把网络故障伪装成业务失败', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND cas.aliyuncs.com');
      }),
    );
    /** 捕获的异常 */
    const err = await aliyunRequest(ENDPOINT, 'GET', '').catch((e: unknown) => e);
    expect((err as AliyunException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as AliyunException).message).toContain('ENOTFOUND');
  });

  it('200 但正文不是 JSON 时包成 Message 返回（不抛错）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>')),
    );
    expect(await aliyunRequest(ENDPOINT, 'GET', '')).toEqual({
      Message: '<html>oops</html>',
    });
  });
});
