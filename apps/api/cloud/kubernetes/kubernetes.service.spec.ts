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
import { OperateService } from '../../shared/operate/operate.service.js';
import { QueueService } from '../../shared/queue/queue.service.js';
import { CLIENT_CERT, CLIENT_KEY, OTHER_KEY } from '../docker/docker.cert.fixture.js';
import type { KubernetesCreateDto, KubernetesUpdateDto } from './kubernetes.dto.js';
import { KubernetesEntity, KubernetesLogEntity } from './kubernetes.entity.js';
import { kubernetesRequest } from './kubernetes.request.js';
import {
  KUBERNETES_SECRET_MASK,
  KubernetesService,
} from './kubernetes.service.js';

// 注：请求层整体替身，只保留纯函数；真实网络行为由 `kubernetes.request.spec.ts`
// 用本地假 API Server 覆盖
vi.mock('./kubernetes.request.js', async (importOriginal) => {
  /** 原实现 */
  const actual =
    await importOriginal<typeof import('./kubernetes.request.js')>();
  return { ...actual, kubernetesRequest: vi.fn() };
});

/** 请求替身 */
const requestMock = vi.mocked(kubernetesRequest);

/** 测试用的加解密口令 */
const SETTING_KEY = 'unit-test-setting-key';

/** 明文连接的集群记录（本机 kubectl proxy），注：token 故意用明文，兼容手工 SQL 导入的形态 */
const PLAIN_ROW = {
  id: 1,
  name: '家用集群',
  description: '局域网 k3s',
  endpoint: 'http://127.0.0.1:8001',
  token: 'plain-token',
  ca: '',
  cert: '',
  key: '',
  verify: true,
  namespace: 'default',
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
  /** 集群存储器替身 */
  const repository = {
    find: vi.fn(async () => [row] as unknown[]),
    findOne: vi.fn(async () => row as unknown),
    existsBy: vi.fn(async () => true),
    insert: vi.fn(async () => ({ identifiers: [{ id: 5 }] })),
    update: vi.fn(async () => ({ affected: 1 })),
    metadata: { tableName: 'kubernetes', columns: [] as unknown[] },
  };
  /** 日志存储器替身 */
  const logRepository = {
    find: vi.fn(async () => [row] as unknown[]),
    metadata: { tableName: 'kubernetes_logs', columns: [] as unknown[] },
  };
  return {
    service: new KubernetesService(
      operateSrv as unknown as OperateService,
      queueSrv as unknown as QueueService,
      repository as unknown as Repository<KubernetesEntity>,
      logRepository as unknown as Repository<KubernetesLogEntity>,
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

describe('KubernetesService 查询', () => {
  it('清单与详情都不下发凭据，只回 hasToken / hasKey', async () => {
    /** 带密文的记录 */
    const row = {
      ...PLAIN_ROW,
      token: 'enc:v1:aa:bb:cc',
      cert: CLIENT_CERT,
      key: 'enc:v1:aa:bb:cc',
    };
    /** 被测服务 */
    const { service } = serviceOf(row);
    expect(await service.show(1)).toMatchObject({
      id: 1,
      token: '',
      key: '',
      hasToken: true,
      hasKey: true,
    });
    expect((await service.index())[0]).toMatchObject({
      token: '',
      key: '',
      hasToken: true,
      hasKey: true,
    });
    expect((await service.log(1))[0]).toMatchObject({ token: '', hasToken: true });
  });

  it('没有凭据时两个标记都为 false', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...PLAIN_ROW, token: '' });
    expect(await service.show(1)).toMatchObject({
      hasToken: false,
      hasKey: false,
    });
  });

  it('记录不存在时详情返回 null', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    expect(await service.show(9)).toBeNull();
  });
});

describe('KubernetesService 创建', () => {
  it('既没 token 也没证书时拒绝保存（匿名连接只会得到 403）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 抛出的异常 */
    const err = await service
      .create({
        name: 'a',
        description: 'b',
        endpoint: 'https://192.168.1.3:6443',
        verify: true,
        status: true,
      } as KubernetesCreateDto)
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('至少需要提供');
  });

  it('只给客户端证书不给私钥时拒绝', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 抛出的异常 */
    const err = await service
      .create({
        name: 'a',
        description: 'b',
        endpoint: 'https://192.168.1.3:6443',
        cert: CLIENT_CERT,
        verify: true,
        status: true,
      } as KubernetesCreateDto)
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('必须同时提供私钥');
  });

  it('明文连接未确认时拒绝保存', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(
      service.create({
        name: 'a',
        description: 'b',
        endpoint: 'http://127.0.0.1:8001',
        token: 'TOKEN',
        verify: true,
        status: true,
      } as KubernetesCreateDto),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('显式确认后允许明文，且确认标记不落库', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    expect(
      await service.create(
        {
          name: 'a',
          description: 'b',
          endpoint: 'http://127.0.0.1:8001',
          token: 'TOKEN',
          verify: true,
          status: true,
          allowInsecure: true,
        } as KubernetesCreateDto,
        1,
        2,
      ),
    ).toBe(5);
    /** 落库内容 */
    const entity = argsOf(repository.insert)[0] as Record<string, unknown>;
    expect(entity).not.toHaveProperty('allowInsecure');
    expect(entity['namespace']).toBe('default');
  });

  it('Token 加密落库、首尾空白被去掉', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.create({
      name: 'a',
      description: 'b',
      endpoint: 'https://192.168.1.3:6443',
      token: '  my-token\n',
      verify: true,
      status: true,
    } as KubernetesCreateDto);
    /** 落库内容 */
    const entity = argsOf(repository.insert)[0] as Record<string, unknown>;
    expect(String(entity['token'])).toMatch(/^enc:v1:/);
    expect(String(entity['token'])).not.toContain('my-token');
  });

  it('客户端证书与私钥一起保存时校验配对，私钥加密', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.create({
      name: 'a',
      description: 'b',
      endpoint: 'https://192.168.1.3:6443',
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      verify: true,
      status: true,
      namespace: 'kube-system',
    } as KubernetesCreateDto);
    /** 落库内容 */
    const entity = argsOf(repository.insert)[0] as Record<string, unknown>;
    expect(entity['cert']).toBe(CLIENT_CERT);
    expect(String(entity['key'])).toMatch(/^enc:v1:/);
    expect(entity['namespace']).toBe('kube-system');
  });

  it('证书与私钥不匹配时保存即拒绝（不必等到连一次才报错）', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 抛出的异常 */
    const err = await service
      .create({
        name: 'a',
        description: 'b',
        endpoint: 'https://192.168.1.3:6443',
        cert: CLIENT_CERT,
        key: OTHER_KEY,
        verify: true,
        status: true,
      } as KubernetesCreateDto)
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('不匹配');
  });

  it('未配置 SETTING_KEY 时直接报错，不存明文凭据', async () => {
    delete process.env.SETTING_KEY;
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(
      service.create({
        name: 'a',
        description: 'b',
        endpoint: 'https://192.168.1.3:6443',
        token: 'TOKEN',
        verify: true,
        status: true,
      } as KubernetesCreateDto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('KubernetesService 更新', () => {
  it('记录不存在时报 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    await expect(
      service.update(9, { description: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('只改说明时不动凭据，也不重新校验明文', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.update(1, { description: '新说明' });
    /** 更新内容 */
    const patch = argsOf(repository.update)[1] as Record<string, unknown>;
    expect(patch).toMatchObject({ description: '新说明' });
    expect(patch).not.toHaveProperty('token');
    expect(patch).not.toHaveProperty('key');
  });

  it('Token 提交空串或占位符都表示「不修改」', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.update(1, { token: '' });
    await service.update(1, { token: KUBERNETES_SECRET_MASK });
    for (const call of repository.update.mock.calls) {
      expect(call[1]).not.toHaveProperty('token');
    }
  });

  it('提交新 Token 时加密写入', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf();
    await service.update(1, { token: 'new-token' });
    /** 更新内容 */
    const patch = argsOf(repository.update)[1] as Record<string, unknown>;
    expect(String(patch['token'])).toMatch(/^enc:v1:/);
    expect(String(patch['token'])).not.toContain('new-token');
  });

  it('把地址改成明文但没确认时拒绝', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'https://192.168.1.3:6443',
      token: 'enc:v1:aa',
    });
    await expect(
      service.update(1, { endpoint: 'http://192.168.1.3:8001' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('清空 Token 时显式开关生效（从 Token 切到客户端证书必须能清掉旧 Token）', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({
      ...PLAIN_ROW,
      token: 'enc:v1:aa',
      cert: CLIENT_CERT,
      key: encryptSecret(CLIENT_KEY, SETTING_KEY),
    });
    await service.update(1, { clearToken: true });
    expect(argsOf(repository.update)[1]).toMatchObject({ token: '' });
  });

  it('把唯一凭据清空时拒绝（否则集群会变成匿名连接）', async () => {
    /** 被测服务 */
    const { service } = serviceOf({ ...PLAIN_ROW, token: 'enc:v1:aa' });
    await expect(
      service.update(1, { clearToken: true }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('清空客户端证书时连带清空 CA 与私钥', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({
      ...PLAIN_ROW,
      token: 'enc:v1:aa',
      ca: 'CA',
      cert: CLIENT_CERT,
      key: encryptSecret(CLIENT_KEY, SETTING_KEY),
    });
    await service.update(1, { clearCert: true });
    expect(argsOf(repository.update)[1]).toMatchObject({
      ca: '',
      cert: '',
      key: '',
    });
  });

  it('换证书但私钥对不上时拒绝', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      token: 'enc:v1:aa',
      cert: CLIENT_CERT,
      key: encryptSecret(CLIENT_KEY, SETTING_KEY),
    });
    /** 抛出的异常 */
    const err = await service
      .update(1, { cert: CLIENT_CERT, key: OTHER_KEY })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('不匹配');
  });

  it('只换说明时不校验库里的旧证书（避免旧证书脏了以后改不动）', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({
      ...PLAIN_ROW,
      cert: 'not-a-pem',
      key: encryptSecret(CLIENT_KEY, SETTING_KEY),
    });
    await service.update(1, { description: '新说明' });
    expect(argsOf(repository.update)[1]).toMatchObject({ description: '新说明' });
  });
});

describe('KubernetesService 连接参数', () => {
  it('集群不存在时报 404', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    await expect(service.target(9)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('解密 Token 与私钥后交给请求层', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'https://192.168.1.3:6443',
      token: encryptSecret('SECRET-TOKEN', SETTING_KEY),
      cert: CLIENT_CERT,
      key: encryptSecret(CLIENT_KEY, SETTING_KEY),
      namespace: 'kube-system',
    });
    /** 连接参数 */
    const target = await service.target(1);
    expect(target.protocol).toBe('https');
    expect(target.token).toBe('SECRET-TOKEN');
    expect(target.key).toBe(CLIENT_KEY);
    expect(target.namespace).toBe('kube-system');
  });

  it('凭据解不开时给可读错误（换过 SETTING_KEY 的典型场景）', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'https://192.168.1.3:6443',
      token: encryptSecret('SECRET-TOKEN', 'another-key'),
    });
    /** 抛出的异常 */
    const err = await service.target(1).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain('重新录入');
  });

  it('未配置 SETTING_KEY 且有密文时直接 500', async () => {
    delete process.env.SETTING_KEY;
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'https://192.168.1.3:6443',
      token: 'enc:v1:aa:bb:cc',
    });
    await expect(service.target(1)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('KubernetesService 概览与诊断', () => {
  it('概览合并六次请求，按阶段统计 Pod 并累加节点容量', async () => {
    requestMock.mockImplementation(async (_target, path) => {
      switch (path) {
        case '/version':
          return { gitVersion: 'v1.30.4', platform: 'linux/amd64', goVersion: 'go1.22' };
        case '/api/v1/nodes':
          return {
            items: [
              {
                status: {
                  conditions: [{ type: 'Ready', status: 'True' }],
                  capacity: { cpu: '4', memory: '8Gi', pods: '110' },
                },
              },
              {
                status: {
                  conditions: [{ type: 'Ready', status: 'False' }],
                  capacity: { cpu: '2500m', memory: '4Gi', pods: '110' },
                },
              },
            ],
          };
        case '/api/v1/namespaces':
          return { items: [{}, {}] };
        case '/api/v1/pods':
          return {
            items: [
              { status: { phase: 'Running' } },
              { status: { phase: 'Running' } },
              { status: { phase: 'Pending' } },
              { status: { phase: 'Failed' } },
              { status: { phase: 'Succeeded' } },
            ],
          };
        case '/apis/apps/v1/deployments':
          return { items: [{}] };
        case '/api/v1/services':
          return { items: [{}, {}, {}] };
        default:
          return {};
      }
    });
    /** 被测服务 */
    const { service } = serviceOf();
    const summary = await service.summary(1);
    expect(summary).toMatchObject({
      version: 'v1.30.4',
      platform: 'linux/amd64',
      goVersion: 'go1.22',
      nodes: 2,
      nodesReady: 1,
      namespaces: 2,
      pods: 5,
      podsRunning: 2,
      podsPending: 1,
      podsFailed: 1,
      podsSucceeded: 1,
      deployments: 1,
      services: 3,
      cpuCapacity: 6.5,
      memoryCapacity: 12 * 1024 ** 3,
    });
  });

  it('API Server 返回空对象时概览全是空值（不抛错）', async () => {
    requestMock.mockResolvedValue({});
    /** 被测服务 */
    const { service } = serviceOf();
    expect(await service.summary(1)).toMatchObject({
      version: '',
      nodes: 0,
      nodesReady: 0,
      pods: 0,
      cpuCapacity: 0,
    });
  });

  it('诊断给出 healthz 延迟与明文连接的警告', async () => {
    requestMock.mockImplementation(async (_target, path) =>
      path === '/healthz' ? 'ok\n' : { gitVersion: 'v1.30.4', platform: 'linux/amd64' },
    );
    /** 被测服务 */
    const { service } = serviceOf({ ...PLAIN_ROW, token: encryptSecret('T', SETTING_KEY) });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.ping).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.protocol).toBe('http');
    expect(result.authMode).toBe('token');
    expect(result.warnings.join()).toContain('明文连接');
  });

  it('匿名连接、关闭证书校验、没有默认命名空间都会被点名', async () => {
    requestMock.mockImplementation(async (_target, path) =>
      path === '/healthz' ? 'ok' : { gitVersion: 'v1.30.4' },
    );
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      endpoint: 'https://192.168.1.3:6443',
      token: '',
      verify: false,
      namespace: '',
    });
    /** 诊断结果 */
    const result = await service.diagnose(1);
    expect(result.authMode).toBe('anonymous');
    expect(result.warnings.join()).toContain('未配置 ServiceAccount Token');
    expect(result.warnings.join()).toContain('关闭证书校验');
    expect(result.warnings.join()).toContain('默认命名空间');
  });
});

describe('KubernetesService 视图', () => {
  it('凭据字段被清空，派生标记按实际配置给出', async () => {
    /** 被测服务 */
    const { service } = serviceOf({
      ...PLAIN_ROW,
      token: 'enc:v1:real',
      cert: 'CERT',
      key: 'enc:v1:real',
    });
    /** 详情 */
    const view = await service.show(1);
    expect(view).toMatchObject({
      token: '',
      key: '',
      hasToken: true,
      hasKey: true,
      cert: 'CERT',
    });
  });

  it('更新时允许把命名空间清成空串（退回 default）', async () => {
    /** 被测服务 */
    const { service, repository } = serviceOf({
      ...PLAIN_ROW,
      token: 'enc:v1:aa',
      namespace: 'kube-system',
    });
    await service.update(1, { namespace: '' } as KubernetesUpdateDto);
    expect(argsOf(repository.update)[1]).toMatchObject({ namespace: 'default' });
  });
});
