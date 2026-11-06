// 外部依赖
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `node:dns` 替身
 *
 * 注：`vi.hoisted` 让替身在 `vi.mock` 提升之前就位，被测模块拿到的就是同一个对象
 */
const dnsMock = vi.hoisted(() => ({
  resolveTxt: vi.fn(),
  resolveCname: vi.fn(),
  resolveNs: vi.fn(),
}));

vi.mock('node:dns', () => ({ promises: dnsMock }));

// 内部依赖
import { nsOf, probeDns } from './ssl.dns.js';

/** 待验证的 TXT 记录 */
const TXT_RECORD = {
  type: 'TXT' as const,
  domain: '_dnsauth.kong.example.com',
  value: 'v-expected',
};

/** 记录不存在时的错误 */
function missingError(): NodeJS.ErrnoException {
  /** 错误对象 */
  const err: NodeJS.ErrnoException = new Error('queryTxt ENODATA');
  err.code = 'ENODATA';
  return err;
}

describe('probeDns', () => {
  beforeEach(() => {
    dnsMock.resolveTxt.mockReset();
    dnsMock.resolveCname.mockReset();
    dnsMock.resolveNs.mockReset();
    dnsMock.resolveNs.mockResolvedValue([]);
  });

  it('TXT 命中时 matched，并拼回被拆段的记录值', async () => {
    dnsMock.resolveTxt.mockResolvedValue([['"v-expec', 'ted"']]);
    expect(await probeDns(TXT_RECORD, 'example.com')).toEqual({
      status: 'matched',
      existing: ['v-expected'],
      ns: [],
    });
  });

  it('ENODATA（域名在但没这条记录）算 pending，不算查询失败', async () => {
    dnsMock.resolveTxt.mockRejectedValue(missingError());
    expect((await probeDns(TXT_RECORD)).status).toBe('pending');
  });

  it('有记录但值不符时 mismatched', async () => {
    dnsMock.resolveTxt.mockResolvedValue([['"v-other"']]);
    expect((await probeDns(TXT_RECORD)).status).toBe('mismatched');
  });

  it('超时 / 上游不可达时 unknown（不能报成 pending 骗用户）', async () => {
    /** 网络类错误 */
    const err: NodeJS.ErrnoException = new Error('queryTxt EAI_AGAIN');
    err.code = 'EAI_AGAIN';
    dnsMock.resolveTxt.mockRejectedValue(err);
    expect((await probeDns(TXT_RECORD)).status).toBe('unknown');
  });

  it('CNAME 记录去掉末尾的点再比', async () => {
    dnsMock.resolveCname.mockResolvedValue(['abc.example-cdn.com.']);
    expect(
      await probeDns({
        type: 'CNAME',
        domain: '_x.example.com',
        value: 'abc.example-cdn.com',
      }),
    ).toEqual({
      status: 'matched',
      existing: ['abc.example-cdn.com'],
      ns: [],
    });
  });
});

describe('nsOf', () => {
  it('逐级上推，取第一个有结果的层级', async () => {
    dnsMock.resolveNs.mockImplementation(async (level: string) => {
      if (level === 'example.com') {
        return ['desert.dnspod.net.', 'cancer.dnspod.net.'];
      }
      /** 更深层级没有 NS */
      const err: NodeJS.ErrnoException = new Error('queryNs ENODATA');
      err.code = 'ENODATA';
      throw err;
    });
    expect(await nsOf('_dnsauth.kong.example.com')).toEqual([
      'desert.dnspod.net',
      'cancer.dnspod.net',
    ]);
  });

  it('全部层级都查不到时返回空数组（不抛错）', async () => {
    dnsMock.resolveNs.mockRejectedValue(missingError());
    expect(await nsOf('_dnsauth.kong.example.com')).toEqual([]);
  });
});
