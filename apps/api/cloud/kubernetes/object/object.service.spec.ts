// 外部依赖
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { kubernetesRequest } from '../kubernetes.request.js';
import type { KubernetesService } from '../kubernetes.service.js';
import {
  KubernetesObjectService,
  podImagesOf,
  podReadyOf,
  podRestartsOf,
  podStatusOf,
  selectorTextOf,
  servicePortsOf,
  workloadReadyOf,
} from './object.service.js';
import {
  collectionPathOf,
  graceSecondsOf,
  isClusterScoped,
  itemPathOf,
  namespaceOf,
  replicasOf,
} from './object.types.js';

// 注：只替身请求函数，类型与常量走原实现
vi.mock('../kubernetes.request.js', async (importOriginal) => {
  /** 原实现 */
  const actual =
    await importOriginal<typeof import('../kubernetes.request.js')>();
  return { ...actual, kubernetesRequest: vi.fn() };
});

/** 请求替身 */
const requestMock = vi.mocked(kubernetesRequest);

/** 连接参数替身，注：默认命名空间给 kube-system，用来验证动作的命名空间归一 */
const TARGET = {
  protocol: 'https' as const,
  host: '192.168.1.3',
  port: 6443,
  ca: '',
  cert: 'CERT',
  key: 'PRIVATE',
  token: '',
  verify: true,
  namespace: 'kube-system',
};

/**
 * 组装被测服务
 *
 * @returns 被测服务
 */
function serviceOf() {
  /** 集群服务替身 */
  const kubernetesSrv = { target: vi.fn(async (_id: number) => TARGET) };
  return new KubernetesObjectService(
    kubernetesSrv as unknown as KubernetesService,
  );
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('资源路径', () => {
  it('命名空间为空串时给集群级列表路径（全部命名空间）', () => {
    expect(collectionPathOf('pods', '')).toBe('/api/v1/pods');
    expect(collectionPathOf('services', '')).toBe('/api/v1/services');
    expect(collectionPathOf('deployments', '')).toBe('/apis/apps/v1/deployments');
  });

  it('带命名空间时插进 /namespaces/{ns} 段', () => {
    expect(collectionPathOf('pods', 'default')).toBe(
      '/api/v1/namespaces/default/pods',
    );
    expect(collectionPathOf('deployments', 'web')).toBe(
      '/apis/apps/v1/namespaces/web/deployments',
    );
  });

  it('集群级资源忽略命名空间', () => {
    expect(collectionPathOf('nodes', 'default')).toBe('/api/v1/nodes');
    expect(collectionPathOf('namespaces', 'default')).toBe(
      '/api/v1/namespaces',
    );
    expect(isClusterScoped('nodes')).toBe(true);
    expect(isClusterScoped('pods')).toBe(false);
  });

  it('单条资源路径对资源名编码（挡住斜杠与奇怪字符）', () => {
    expect(itemPathOf('pods', 'default', 'web-0')).toBe(
      '/api/v1/namespaces/default/pods/web-0',
    );
    expect(itemPathOf('pods', 'default', 'a/b')).toBe(
      '/api/v1/namespaces/default/pods/a%2Fb',
    );
  });

  it('动作的命名空间归一：提交值优先，其次配置值，最后 default', () => {
    expect(namespaceOf('pods', 'web', 'kube-system')).toBe('web');
    expect(namespaceOf('pods', '', 'kube-system')).toBe('kube-system');
    expect(namespaceOf('pods', '', '')).toBe('default');
    expect(namespaceOf('nodes', 'web', 'kube-system')).toBe('');
  });

  it('副本数与优雅退出秒数会被夹到合法区间', () => {
    expect(replicasOf(3)).toBe(3);
    expect(replicasOf(-1)).toBe(0);
    expect(replicasOf(9999)).toBe(1000);
    expect(replicasOf(2.7)).toBe(2);
    expect(replicasOf(undefined)).toBe(0);
    expect(graceSecondsOf(30)).toBe(30);
    expect(graceSecondsOf(-5)).toBe(0);
    expect(graceSecondsOf(9999)).toBe(600);
  });
});

describe('列表投影的纯函数', () => {
  it('就绪容器数与重启次数', () => {
    /** Pod 对象 */
    const pod = {
      spec: { containers: [{}, {}] },
      status: {
        containerStatuses: [
          { ready: true, restartCount: 2 },
          { ready: false, restartCount: 1 },
        ],
      },
    };
    expect(podReadyOf(pod)).toBe('1/2');
    expect(podRestartsOf(pod)).toBe(3);
    expect(podReadyOf({})).toBe('0/0');
    expect(podRestartsOf({})).toBe(0);
  });

  it('等待中的原因优先于阶段（CrashLoopBackOff 不能被 Running 盖掉）', () => {
    expect(
      podStatusOf({
        status: {
          phase: 'Running',
          containerStatuses: [
            { state: { waiting: { reason: 'CrashLoopBackOff' } } },
          ],
        },
      }),
    ).toBe('CrashLoopBackOff');
  });

  it('终止原因给中文之外的原样值，Completed 不算异常', () => {
    expect(
      podStatusOf({
        status: {
          phase: 'Failed',
          containerStatuses: [{ state: { terminated: { reason: 'OOMKilled' } } }],
        },
      }),
    ).toBe('OOMKilled');
    expect(
      podStatusOf({
        status: {
          phase: 'Succeeded',
          containerStatuses: [{ state: { terminated: { reason: 'Completed' } } }],
        },
      }),
    ).toBe('Succeeded');
  });

  it('没有任何容器状态时退回阶段', () => {
    expect(podStatusOf({ status: { phase: 'Pending' } })).toBe('Pending');
    expect(podStatusOf({})).toBe('');
  });

  it('镜像去重后以逗号连接', () => {
    expect(
      podImagesOf({
        spec: {
          containers: [{ image: 'nginx:1.25' }, { image: 'nginx:1.25' }, {}],
        },
      }),
    ).toBe('nginx:1.25');
    expect(podImagesOf({})).toBe('');
  });

  it('工作负载就绪数给 `就绪/期望`，缺省副本数按 0', () => {
    expect(
      workloadReadyOf({ spec: { replicas: 3 }, status: { readyReplicas: 2 } }),
    ).toBe('2/3');
    expect(workloadReadyOf({})).toBe('0/0');
  });

  it('Service 端口带 NodePort 时用箭头标出，选择器按键排序', () => {
    expect(
      servicePortsOf([
        { port: 80, protocol: 'TCP' },
        { port: 443, protocol: 'TCP', nodePort: 30443 },
      ]),
    ).toBe('80/TCP, 443/TCP→30443');
    expect(servicePortsOf(null)).toBe('');
    expect(servicePortsOf([{}])).toBe('');
    expect(selectorTextOf({ tier: 'front', app: 'web' })).toBe(
      'app=web,tier=front',
    );
    expect(selectorTextOf(null)).toBe('');
  });
});

describe('KubernetesObjectService.index', () => {
  it('Pod 清单带命名空间时走命名空间路径，并做投影', async () => {
    requestMock.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'web-0',
            namespace: 'default',
            creationTimestamp: '2026-11-03T00:00:00Z',
          },
          spec: { nodeName: 'node-1', containers: [{ image: 'nginx:1.25' }] },
          status: {
            phase: 'Running',
            podIP: '10.42.0.7',
            containerStatuses: [{ ready: true, restartCount: 0 }],
          },
        },
      ],
    });
    /** 清单 */
    const rows = await serviceOf().index(1, 'pods', 'default');
    expect(rows).toEqual([
      {
        name: 'web-0',
        namespace: 'default',
        ready: '1/1',
        status: 'Running',
        restarts: 0,
        node: 'node-1',
        images: 'nginx:1.25',
        ip: '10.42.0.7',
        created: '2026-11-03T00:00:00Z',
      },
    ]);
    expect(requestMock.mock.calls[0][1]).toBe(
      '/api/v1/namespaces/default/pods',
    );
  });

  it('不带命名空间时走集群级路径（全部命名空间）', async () => {
    requestMock.mockResolvedValue({ items: [] });
    await serviceOf().index(1, 'pods', '');
    expect(requestMock.mock.calls[0][1]).toBe('/api/v1/pods');
  });

  it('节点清单带状态、角色、容量与内网地址', async () => {
    requestMock.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'home-server',
            creationTimestamp: '2026-10-01T00:00:00Z',
            labels: { 'node-role.kubernetes.io/control-plane': '' },
          },
          spec: { unschedulable: false },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
            capacity: { cpu: '4', memory: '8Gi', pods: '110' },
            nodeInfo: { kubeletVersion: 'v1.30.4' },
            addresses: [{ type: 'InternalIP', address: '192.168.1.3' }],
          },
        },
      ],
    });
    expect(await serviceOf().index(1, 'nodes')).toEqual([
      {
        name: 'home-server',
        status: 'Ready',
        roles: 'control-plane',
        version: 'v1.30.4',
        cpu: 4,
        memory: 8 * 1024 ** 3,
        pods: 110,
        ip: '192.168.1.3',
        created: '2026-10-01T00:00:00Z',
      },
    ]);
    expect(requestMock.mock.calls[0][1]).toBe('/api/v1/nodes');
  });

  it('命名空间清单只给名称、阶段与创建时间', async () => {
    requestMock.mockResolvedValue({
      items: [
        {
          metadata: { name: 'default', creationTimestamp: '2026-10-01T00:00:00Z' },
          status: { phase: 'Active' },
        },
      ],
    });
    expect(await serviceOf().index(1, 'namespaces')).toEqual([
      { name: 'default', phase: 'Active', created: '2026-10-01T00:00:00Z' },
    ]);
    expect(requestMock.mock.calls[0][1]).toBe('/api/v1/namespaces');
  });

  it('工作负载清单合并容器镜像并去重', async () => {
    requestMock.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'web',
            namespace: 'default',
            creationTimestamp: '2026-11-01T00:00:00Z',
          },
          spec: {
            replicas: 3,
            template: {
              spec: { containers: [{ image: 'nginx:1.25' }, { image: 'nginx:1.25' }] },
            },
          },
          status: { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2 },
        },
      ],
    });
    expect(await serviceOf().index(1, 'deployments', 'default')).toEqual([
      {
        name: 'web',
        namespace: 'default',
        ready: '2/3',
        replicas: 3,
        updated: 3,
        available: 2,
        images: 'nginx:1.25',
        created: '2026-11-01T00:00:00Z',
      },
    ]);
    expect(requestMock.mock.calls[0][1]).toBe(
      '/apis/apps/v1/namespaces/default/deployments',
    );
  });

  it('Service 清单给端口文本与选择器', async () => {
    requestMock.mockResolvedValue({
      items: [
        {
          metadata: { name: 'web', namespace: 'default' },
          spec: {
            type: 'NodePort',
            clusterIP: '10.43.0.1',
            ports: [{ port: 80, protocol: 'TCP', nodePort: 30080 }],
            selector: { app: 'web' },
          },
        },
      ],
    });
    expect(await serviceOf().index(1, 'services', 'default')).toEqual([
      {
        name: 'web',
        namespace: 'default',
        type: 'NodePort',
        clusterIP: '10.43.0.1',
        ports: '80/TCP→30080',
        selector: 'app=web',
        created: '',
      },
    ]);
  });

  it('API Server 返回 null 时清单给空数组（不让表格崩）', async () => {
    requestMock.mockResolvedValue(null);
    expect(await serviceOf().index(1, 'pods')).toEqual([]);
    expect(await serviceOf().index(1, 'nodes')).toEqual([]);
    expect(await serviceOf().index(1, 'services')).toEqual([]);
  });
});

describe('KubernetesObjectService.show', () => {
  it('按「类型 + 具体命名空间 + 资源名」取单条', async () => {
    requestMock.mockResolvedValue({
      metadata: { name: 'web-0', namespace: 'default' },
      spec: { containers: [] },
      status: { phase: 'Running' },
    });
    await serviceOf().show(1, 'pods', 'web-0', 'default');
    expect(requestMock.mock.calls[0][1]).toBe(
      '/api/v1/namespaces/default/pods/web-0',
    );
  });

  it('没给命名空间时用集群配置的默认命名空间', async () => {
    requestMock.mockResolvedValue({ metadata: { name: 'web' } });
    await serviceOf().show(1, 'deployments', 'web');
    expect(requestMock.mock.calls[0][1]).toBe(
      '/apis/apps/v1/namespaces/kube-system/deployments/web',
    );
  });

  it('集群级资源的详情路径不带命名空间', async () => {
    requestMock.mockResolvedValue({ metadata: { name: 'home-server' } });
    await serviceOf().show(1, 'nodes', 'home-server');
    expect(requestMock.mock.calls[0][1]).toBe('/api/v1/nodes/home-server');
  });
});

describe('KubernetesObjectService.action', () => {
  it('删除 Pod 默认不带优雅退出参数（交给 Pod 自己）', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'pods', 'remove', 'web-0', {}, 'default');
    expect(requestMock).toHaveBeenCalledWith(
      TARGET,
      '/api/v1/namespaces/default/pods/web-0',
      { method: 'DELETE' },
    );
  });

  it('指定优雅退出秒数时拼成查询串', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'pods', 'remove', 'web-0', { gracePeriod: 0 }, 'default');
    expect(requestMock.mock.calls[0][1]).toBe(
      '/api/v1/namespaces/default/pods/web-0?gracePeriodSeconds=0',
    );
  });

  it('没给命名空间时用集群配置值（动作不能落到「全部命名空间」）', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'pods', 'remove', 'web-0');
    expect(requestMock.mock.calls[0][1]).toBe(
      '/api/v1/namespaces/kube-system/pods/web-0',
    );
  });

  it('扩缩容走 /scale 子资源，用 merge-patch 声明副本数', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'deployments', 'scale', 'web', { replicas: 3 }, 'default');
    expect(requestMock).toHaveBeenCalledWith(
      TARGET,
      '/apis/apps/v1/namespaces/default/deployments/web/scale',
      {
        method: 'PATCH',
        body: { spec: { replicas: 3 } },
        contentType: 'application/merge-patch+json',
      },
    );
  });

  it('扩缩容没给副本数时直接 400（不能默默缩到 0）', async () => {
    await expect(
      serviceOf().action(1, 'deployments', 'scale', 'web', {}, 'default'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('重启给 Pod 模板打 restartedAt 注解（与 kubectl rollout restart 一致）', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'deployments', 'restart', 'web', {
      restartedAt: '2026-11-03T02:00:00.000Z',
    }, 'default');
    expect(requestMock.mock.calls[0][2]).toEqual({
      method: 'PATCH',
      body: {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': '2026-11-03T02:00:00.000Z',
              },
            },
          },
        },
      },
      contentType: 'application/merge-patch+json',
    });
  });

  it('节点封锁 / 解封切换 unschedulable', async () => {
    requestMock.mockResolvedValue(undefined);
    await serviceOf().action(1, 'nodes', 'cordon', 'home-server');
    await serviceOf().action(1, 'nodes', 'uncordon', 'home-server');
    expect(requestMock.mock.calls[0][1]).toBe('/api/v1/nodes/home-server');
    expect(requestMock.mock.calls[0][2]).toMatchObject({
      body: { spec: { unschedulable: true } },
    });
    expect(requestMock.mock.calls[1][2]).toMatchObject({
      body: { spec: { unschedulable: false } },
    });
  });

  it('类型不支持的动作直接 400（DTO 只校验并集）', async () => {
    await expect(
      serviceOf().action(1, 'services', 'scale', 'web', { replicas: 1 }, 'default'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      serviceOf().action(1, 'namespaces', 'remove', 'default'),
    ).resolves.toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
