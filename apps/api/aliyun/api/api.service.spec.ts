// 外部依赖
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { KeyService } from '../../cloud/key/key.service.js';
import { ApiService } from './api.service.js';

/**
 * 组装被测服务
 *
 * @param patch 密钥字段覆盖项
 * @returns 被测服务与密钥服务替身
 */
function serviceOf(
  patch: { show?: unknown; secret?: string | null } = {},
) {
  /** 密钥服务替身 */
  const keySrv = {
    show: vi.fn(async () =>
      'show' in patch
        ? patch.show
        : { id: 3, provider: 'aliyun', key: 'LTAI-test' },
    ),
    secret: vi.fn(async () => ('secret' in patch ? patch.secret : 'secret-test')),
  };
  return {
    service: new ApiService(keySrv as unknown as KeyService),
    keySrv,
  };
}

/** 取最近一次 fetch 调用的 URL 与 init */
function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [
    string,
    { method: string; body?: string; headers?: Record<string, string> },
  ];
  return { url: new URL(url), init };
}

describe('ApiService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('密钥不存在时 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ show: null });
    await expect(
      service.ssl(9, 'ListUserCertificateOrder'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('云服务商不是 aliyun 时 400', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      show: { id: 1, provider: 'tencent', key: 'AKID' },
    });
    await expect(
      service.ssl(1, 'ListUserCertificateOrder'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('密钥缺少 Secret 时 400', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ secret: null });
    await expect(
      service.ssl(3, 'ListUserCertificateOrder'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('版本号格式非法时 400（版本会进签名）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(
      service.ssl(3, 'ListUserCertificateOrder', {}, '2020-4-7'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GET 时把公共参数与业务参数全量放进查询串，并带签名', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{"TotalCount":0}'));
    vi.stubGlobal('fetch', fetchMock);

    /** 被测服务 */
    const { service } = serviceOf();
    await service.ssl(3, 'ListUserCertificateOrder', { OrderType: 'CERT' });

    /** 调用参数 */
    const { url, init } = lastCall(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(url.origin + url.pathname).toBe('https://cas.aliyuncs.com/');
    expect(url.searchParams.get('Action')).toBe('ListUserCertificateOrder');
    expect(url.searchParams.get('Version')).toBe('2020-04-07');
    expect(url.searchParams.get('Format')).toBe('JSON');
    expect(url.searchParams.get('AccessKeyId')).toBe('LTAI-test');
    expect(url.searchParams.get('SignatureMethod')).toBe('HMAC-SHA1');
    expect(url.searchParams.get('SignatureVersion')).toBe('1.0');
    expect(url.searchParams.get('OrderType')).toBe('CERT');
    /** 签名（`searchParams.get` 会自动解码，故这里拿到的是原始 Base64） */
    const signature = url.searchParams.get('Signature') ?? '';
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // 注：签名在查询串里必须是被编码过的 —— `+` `/` `=` 裸奔会被服务端当成另一个值
    expect(url.search).toContain(`Signature=${encodeURIComponent(signature)}`);
    // 时间戳是秒级 UTC，不带毫秒
    expect(url.searchParams.get('Timestamp')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it('POST 时查询串只留公共参数，业务参数走表单正文', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{"RequestId":"x"}'));
    vi.stubGlobal('fetch', fetchMock);

    /** 被测服务 */
    const { service } = serviceOf();
    await service.sslPost(3, 'UploadUserCertificate', {
      Name: 'cert-1',
      Cert: '-----BEGIN CERTIFICATE-----',
      Key: '-----BEGIN PRIVATE KEY-----',
    });

    /** 调用参数 */
    const { url, init } = lastCall(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    // 公共参数留在查询串
    expect(url.searchParams.get('Action')).toBe('UploadUserCertificate');
    expect(url.searchParams.get('Signature')).toBeTruthy();
    // 业务参数不在查询串，避免证书 PEM 撑爆 URL
    expect(url.searchParams.get('Cert')).toBeNull();
    expect(init.body).toContain('Cert=');
    expect(init.body).toContain('Name=cert-1');
  });

  it('sslPost 默认版本为 2020-04-07，可显式覆盖', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    /** 被测服务 */
    const { service } = serviceOf();
    await service.sslPost(3, 'RevokeCertificate');
    expect(lastCall(fetchMock).url.searchParams.get('Version')).toBe('2020-04-07');

    await service.sslPost(3, 'CreateDVOrderAudit', {}, '2018-07-13');
    expect(lastCall(fetchMock).url.searchParams.get('Version')).toBe('2018-07-13');
  });

  it('签名随 Secret 变化（同一请求两次签名不同）', async () => {
    /** fetch 替身 */
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    /** 第一个服务 */
    const first = serviceOf({ secret: 'secret-a' }).service;
    await first.ssl(3, 'ListUserCertificateOrder', { OrderType: 'CERT' });
    /** 第一个签名 */
    const sigA = lastCall(fetchMock).url.searchParams.get('Signature');

    /** 第二个服务 */
    const second = serviceOf({ secret: 'secret-b' }).service;
    await second.ssl(3, 'ListUserCertificateOrder', { OrderType: 'CERT' });
    /** 第二个签名 */
    const sigB = lastCall(fetchMock).url.searchParams.get('Signature');

    expect(sigA).not.toBe(sigB);
  });
});
