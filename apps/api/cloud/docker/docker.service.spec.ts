// 外部依赖
import {
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { encryptSecret } from '../../shared/common/secret.util.js';
import { missingSelectPathsOf } from '../../shared/common/select.fixture.js';
import { OperateService } from '../../shared/operate/operate.service.js';
import { QueueService } from '../../shared/queue/queue.service.js';
import { CLIENT_CERT, CLIENT_KEY, OTHER_CERT, OTHER_KEY } from './docker.cert.fixture.js';
import type { DockerCreateDto, DockerUpdateDto } from './docker.dto.js';
import { DockerEntity, DockerLogEntity } from './docker.entity.js';
import { dockerRequest } from './docker.request.js';
import { DOCKER_KEY_MASK, DockerService } from './docker.service.js';

// 注：请求层整体替身，只保留 `dockerTargetOf` / `parseEndpoint` 等纯函数；
// 真实的网络行为由 `docker.request.spec.ts` 用本地假 daemon 覆盖
vi.mock('./docker.request.js', async (importOriginal) => {
  /** 原实现 */
  const actual =
    await importOriginal<typeof import('./docker.request.js')>();
  return { ...actual, dockerRequest: vi.fn() };
});

/** 请求替身 */
const requestMock = vi.mocked(dockerRequest);

/** 测试用的加解密口令 */
const SETTING_KEY = 'unit-test-setting-key';

/** 明文连接的宿主机记录 */
const PLAIN_ROW = {
  id: 1,
  name: '家用宿主机',
  description: '局域网',
  endpoint: 'http://127.0.0.1:2375',
  tls: false,
  ca: '',
  cert: '',
  key: '',
  verify: true,
  apiVersion: '1.47',
  status: true,
  update: {},
};

/**
 * 组装被测服务
 *
 * @param row 记录查询结果
 * @returns 被测服务与全部替身
 */
function serviceOf(row: unknown = PLAIN_ROW) {
  /** 操作序号服务替身 */
  const operateSrv = { create: vi.fn(async () => 7) };
  /** 队列服务替身 */
  const queueSrv = { addTask: vi.fn(() => 0) };
  /** 宿主机存储器替身 */
  const repository = {
    find: vi.fn(async () => [row] as unknown[]),
    findOne: vi.fn(async () => row as unknown),
    existsBy: vi.fn(async () => true),
    insert: vi.fn(async () => ({ identifiers: [{ id: 5 }] })),
    update: vi.fn(async () => ({ affected: 1 })),
    metadata: { tableName: 'dockers', columns: [] as unknown[] },
  };
  /** 日志存储器替身 */
  const logRepository = {
    find: vi.fn(async () => [row] as unknown[]),
    metadata: { tableName: 'dockers_logs', columns: [] as unknown[] },
  };
  return {
    service: new DockerService(
      operateSrv as unknown as OperateService,
      queueSrv as unknown as QueueService,
      repository as unknown as Repository<DockerEntity>,
      logRepository as unknown as Repository<DockerLogEntity>,
    ),
    repository,
    logRepository,
  };
}

/**
 * 取某一层替身的调用参数
 *
 * @param mock 替身方法
 * @param index 第几次调用
 * @returns 入参
 */
function argsOf(mock: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
  return mock.mock.calls[index] ?? [];
}

beforeEach(() => {
  process.env.SETTING_KEY = SETTING_KEY;
  requestMock.mockReset();
});

afterEach(() => {
  delete process.env.SETTING_KEY;
});

describe('DockerService 查询', () => {
  it('清单与详情都不下发私钥，只回 hasKey', async () => {
    /** 带密文的记录 */
    const row = { ...PLAIN_ROW, tls: true, cert: CLIENT_CERT, key: 'enc:v1:aa:bb:cc' };
    /** 被测服务 */
    const { service } = serviceOf(row);
    expect(await service.show(1)).toMatchObject({
      id: 1,
      key: '',
      hasKey: true,
    });
    expect((await service.index())[0]).toMatchObject({ key: '', hasKey: true });
    expect((await service.log(1))[0]).toMatchObject({ key: '', hasKey: true });
  });

  it('没有私钥时 hasKey 为 false', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    expect(await service.show(1)).toMatchObject({ hasKey: false });
  });

  it('记录不存在时详情返回 null', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    expect(await service.show(9)).toBeNull();
  });
});

// 注：`find` 的替身不核对 `select`，属性名写错时单测照样绿、真机才抛
// `EntityPropertyNotFoundError`（2026-11-05 变更历史接口就这么红过一次），故这里按实体元数据反过来校验
describe('DockerService 可见列', () => {
  it('主表查询的字段都在主表实体上', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.show(1);
    /** 查询选项 */
    const options = argsOf(repository.findOne)[0] as { select?: unknown };
    expect(missingSelectPathsOf(options.select, DockerEntity)).toEqual([]);
  });

  it('变更历史只取日志表上存在的列（日志表没有 create）', async () => {
    /** 被测服务 */
    const { service, logRepository } = serviceOf();
    await service.log(1);
    /** 查询选项 */
    const options = argsOf(logRepository.find)[0] as { select?: unknown };
    expect(missingSelectPathsOf(options.select, DockerLogEntity)).toEqual([]);
    expect(options.select).not.toHaveProperty('create');
  });
});

describe('DockerService 创建', () => {
  it('明文连接未确认时拒绝保存', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 明文建站入参 */
    const value = {
      name: 'a',
      description: 'b',
      endpoint: 'http://127.0.0.1:2375',
      tls: false,
      verify: true,
      status: true,
    } as DockerCreateDto;
    await expect(service.create(value)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('显式确认后允许明文，且确认标记不落库', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    /** 明文建站入参 */
    const value = {
      name: 'a',
      description: 'b',
      endpoint: 'http://127.0.0.1:2375',
      tls: false,
      verify: true,
      status: true,
      allowInsecure: true,
    } as DockerCreateDto;
    expect(await service.create(value, 1, 2)).toBe(5);
    /** 落库内容 */
    const entity = argsOf(repository.insert)[0] as Record<string, unknown>;
    expect(entity).toMatchObject({
      endpoint: 'http://127.0.0.1:2375',
      tls: false,
      ca: '',
      cert: '',
      key: '',
    });
    expect(entity).not.toHaveProperty('allowInsecure');
  });

  it('启用 TLS 时私钥加密落库，证书原样保存', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    /** TLS 建站入参 */
    const value = {
      name: 'a',
      description: 'b',
      endpoint: 'tcp://192.168.1.3:2376',
      tls: true,
      ca: OTHER_CERT,
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      verify: true,
      status: true,
    } as DockerCreateDto;
    await service.create(value);
    /** 落库内容 */
    const entity = argsOf(repository.insert)[0] as Record<string, unknown>;
    expect(entity['ca']).toBe(OTHER_CERT);
    expect(entity['cert']).toBe(CLIENT_CERT);
    expect(String(entity['key'])).toMatch(/^enc:v1:/);
    expect(String(entity['key'])).not.toContain('PRIVATE KEY-----');
  });

  it('未配置 SETTING_KEY 时直接报错，不存明文私钥', async () => {
    delete process.env.SETTING_KEY;
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(
      service.create({
        name: 'a',
        description: 'b',
        endpoint: 'tcp://192.168.1.3:2376',
        tls: true,
        cert: CLIENT_CERT,
        key: CLIENT_KEY,
        verify: true,
        status: true,
      } as DockerCreateDto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('证书与私钥不匹配时保存即拒绝（不必等到连一次才报错）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 抛出的异常 */
    const err = await service
      .create({
        name: 'a',
        description: 'b',
        endpoint: 'tcp://192.168.1.3:2376',
        tls: true,
        cert: CLIENT_CERT,
        key: OTHER_KEY,
        verify: true,
        status: true,
      } as DockerCreateDto)
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('不匹配');
  });

  it('证书框里拼了 CA 时保存即拒绝', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 抛出的异常 */
    const err = await service
      .create({
        name: 'a',
        description: 'b',
        endpoint: 'tcp://192.168.1.3:2376',
        tls: true,
        cert: `${OTHER_CERT}\n${CLIENT_CERT}`,
        key: CLIENT_KEY,
        verify: true,
        status: true,
      } as DockerCreateDto)
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('只能放客户端证书本身');
  });
});

describe('DockerService 更新', () => {
  it('记录不存在时报 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    await expect(
      service.update(9, { description: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('只改说明时不动证书，也不重新校验明文', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.update(1, { description: '新说明' });
    /** 更新内容 */
    const patch = argsOf(repository.update)[1] as Record<string, unknown>;
    expect(patch).toMatchObject({ description: '新说明' });
    expect(patch).not.toHaveProperty('ca');
    expect(patch).not.toHaveProperty('key');
  });

  it('私钥提交空串或占位符都表示「不修改」', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.update(1, { key: '' });
    await service.update(1, { key: DOCKER_KEY_MASK });
    for (const call of repository.update.mock.calls) {
      expect(call[1]).not.toHaveProperty('key');
    }
  });

  it('提交新私钥时加密写入', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({
      ...PLAIN_ROW,
      tls: true,
      cert: CLIENT_CERT,
      key: 'enc:v1:old',
    });
    await service.update(1, { key: CLIENT_KEY });
    /** 更新内容 */
    const patch = argsOf(repository.update)[1] as Record<string, unknown>;
    expect(String(patch['key'])).toMatch(/^enc:v1:/);
    expect(String(patch['key'])).not.toContain('PRIVATE KEY-----');
  });

  it('关掉 TLS 时连带清空证书三件套', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({
      ...PLAIN_ROW,
      tls: true,
      ca: OTHER_CERT,
      cert: CLIENT_CERT,
      key: 'enc:v1:aa',
    });
    await service.update(1, { tls: false, allowInsecure: true });
    /** 更新内容 */
    const patch = argsOf(repository.update)[1] as Record<string, unknown>;
    expect(patch).toMatchObject({ tls: false, ca: '', cert: '', key: '' });
  });

  it('把地址改成明文但没确认时拒绝', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'tcp://192.168.1.3:2376',
      tls: true,
      cert: CLIENT_CERT,
      key: 'enc:v1:aa',
    });
    await expect(
      service.update(1, { endpoint: 'http://192.168.1.3:2375' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('从明文改成 TLS 但没给证书时拒绝（DTO 的联动校验只管创建）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(service.update(1, { tls: true })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('从明文改成 TLS 且给了证书时通过', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.update(1, {
      endpoint: 'tcp://192.168.1.3:2376',
      tls: true,
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
    } as DockerUpdateDto);
    /** 更新内容 */
    const patch = argsOf(repository.update)[1] as Record<string, unknown>;
    expect(patch).toMatchObject({ tls: true, cert: CLIENT_CERT });
    expect(String(patch['key'])).toMatch(/^enc:v1:/);
  });
});

describe('DockerService 连接参数', () => {
  it('宿主机不存在时报 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    await expect(service.target(9)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('解密私钥后交给请求层', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'tcp://192.168.1.3:2376',
      tls: true,
      cert: CLIENT_CERT,
      key: encryptSecret('PRIVATE-PEM', SETTING_KEY),
    });
    /** 连接参数 */
    const target = await service.target(1);
    expect(target.protocol).toBe('https');
    expect(target.cert).toBe(CLIENT_CERT);
    expect(target.key).toBe('PRIVATE-PEM');
  });

  it('私钥解不开时给可读错误（换过 SETTING_KEY 的典型场景）', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      tls: true,
      cert: CLIENT_CERT,
      key: encryptSecret('PRIVATE-PEM', 'another-key'),
    });
    /** 抛出的异常 */
    const err = await service.target(1).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('重新录入私钥');
  });

  it('未配置 SETTING_KEY 且有密文时直接 500', async () => {
    delete process.env.SETTING_KEY;
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      tls: true,
      cert: CLIENT_CERT,
      key: 'enc:v1:aa:bb:cc',
    });
    await expect(service.target(1)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('未配置 API 版本时探测一次并缓存（不重复打扰 daemon）', async () => {
    requestMock.mockResolvedValue({ ApiVersion: '1.47' });
    /** 被测服务 */
    const { service } = serviceOf({ ...PLAIN_ROW, apiVersion: '' });
    expect((await service.target(1)).apiVersion).toBe('1.47');
    expect((await service.target(1)).apiVersion).toBe('1.47');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(argsOf(requestMock)[1]).toBe('/version');
  });

  it('探测不到版本时不写缓存，退回无前缀请求', async () => {
    requestMock.mockResolvedValue({});
    /** 被测服务 */
    const { service } = serviceOf({ ...PLAIN_ROW, apiVersion: '' });
    expect((await service.target(1)).apiVersion).toBe('');
    await service.target(1);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});

describe('DockerService 概览与诊断', () => {
  it('概览合并 /version 与 /info，缺字段时给空值', async () => {
    requestMock.mockImplementation(async (_target, path) =>
      path === '/version'
        ? {
            Version: '27.3.1',
            ApiVersion: '1.47',
            Os: 'linux',
            Arch: 'amd64',
            KernelVersion: '6.1.0',
          }
        : {
            Name: 'home-server',
            Containers: 3,
            ContainersRunning: 2,
            ContainersPaused: 0,
            ContainersStopped: 1,
            Images: 8,
            NCPU: 4,
            MemTotal: 8589934592,
            Driver: 'overlay2',
            DockerRootDir: '/var/lib/docker',
            DefaultRuntime: 'runc',
            Swarm: { LocalNodeState: 'inactive' },
          },
    );
    /** 被测服务 */
    const { service } = serviceOf();
    expect(await service.summary(1)).toEqual({
      version: '27.3.1',
      apiVersion: '1.47',
      os: 'linux',
      arch: 'amd64',
      kernelVersion: '6.1.0',
      name: 'home-server',
      containers: 3,
      containersRunning: 2,
      containersPaused: 0,
      containersStopped: 1,
      images: 8,
      cpus: 4,
      memoryTotal: 8589934592,
      driver: 'overlay2',
      dockerRootDir: '/var/lib/docker',
      defaultRuntime: 'runc',
      swarmActive: false,
    });
  });

  it('daemon 返回空对象时概览全是空值（不抛错）', async () => {
    requestMock.mockResolvedValue({});
    /** 被测服务 */
    const { service } = serviceOf();
    expect(await service.summary(1)).toMatchObject({
      version: '',
      containers: 0,
      memoryTotal: 0,
      swarmActive: false,
    });
  });

  it('诊断给出 ping 延迟与明文连接的警告', async () => {
    requestMock.mockImplementation(async (_target, path) => {
      if (path === '/_ping') {
        return 'OK\n';
      }
      return { Version: '27.3.1', ApiVersion: '1.47' };
    });
    /** 被测服务 */
    const { service } = serviceOf();
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ping).toBe('OK');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.protocol).toBe('http');
    expect(result.tls).toBe(false);
    expect(result.warnings.join()).toContain('明文连接');
  });

  it('关闭证书校验、API 版本不一致都会被点名', async () => {
    requestMock.mockImplementation(async (_target, path) =>
      path === '/_ping' ? 'OK' : { Version: '27.3.1', ApiVersion: '1.43' },
    );
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'tcp://192.168.1.3:2376',
      tls: true,
      cert: CLIENT_CERT,
      key: encryptSecret('PRIVATE-PEM', SETTING_KEY),
      verify: false,
      apiVersion: '1.47',
    });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.warnings.join()).toContain('关闭证书校验');
    expect(result.warnings.join()).toContain('不一致');
  });

  it('探测不到 API 版本时提示已退回最低兼容版本', async () => {
    requestMock.mockImplementation(async (_target, path) =>
      path === '/_ping' ? 'OK' : {},
    );
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'tcp://192.168.1.3:2376',
      tls: true,
      cert: CLIENT_CERT,
      key: encryptSecret('PRIVATE-PEM', SETTING_KEY),
      apiVersion: '',
    });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.usedApiVersion).toBe('');
    expect(result.warnings.join()).toContain('最低兼容版本');
  });
});
