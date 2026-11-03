// 外部依赖
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { DockerService } from '../docker.service.js';
import { dockerRequest } from '../docker.request.js';
import {
  DockerObjectService,
  networkCountsOf,
  portsTextOf,
  shortIdOf,
} from './object.service.js';
import { waitSecondsOf } from './object.types.js';

// 注：只替身请求函数，类型与常量走原实现
vi.mock('../docker.request.js', async (importOriginal) => {
  /** 原实现 */
  const actual = await importOriginal<typeof import('../docker.request.js')>();
  return { ...actual, dockerRequest: vi.fn() };
});

/** 请求替身 */
const requestMock = vi.mocked(dockerRequest);

/** 连接参数替身 */
const TARGET = {
  protocol: 'https' as const,
  host: '192.168.1.3',
  port: 2376,
  ca: '',
  cert: 'CERT',
  key: 'PRIVATE',
  verify: true,
  apiVersion: '1.47',
};

/**
 * 组装被测服务
 *
 * @returns 被测服务
 */
function serviceOf() {
  /** 宿主机服务替身 */
  const dockerSrv = { target: vi.fn(async (_id: number) => TARGET) };
  return new DockerObjectService(
    dockerSrv as unknown as DockerService,
  );
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('shortIdOf', () => {
  it('去掉 sha256 前缀并截到 12 位', () => {
    expect(shortIdOf('sha256:abcdef0123456789')).toBe('abcdef012345');
    expect(shortIdOf('a1b2c3d4e5f6a7b8')).toBe('a1b2c3d4e5f6');
  });

  it('空值给空串（老 daemon 可能不返回 ID）', () => {
    expect(shortIdOf(undefined)).toBe('');
  });
});

describe('portsTextOf', () => {
  it('已发布端口显示「宿主→容器」，未发布的只显示容器端口', () => {
    expect(
      portsTextOf([
        { PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        { PrivatePort: 53, Type: 'udp' },
      ]),
    ).toBe('8080→80/tcp, 53/udp');
  });

  it('没有端口映射时给空串', () => {
    expect(portsTextOf(undefined)).toBe('');
    expect(portsTextOf([])).toBe('');
  });
});

describe('waitSecondsOf', () => {
  it('缺省 10 秒，负数归 0，超上限归 600，小数向下取整', () => {
    expect(waitSecondsOf(undefined)).toBe(10);
    expect(waitSecondsOf(-5)).toBe(0);
    expect(waitSecondsOf(9999)).toBe(600);
    expect(waitSecondsOf(12.7)).toBe(12);
    expect(waitSecondsOf(Number.NaN)).toBe(10);
  });
});

describe('networkCountsOf', () => {
  it('按网络名累加；一个容器接多个网络时每个网络都记一次', () => {
    /** 统计结果 */
    const counts = networkCountsOf([
      { NetworkSettings: { Networks: { 'main-net': {}, bridge: {} } } },
      { NetworkSettings: { Networks: { bridge: {} } } },
      { NetworkSettings: { Networks: null } },
      {},
    ]);
    expect([...counts]).toEqual([
      ['main-net', 1],
      ['bridge', 2],
    ]);
  });

  it('没有任何网络信息时返回空表', () => {
    expect(networkCountsOf([]).size).toBe(0);
    expect(networkCountsOf([{}]).size).toBe(0);
  });
});

describe('DockerObjectService.index', () => {
  it('容器清单做投影：短 ID、去前导斜杠、端口文本、compose 项目', async () => {
    requestMock.mockResolvedValue([
      {
        Id: 'a1b2c3d4e5f6a7b8',
        Names: ['/web'],
        Image: 'nginx:latest',
        State: 'running',
        Status: 'Up 2 hours',
        Created: 1700000000,
        Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
        Labels: { 'com.docker.compose.project': 'blog', other: 'x' },
      },
    ]);
    /** 清单 */
    const rows = await serviceOf().index(1, 'containers');
    expect(rows).toEqual([
      {
        id: 'a1b2c3d4e5f6',
        name: 'web',
        image: 'nginx:latest',
        state: 'running',
        status: 'Up 2 hours',
        created: 1700000000,
        ports: '8080→80/tcp',
        project: 'blog',
      },
    ]);
    expect(requestMock.mock.calls[0][1]).toBe('/containers/json?all=1');
  });

  it('镜像清单过滤悬空标签并去 sha256 前缀', async () => {
    requestMock.mockResolvedValue([
      {
        Id: 'sha256:abcdef0123456789',
        RepoTags: ['nginx:latest'],
        Size: 100,
        Created: 1700000000,
        Containers: 2,
      },
      {
        Id: 'sha256:fedcba9876543210',
        RepoTags: ['<none>:<none>'],
        Size: 50,
        Created: 1,
        Containers: 0,
      },
    ]);
    /** 清单 */
    const rows = await serviceOf().index(1, 'images');
    expect(rows).toEqual([
      {
        id: 'abcdef012345',
        tags: ['nginx:latest'],
        size: 100,
        created: 1700000000,
        containers: 2,
      },
      {
        id: 'fedcba987654',
        tags: [],
        size: 50,
        created: 1,
        containers: 0,
      },
    ]);
  });

  it('卷清单要拆开 { Volumes } 包装，没有卷时给空数组', async () => {
    requestMock.mockResolvedValue({
      Volumes: [
        {
          Name: 'data',
          Driver: 'local',
          Mountpoint: '/var/lib/docker/volumes/data/_data',
          CreatedAt: '2026-01-01T00:00:00Z',
          Scope: 'local',
        },
      ],
    });
    expect(await serviceOf().index(1, 'volumes')).toEqual([
      {
        name: 'data',
        driver: 'local',
        mountpoint: '/var/lib/docker/volumes/data/_data',
        createdAt: '2026-01-01T00:00:00Z',
        scope: 'local',
      },
    ]);
    requestMock.mockResolvedValue({ Volumes: null });
    expect(await serviceOf().index(1, 'volumes')).toEqual([]);
  });

  it('网络清单的容器数由容器列表反推（列表接口根本没有 Containers 字段）', async () => {
    requestMock.mockImplementation(async (_target, path) => {
      if (path === '/networks') {
        return [
          {
            Id: 'bbbbccccddddeeeeeffff',
            Name: 'main-net',
            Driver: 'bridge',
            Scope: 'local',
            Internal: false,
            Attachable: false,
            Created: '2026-10-27T09:58:32.481086667Z',
          },
          {
            Id: 'ccccddddeeeeffff0000',
            Name: 'bridge',
            Driver: 'bridge',
            Scope: 'local',
            Created: '2026-11-01T23:56:09.07180904Z',
          },
        ];
      }
      return [
        { NetworkSettings: { Networks: { 'main-net': {} } } },
        { NetworkSettings: { Networks: { 'main-net': {} } } },
        { NetworkSettings: { Networks: { 'main-net': {}, bridge: {} } } },
      ];
    });
    expect(await serviceOf().index(1, 'networks')).toEqual([
      {
        id: 'bbbbccccdddd',
        name: 'main-net',
        driver: 'bridge',
        scope: 'local',
        internal: false,
        attachable: false,
        containers: 3,
        created: '2026-10-27T09:58:32.481086667Z',
      },
      {
        id: 'ccccddddeeee',
        name: 'bridge',
        driver: 'bridge',
        scope: 'local',
        internal: false,
        attachable: false,
        containers: 1,
        created: '2026-11-01T23:56:09.07180904Z',
      },
    ]);
    // 注：网络列表之外还要多取一次容器列表，否则拿不到容器归属
    expect(requestMock.mock.calls.map((call) => call[1])).toContain(
      '/containers/json?all=1',
    );
  });

  it('容器列表取不到时退回网络自带的 Containers，不让整张列表失败', async () => {
    requestMock.mockImplementation(async (_target, path) => {
      if (path === '/networks') {
        return [
          {
            Id: 'abcabcabcabc',
            Name: 'main-net',
            Driver: 'bridge',
            // 详情形态才有的字段，列表接口正常不返回
            Containers: { a: {}, b: {} },
          },
        ];
      }
      throw new Error('容器列表挂了');
    });
    /** 清单 */
    const rows = await serviceOf().index(1, 'networks');
    expect(rows).toEqual([
      {
        id: 'abcabcabcabc',
        name: 'main-net',
        driver: 'bridge',
        scope: '',
        internal: false,
        attachable: false,
        containers: 2,
        created: '',
      },
    ]);
  });

  it('daemon 返回 null 时清单给空数组（不让表格崩）', async () => {
    requestMock.mockResolvedValue(null);
    expect(await serviceOf().index(1, 'containers')).toEqual([]);
    expect(await serviceOf().index(1, 'images')).toEqual([]);
    expect(await serviceOf().index(1, 'networks')).toEqual([]);
  });
});

describe('DockerObjectService.show', () => {
  it('容器详情不带环境变量（常见把密码写进 Env）', async () => {
    requestMock.mockResolvedValue({
      Id: 'a1b2c3d4e5f6a7b8',
      Name: '/web',
      Config: { Image: 'nginx', Env: ['DB_PASSWORD=secret'] },
      State: {
        Status: 'running',
        StartedAt: '2026-11-03T00:00:00Z',
        FinishedAt: '0001-01-01T00:00:00Z',
        ExitCode: 0,
      },
      RestartCount: 1,
      Path: 'nginx',
      Args: ['-g', 'daemon off;'],
      Mounts: [{ Source: '/srv', Destination: '/html', Mode: 'rw' }],
      NetworkSettings: { Networks: { bridge: {} } },
    });
    /** 详情 */
    const detail = await serviceOf().show(1, 'containers', 'a1b2c3d4e5f6');
    expect(detail).toEqual({
      id: 'a1b2c3d4e5f6',
      name: 'web',
      image: 'nginx',
      state: 'running',
      startedAt: '2026-11-03T00:00:00Z',
      finishedAt: '0001-01-01T00:00:00Z',
      restartCount: 1,
      command: 'nginx -g daemon off;',
      exitCode: 0,
      mounts: [{ source: '/srv', destination: '/html', mode: 'rw' }],
      networks: ['bridge'],
    });
    expect(detail).not.toHaveProperty('env');
    expect(requestMock.mock.calls[0][1]).toBe('/containers/a1b2c3d4e5f6/json');
  });

  it('镜像详情带架构与入口命令', async () => {
    requestMock.mockResolvedValue({
      Id: 'sha256:abcdef0123456789',
      RepoTags: ['nginx:latest'],
      Size: 100,
      Created: '2026-01-01T00:00:00Z',
      Architecture: 'amd64',
      Os: 'linux',
      Config: { Entrypoint: ['/docker-entrypoint.sh'], Cmd: ['nginx'] },
    });
    expect(await serviceOf().show(1, 'images', 'abcdef012345')).toEqual({
      id: 'abcdef012345',
      tags: ['nginx:latest'],
      size: 100,
      created: '2026-01-01T00:00:00Z',
      architecture: 'amd64',
      os: 'linux',
      entrypoint: ['/docker-entrypoint.sh'],
      command: ['nginx'],
    });
  });

  it('卷与网络的详情路径不带 /json 后缀', async () => {
    requestMock.mockResolvedValue({ Name: 'data', Driver: 'local' });
    await serviceOf().show(1, 'volumes', 'data');
    expect(requestMock.mock.calls[0][1]).toBe('/volumes/data');
    requestMock.mockResolvedValue({ Id: 'abc', Name: 'bridge' });
    await serviceOf().show(1, 'networks', 'abc');
    expect(requestMock.mock.calls[1][1]).toBe('/networks/abc');
  });
});

describe('DockerObjectService.action', () => {
  it('启动容器走 POST，路径由白名单模板给出', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'containers', 'start', 'abc');
    expect(requestMock).toHaveBeenCalledWith(
      TARGET,
      '/containers/abc/start',
      { method: 'POST' },
    );
  });

  it('停止默认等 10 秒，前端可覆盖', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'containers', 'stop', 'abc');
    await serviceOf().action(1, 'containers', 'stop', 'abc', { timeout: 0 });
    expect(requestMock.mock.calls[0][1]).toBe('/containers/abc/stop?t=10');
    expect(requestMock.mock.calls[1][1]).toBe('/containers/abc/stop?t=0');
  });

  it('删除默认不强制，显式确认才带 force=1', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'containers', 'remove', 'abc');
    await serviceOf().action(1, 'containers', 'remove', 'abc', { force: true });
    expect(requestMock.mock.calls[0][1]).toBe(
      '/containers/abc?force=0&v=1',
    );
    expect(requestMock.mock.calls[1][1]).toBe(
      '/containers/abc?force=1&v=1',
    );
    expect(requestMock.mock.calls[1][2]).toEqual({ method: 'DELETE' });
  });

  it('删除镜像走 DELETE', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'images', 'remove', 'abcdef012345');
    expect(requestMock).toHaveBeenCalledWith(
      TARGET,
      '/images/abcdef012345?force=0',
      { method: 'DELETE' },
    );
  });

  it('类型不支持的动作直接 400（DTO 只校验并集）', async () => {
    /** 被测服务 */
    const service = serviceOf();
    await expect(
      service.action(1, 'volumes', 'start', 'data'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.action(1, 'networks', 'remove', 'bridge'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('资源ID会编码后再进路径（tag 里的冒号、digest 里的 @）', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'images', 'remove', 'nginx:latest');
    expect(requestMock.mock.calls[0][1]).toBe(
      '/images/nginx%3Alatest?force=0',
    );
  });
});
