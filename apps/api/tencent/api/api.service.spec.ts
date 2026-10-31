// 外部依赖
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KeyService } from '../../cloud/key/key.service.js';
import { ApiService } from './api.service.js';

/** 密钥 */
const KEY = {
  id: 3,
  name: '腾讯云主账号',
  description: '部署 CDN 用',
  provider: 'tencent',
  key: 'AKIDEXAMPLE',
  status: true,
};

/**
 * 组装被测服务
 *
 * @param provider 密钥的云服务商
 * @returns 被测服务与替身
 */
function serviceOf(provider = 'tencent') {
  /** 密钥服务替身 */
  const keySrv = {
    // 注：`show` 走 PUBLIC_SELECT，返回的密钥里**没有** secret
    show: vi.fn(async (_id: number) => ({ ...KEY, provider }) as unknown),
    secret: vi.fn(async (_id: number) => 'SECRETEXAMPLE' as string | null),
  };
  return {
    service: new ApiService(keySrv as unknown as KeyService),
    keySrv,
  };
}

describe('ApiService', () => {
  /** fetch 替身 */
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () => new Response('{"Response":{"RequestId":"rid","Certificates":[]}}'),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 取最后一次 fetch 的请求头与正文
   *
   * @returns 请求头与正文
   */
  function lastCall() {
    /** 调用参数 */
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    return { url, headers: init.headers, body: init.body };
  }

  it('密钥不存在时 404，且不发请求', async () => {
    /** 被测服务与替身 */
    const { service, keySrv } = serviceOf();
    keySrv.show.mockResolvedValueOnce(null);
    await expect(service.ssl(9, 'DescribeCertificates', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('密钥不是腾讯云时 400（阿里云 / AWS 的密钥不能拿来签 TC3）', async () => {
    /** 被测服务 */
    const { service } = serviceOf('aliyun');
    await expect(service.ssl(9, 'DescribeCertificates', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('密钥缺 Secret 时 400，而不是拿空串去签名', async () => {
    /** 被测服务与替身 */
    const { service, keySrv } = serviceOf();
    keySrv.secret.mockResolvedValueOnce(null);
    await expect(service.ssl(9, 'DescribeCertificates', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('地域格式非法时 400（地域会进请求头，挡掉换行等注入字符）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(
      service.lighthouse(9, 'ap-guangzhou\r\nX-Injected: 1', 'DescribeInstances', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('按云服务名拼出正确的域名与服务名，并解开 Response 段', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    expect(await service.ssl(3, 'DescribeCertificates', { Limit: 1 })).toEqual({
      RequestId: 'rid',
      Certificates: [],
    });
    /** SSL 的请求 */
    const sslCall = lastCall();
    expect(sslCall.url).toBe('https://ssl.tencentcloudapi.com/');
    expect(sslCall.headers['X-TC-Action']).toBe('DescribeCertificates');
    expect(sslCall.headers['X-TC-Version']).toBe('2019-12-05');
    expect(sslCall.headers['X-TC-Region']).toBeUndefined();
    expect(sslCall.headers['Authorization']).toContain(
      'Credential=AKIDEXAMPLE/',
    );
    expect(sslCall.headers['Authorization']).toContain('/ssl/tc3_request');
    expect(sslCall.body).toBe('{"Limit":1}');

    await service.cdn(3, 'DescribeDomains', {});
    expect(lastCall().url).toBe('https://cdn.tencentcloudapi.com/');
    expect(lastCall().headers['X-TC-Version']).toBe('2018-06-06');

    await service.dnspod(3, 'DescribeRecordList', {});
    expect(lastCall().url).toBe('https://dnspod.tencentcloudapi.com/');
    expect(lastCall().headers['Authorization']).toContain('/dnspod/tc3_request');

    await service.lighthouse(3, 'ap-guangzhou', 'DescribeInstances', {});
    expect(lastCall().url).toBe('https://lighthouse.tencentcloudapi.com/');
    expect(lastCall().headers['X-TC-Version']).toBe('2020-03-24');
    expect(lastCall().headers['X-TC-Region']).toBe('ap-guangzhou');
  });

  it('地域为空串时不带 X-TC-Region（地域列表接口本身不需要地域）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    await service.lighthouse(3, '', 'DescribeRegions', {});
    expect(lastCall().headers).not.toHaveProperty('X-TC-Region');
  });

  it('响应里没有 Response 段时给空对象，不让前端拿到 undefined', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    expect(await service.ssl(3, 'DescribeCertificates', {})).toEqual({});
    fetchMock.mockResolvedValueOnce(new Response('"text"'));
    expect(await service.ssl(3, 'DescribeCertificates', {})).toEqual({});
  });
});
