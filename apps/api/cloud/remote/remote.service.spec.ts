// 外部依赖
import {
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { decryptSecret, encryptSecret } from '../../shared/common/secret.util.js';
import { OperateService } from '../../shared/operate/operate.service.js';
import { QueueService } from '../../shared/queue/queue.service.js';
import { fingerprintOf } from './remote.key.js';
import { SUMMARY_COMMAND, tcpProbe } from './remote.probe.js';
import type { RemoteUpdateDto } from './remote.dto.js';
import { RemoteEntity, RemoteLogEntity } from './remote.entity.js';
import { RemoteService } from './remote.service.js';
import type { RemoteSshService, SshConfig } from './remote.ssh.js';
import { RemoteError } from './remote.types.js';

// 注：只替换 `tcpProbe`（它会真的发起网络连接），解析类纯函数保持原实现
vi.mock('./remote.probe.js', async (importOriginal) => {
  /** 原实现 */
  const actual = await importOriginal<typeof import('./remote.probe.js')>();
  return { ...actual, tcpProbe: vi.fn() };
});

/** 探测替身 */
const probeMock = vi.mocked(tcpProbe);

/** 测试用的加解密口令 */
const SETTING_KEY = 'unit-test-setting-key';

/** 明文凭据 */
const PASSWORD = 'p@ssw0rd';

// 注：用 ssh2 自带的生成器，产出 `ssh-keygen` 的默认形态（OpenSSH）——
// Node 的 `generateKeyPairSync` 只产 PKCS#8，而 PKCS#8 是 ssh2 解析不了的格式
const PLAIN_KEY = ssh2.utils.generateKeyPairSync('ed25519').private;

/** PKCS#8 的 RSA 私钥，注：从本地文件选进来的常见形态之一，落库前应被转成传统 PEM */
const PKCS8_RSA_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** 主机记录（密码鉴权，凭据为密文） */
const ROW = {
  id: 1,
  name: '工控机',
  description: '局域网内的 Ubuntu',
  host: '192.168.1.3',
  port: 22,
  authType: 'password',
  username: 'atelier',
  password: encryptSecret(PASSWORD, SETTING_KEY),
  privateKey: '',
  passphrase: '',
  charset: 'utf-8',
  fingerprint: '',
  rootPath: '',
  status: true,
  update: {},
};

/** 合法的创建入参 */
const CREATE = {
  name: '工控机',
  description: '局域网内的 Ubuntu',
  host: '192.168.1.3',
  port: 22,
  authType: 'password',
  username: 'atelier',
  password: PASSWORD,
  status: true,
};

/**
 * 组装被测服务
 *
 * @param row 记录查询结果
 * @returns 被测服务与全部替身
 */
function serviceOf(row: unknown = ROW) {
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async () => 7) };
  /** 队列服务替身 */
  const queueSrv = { addTask: vi.fn(() => 0) };
  /** SSH 服务替身 */
  const sshSrv = {
    open: vi.fn(async (_config: SshConfig) => ({}) as unknown),
    exec: vi.fn(async (_client: unknown, _command: string) => ''),
    shell: vi.fn(async () => ({}) as unknown),
    close: vi.fn(),
  };
  /** 主机存储器替身 */
  const repository = {
    find: vi.fn(async () => [row] as unknown[]),
    findOne: vi.fn(async () => row as unknown),
    existsBy: vi.fn(async () => true),
    insert: vi.fn(async () => ({ identifiers: [{ id: 5 }] })),
    update: vi.fn(async () => ({ affected: 1 })),
    metadata: { tableName: 'remotes', columns: [] as unknown[] },
  };
  /** 日志存储器替身 */
  const logRepository = {
    find: vi.fn(async () => [row] as unknown[]),
    metadata: { tableName: 'remotes_logs', columns: [] as unknown[] },
  };
  return {
    service: new RemoteService(
      operateSrv as unknown as OperateService,
      queueSrv as unknown as QueueService,
      sshSrv as unknown as RemoteSshService,
      repository as unknown as Repository<RemoteEntity>,
      logRepository as unknown as Repository<RemoteLogEntity>,
    ),
    repository,
    sshSrv,
  };
}

/**
 * 取某个替身第 n 次调用的某个入参
 *
 * @param mock 替身方法
 * @param index 第几次调用
 * @param arg 第几个参数
 * @returns 入参
 */
function argOf(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
  arg = 0,
): unknown {
  return (mock.mock.calls[index] ?? [])[arg];
}

beforeEach(() => {
  process.env.SETTING_KEY = SETTING_KEY;
  probeMock.mockReset();
  probeMock.mockResolvedValue({ reachable: true, latencyMs: 3, error: '' });
});

afterEach(() => {
  delete process.env.SETTING_KEY;
});

describe('RemoteService 查询', () => {
  it('清单 / 详情 / 日志都不下发凭据，只回 hasXxx', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...ROW,
      privateKey: 'enc:v1:aa:bb:cc',
      passphrase: 'enc:v1:dd:ee:ff',
    });
    /** 详情 */
    const detail = await service.show(1);
    expect(detail).toMatchObject({
      id: 1,
      password: '',
      privateKey: '',
      passphrase: '',
      hasPassword: true,
      hasKey: true,
      hasPassphrase: true,
    });
    expect((await service.index())[0]).toMatchObject({ password: '', hasPassword: true });
    expect((await service.log(1))[0]).toMatchObject({ password: '', hasPassword: true });
  });

  it('未配置凭据时 hasXxx 全为 false', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...ROW, password: '' });
    expect(await service.show(1)).toMatchObject({
      hasPassword: false,
      hasKey: false,
      hasPassphrase: false,
    });
  });

  it('详情不存在时返回 null（由控制器转 404）', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    expect(await service.show(9)).toBeNull();
  });
});

describe('RemoteService 私钥预检', () => {
  it('回格式 / 转换标记 / 加密标记 / 指纹，但不回私钥明文', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 预检结果 */
    const view = service.inspectKey(PLAIN_KEY);
    expect(view).toMatchObject({
      format: 'openssh',
      converted: false,
      encrypted: false,
    });
    expect(view.fingerprint).toMatch(/^SHA256:/);
    // 注：凭据永不下发 —— 预览接口也不例外，浏览器本来就有原文，没必要从服务端绕一圈
    expect(view).not.toHaveProperty('privateKey');
  });

  it('PKCS#8 标出「保存时会被转换」', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    expect(service.inspectKey(PKCS8_RSA_KEY)).toMatchObject({
      format: 'pkcs8',
      converted: true,
    });
  });

  it('不合法内容抛 422（前端据此在选文件后立刻提示）', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    expect(() => service.inspectKey('not-a-key')).toThrow(
      UnprocessableEntityException,
    );
  });
});

describe('RemoteService 创建', () => {
  it('密码鉴权：密码加密落库，私钥与口令清空，指纹从空起步', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    expect(await service.create(CREATE, 7, 9)).toBe(5);
    /** 落库内容 */
    const entity = argOf(repository.insert) as Record<string, unknown>;
    expect(entity['password']).toMatch(/^enc:v1:/);
    expect(entity['privateKey']).toBe('');
    expect(entity['passphrase']).toBe('');
    // 注：指纹一律从空起步，不允许新建时手工填一个「假指纹」
    expect(entity['fingerprint']).toBe('');
    expect(entity['charset']).toBe('utf-8');
  });

  it('私钥鉴权：私钥加密落库，密码清空', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    await service.create(
      { ...CREATE, authType: 'key', privateKey: PLAIN_KEY, password: undefined },
      7,
      9,
    );
    /** 落库内容 */
    const entity = argOf(repository.insert) as Record<string, unknown>;
    expect(entity['privateKey']).toMatch(/^enc:v1:/);
    expect(entity['password']).toBe('');
  });

  it('PKCS#8 私钥落库前被转成传统 PEM（库里不留 ssh2 解析不了的格式）', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    await service.create(
      {
        ...CREATE,
        authType: 'key',
        privateKey: PKCS8_RSA_KEY,
        password: undefined,
      },
      7,
      9,
    );
    /** 落库内容 */
    const entity = argOf(repository.insert) as Record<string, unknown>;
    /** 解密后的私钥 */
    const stored = decryptSecret(String(entity['privateKey']), SETTING_KEY);
    expect(stored.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(ssh2.utils.parseKey(stored)).not.toBeInstanceOf(Error);
  });

  it('私钥无法解析时保存即拒（不让用户等到连接时才看到 OpenSSL 原文）', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await expect(
      service.create(
        { ...CREATE, authType: 'key', privateKey: 'not-a-key', password: undefined },
        7,
        9,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('未配置 SETTING_KEY 时报配置错误，而不是静默存明文', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    delete process.env.SETTING_KEY;
    await expect(service.create(CREATE, 7, 9)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('RemoteService 更新', () => {
  it('只改说明时不碰凭据（详情不下发密文，空串只能表示「不修改」）', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    await service.update(1, { description: '改了个说明' }, 7, 9);
    /** 落库内容 */
    const patch = argOf(repository.update, 0, 1) as Record<string, unknown>;
    expect(patch).toMatchObject({ description: '改了个说明' });
    expect(patch).not.toHaveProperty('password');
    expect(patch).not.toHaveProperty('privateKey');
  });

  it('切到私钥鉴权会清掉密码（否则旧密码永远留在库里）', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    await service.update(1, { authType: 'key', privateKey: PLAIN_KEY }, 7, 9);
    /** 落库内容 */
    const patch = argOf(repository.update, 0, 1) as Record<string, unknown>;
    expect(patch['password']).toBe('');
    expect(patch['privateKey']).toMatch(/^enc:v1:/);
  });

  it('切到私钥鉴权但库里没有私钥时拒绝（切不干净的半截状态）', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({ ...ROW, privateKey: '' });
    await expect(
      service.update(1, { authType: 'key' }, 7, 9),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('切到密码鉴权但没给密码时拒绝', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...ROW, authType: 'key', password: '', privateKey: 'enc:v1:a:b:c' });
    await expect(
      service.update(1, { authType: 'password' }, 7, 9),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('提交 *** 表示保持原凭据（与邮件授权码同风格）', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    await service.update(1, { password: '***' } as RemoteUpdateDto, 7, 9);
    /** 落库内容 */
    const patch = argOf(repository.update, 0, 1) as Record<string, unknown>;
    expect(patch).not.toHaveProperty('password');
  });

  it('指纹不能通过普通更新改（只能走 trust，否则告警会被静默抹掉）', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    await service.update(
      1,
      { fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      7,
      9,
    );
    /** 落库内容 */
    const patch = argOf(repository.update, 0, 1) as Record<string, unknown>;
    expect(patch).not.toHaveProperty('fingerprint');
  });

  it('主机不存在时 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    await expect(service.update(9, { name: 'x' }, 7, 9)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RemoteService 连接参数', () => {
  it('密码解密后进连接参数，字符集缺省 utf-8', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 连接信息 */
    const target = await service.target(1);
    expect(target.config).toMatchObject({
      host: '192.168.1.3',
      port: 22,
      username: 'atelier',
      password: PASSWORD,
    });
    expect(target.config.privateKey).toBeUndefined();
    expect(target.charset).toBe('utf-8');
  });

  it('私钥鉴权时解密私钥，且空口令不带 passphrase 字段', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...ROW,
      authType: 'key',
      password: '',
      privateKey: encryptSecret(PLAIN_KEY, SETTING_KEY),
    });
    /** 连接信息 */
    const target = await service.target(1);
    expect(target.config.privateKey).toBe(PLAIN_KEY);
    expect(target.config.passphrase).toBeUndefined();
    expect(target.config.password).toBeUndefined();
  });

  it('未记录指纹时放行首连，记录过之后必须一致', async () => {
    /** 被测服务（无指纹） */
    const first = await serviceOf().service.target(1);
    expect(first.config.hostVerifier(Buffer.from('host-key'))).toBe(true);
    expect(first.observed()).toBe(fingerprintOf(Buffer.from('host-key')));
    // 注：已记录指纹且一致
    /** 被测服务（指纹一致） */
    const second = await serviceOf({
      ...ROW,
      fingerprint: fingerprintOf(Buffer.from('host-key')),
    }).service.target(1);
    expect(second.config.hostVerifier(Buffer.from('host-key'))).toBe(true);
    // 注：指纹变了必须拒绝 —— 认证之前就中止，绝不把密码发给未经验证的主机
    expect(second.config.hostVerifier(Buffer.from('other-key'))).toBe(false);
  });

  it('主机被禁用时拒绝连接', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...ROW, status: false });
    await expect(service.target(1)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('不带 enc:v1: 前缀的凭据按明文使用（兼容手工 SQL 导入）', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...ROW, password: 'legacy-plain' });
    expect((await service.target(1)).config.password).toBe('legacy-plain');
  });

  it('密文损坏时给出可读的 422（SETTING_KEY 可能被更换）', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...ROW, password: 'enc:v1:zz:zz:zz' });
    await expect(service.target(1)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

describe('RemoteService 概览与诊断', () => {
  /** 概览命令的一份输出 */
  const SUMMARY_OUTPUT = [
    '@@OS@@',
    'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
    '@@UNAME@@',
    'Linux 5.15.0-91-generic',
    '@@CPU@@',
    '4',
    '@@WHO@@',
    'atelier',
    '@@END@@',
  ].join('\n');

  it('概览用一条复合命令取全量，结束后关闭连接', async () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    sshSrv.exec.mockResolvedValue(SUMMARY_OUTPUT);
    /** 概览 */
    const summary = await service.summary(1);
    expect(argOf(sshSrv.exec, 0, 1)).toBe(SUMMARY_COMMAND);
    expect(summary.osName).toBe('Ubuntu 22.04.4 LTS');
    expect(summary.cpus).toBe(4);
    expect(sshSrv.close).toHaveBeenCalled();
  });

  it('概览在连接失败时转成 HTTP 异常（状态码按原因区分）', async () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    sshSrv.open.mockRejectedValue(
      new RemoteError('AUTH_FAILED', '认证失败'),
    );
    await expect(service.summary(1)).rejects.toMatchObject({ status: 422 });
  });

  it('诊断全部通过时给出五段结果', async () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    sshSrv.open.mockImplementation(async (config: SshConfig) => {
      config.hostVerifier(Buffer.from('host-key'));
      return {} as never;
    });
    sshSrv.exec.mockResolvedValue('Linux atelier 5.15.0-91-generic x86_64 GNU/Linux');
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ok).toBe(true);
    expect(result.stages.map((stage) => stage.name)).toEqual([
      '网络可达',
      '握手',
      '认证',
      '命令执行',
      '主机身份',
    ]);
    expect(result.currentFingerprint).toBe(fingerprintOf(Buffer.from('host-key')));
    expect(result.uname).toContain('Linux');
    expect(result.warnings.join()).toContain('尚未记录公钥指纹');
  });

  it('TCP 不通时立即返回，不再往下连', async () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    probeMock.mockResolvedValue({
      reachable: false,
      latencyMs: 5000,
      error: '连接超时',
    });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ok).toBe(false);
    expect(result.stages).toHaveLength(1);
    expect(sshSrv.open).not.toHaveBeenCalled();
  });

  it('认证失败时单独标出「握手通、认证不通」', async () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    sshSrv.open.mockRejectedValue(new RemoteError('AUTH_FAILED', '认证失败'));
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ok).toBe(false);
    expect(result.stages.map((stage) => [stage.name, stage.ok])).toEqual([
      ['网络可达', true],
      ['握手', true],
      ['认证', false],
    ]);
  });

  it('指纹不一致时标出主机身份异常，并同时给出新旧指纹', async () => {
    /** 旧指纹 */
    const oldFingerprint = fingerprintOf(Buffer.from('old-key'));
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf({ ...ROW, fingerprint: oldFingerprint });
    sshSrv.open.mockImplementation(async (config: SshConfig) => {
      if (!config.hostVerifier(Buffer.from('new-key'))) {
        throw new RemoteError('HOST_KEY_CHANGED', '主机公钥不一致');
      }
      return {} as never;
    });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ok).toBe(false);
    expect(result.fingerprint).toBe(oldFingerprint);
    expect(result.currentFingerprint).toBe(fingerprintOf(Buffer.from('new-key')));
    expect(result.stages.at(-1)).toMatchObject({ name: '主机身份', ok: false });
  });

  it('命令执行失败不影响「身份已确认」，只是那一段标红', async () => {
    /** 被测服务与替身 */
    const { service, sshSrv } = serviceOf();
    sshSrv.open.mockImplementation(async (config: SshConfig) => {
      config.hostVerifier(Buffer.from('host-key'));
      return {} as never;
    });
    sshSrv.exec.mockRejectedValue(new Error('channel closed'));
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ok).toBe(false);
    expect(result.stages.find((stage) => stage.name === '命令执行')?.ok).toBe(false);
    expect(result.stages.find((stage) => stage.name === '主机身份')?.ok).toBe(true);
  });

  it('诊断不改指纹（只读诊断不应改变信任状态）', async () => {
    /** 被测服务与替身 */
    const { service, repository, sshSrv } = serviceOf();
    sshSrv.open.mockImplementation(async (config: SshConfig) => {
      config.hostVerifier(Buffer.from('host-key'));
      return {} as never;
    });
    await service.diagnose(1);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('root 登录与非默认端口给出风险提示', async () => {
    /** 被测服务 */
    const { service, sshSrv } = serviceOf({
      ...ROW,
      username: 'root',
      port: 2222,
      fingerprint: fingerprintOf(Buffer.from('host-key')),
    });
    sshSrv.open.mockImplementation(async (config: SshConfig) => {
      config.hostVerifier(Buffer.from('host-key'));
      return {} as never;
    });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.warnings.join()).toContain('root');
    expect(result.warnings.join()).toContain('2222');
  });

  it('主机不存在时诊断 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    await expect(service.diagnose(9)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rememberFingerprint 走正常更新（会进变更历史）', async () => {
    /** 被测服务与替身 */
    const { service, repository } = serviceOf();
    /** 指纹 */
    const fingerprint = fingerprintOf(Buffer.from('host-key'));
    await service.rememberFingerprint(1, fingerprint, 7, 9);
    expect(argOf(repository.update, 0, 1)).toMatchObject({ fingerprint });
  });
});
