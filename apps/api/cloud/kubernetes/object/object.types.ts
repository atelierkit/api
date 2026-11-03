/**
 * 集群下可管理的资源类型
 *
 * 注 1：类型会参与路径模板的选择（`KUBERNETES_OBJECT_ACTIONS` 与 `collectionPathOf`），
 * 因此必须用白名单校验，不能放任前端传任意串 —— 本模块**不做任何路径透传**，
 * 新增资源必须在这里显式加一条
 * 注 2：只做「列表 + 删除 / 扩缩容 / 重启 / 节点封锁」，不含 YAML 编辑与任意资源写入
 */
export const KUBERNETES_OBJECT_TYPES = [
  'namespaces',
  'nodes',
  'pods',
  'deployments',
  'statefulsets',
  'services',
] as const;

/** 集群下可管理的资源类型 */
export type KubernetesObjectType = (typeof KUBERNETES_OBJECT_TYPES)[number];

/** 集群级资源（没有命名空间），注：列表路径与动作路径都不带 `namespaces/{ns}` 段 */
const CLUSTER_SCOPED_TYPES: readonly KubernetesObjectType[] = [
  'namespaces',
  'nodes',
];

/**
 * 判断是否为集群级资源
 *
 * @param type 资源类型
 * @returns 集群级时为 true
 */
export function isClusterScoped(type: KubernetesObjectType): boolean {
  return CLUSTER_SCOPED_TYPES.includes(type);
}

/**
 * 资源动作
 *
 * 注：这是**并集**，某个类型具体支持哪些由 `KUBERNETES_OBJECT_ACTIONS` 决定；
 * DTO 用它挡住乱填，服务层再按类型校验一次
 */
export const KUBERNETES_ACTION_NAMES = [
  'remove',
  'scale',
  'restart',
  'cordon',
  'uncordon',
] as const;

/** 资源动作 */
export type KubernetesAction = (typeof KUBERNETES_ACTION_NAMES)[number];

/** 动作附带的参数 */
export interface KubernetesActionValue {
  /** 扩缩容的目标副本数 */
  replicas?: number;
  /**
   * 删除时的优雅退出秒数
   *
   * 注：不传则交给 API Server 用 Pod 自己的 `terminationGracePeriodSeconds`；
   * 传 0 表示立即删除（有状态服务可能会丢数据，前端必须二次确认）
   */
  gracePeriod?: number;
  /** 重启时间戳，注：restart 动作写进 Pod 模板的注解，由服务层生成 */
  restartedAt?: string;
}

/** 动作的映射规则 */
export interface KubernetesActionSpec {
  /** 请求方式 */
  method: 'DELETE' | 'PATCH';
  /**
   * 拼请求路径
   *
   * @param namespace 已归一的具体命名空间（集群级资源为空串）
   * @param name 资源名（未编码，由 `itemPathOf` 统一编码）
   * @param value 动作参数
   * @returns 接口路径
   */
  path: (namespace: string, name: string, value: KubernetesActionValue) => string;
  /**
   * 拼请求正文
   *
   * @param value 动作参数
   * @returns PATCH 的正文，注：DELETE 动作没有正文
   */
  body?: (value: KubernetesActionValue) => unknown;
}

/** 重启动作使用的注解键，注：与 `kubectl rollout restart` 逐字一致，这样两边的行为能对上 */
export const KUBERNETES_RESTART_ANNOTATION =
  'kubectl.kubernetes.io/restartedAt';

/** 副本数上限，注：家用集群不存在上千副本的场景，也防止前端传个巨大的值把调度器压垮 */
const MAX_REPLICAS = 1000;

/** 优雅退出秒数上限，注：Kubernetes 的默认值是 30，600 已足够覆盖有状态服务 */
const MAX_GRACE_SECONDS = 600;

/**
 * 副本数归一
 *
 * @param replicas 前端提交的副本数
 * @returns 0 ~ 1000 的整数，缺省 0
 */
export function replicasOf(replicas: number | undefined): number {
  if (replicas === undefined || !Number.isFinite(replicas)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_REPLICAS, Math.floor(replicas)));
}

/**
 * 优雅退出秒数归一
 *
 * @param seconds 前端提交的秒数
 * @returns 0 ~ 600 的整数，缺省 0
 */
export function graceSecondsOf(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_GRACE_SECONDS, Math.floor(seconds)));
}

/** 核心组前缀 */
const CORE_PREFIX = '/api/v1';

/** apps 组前缀，注：Deployment / StatefulSet 都在这个组里 */
const APPS_PREFIX = '/apis/apps/v1';

/**
 * 命名空间路径段
 *
 * @param namespace 命名空间，空串表示「全部命名空间」
 * @returns 路径段，如 `/namespaces/default`
 */
function namespaceSegmentOf(namespace: string): string {
  return namespace === '' ? '' : `/namespaces/${encodeURIComponent(namespace)}`;
}

/**
 * 资源集合路径
 *
 * 注：命名空间为空串时给的是**集群级**列表路径（如 `/api/v1/pods`），
 * 这是「全部命名空间」语义，与单条资源的路径不是一回事
 *
 * @param type 资源类型
 * @param namespace 命名空间，注：集群级资源忽略该参数
 * @returns 集合路径
 */
export function collectionPathOf(
  type: KubernetesObjectType,
  namespace = '',
): string {
  switch (type) {
    case 'namespaces':
      return `${CORE_PREFIX}/namespaces`;
    case 'nodes':
      return `${CORE_PREFIX}/nodes`;
    case 'pods':
      return `${CORE_PREFIX}${namespaceSegmentOf(namespace)}/pods`;
    case 'services':
      return `${CORE_PREFIX}${namespaceSegmentOf(namespace)}/services`;
    case 'deployments':
      return `${APPS_PREFIX}${namespaceSegmentOf(namespace)}/deployments`;
    case 'statefulsets':
      return `${APPS_PREFIX}${namespaceSegmentOf(namespace)}/statefulsets`;
    default:
      // 注：类型已由 DTO 白名单挡过，这里只是防止将来新增类型时静默拼出坏路径
      throw new Error(`不支持的资源类型：${String(type)}`);
  }
}

/**
 * 单条资源路径
 *
 * @param type 资源类型
 * @param namespace 具体的命名空间，集群级资源传空串
 * @param name 资源名
 * @returns 资源路径
 */
export function itemPathOf(
  type: KubernetesObjectType,
  namespace: string,
  name: string,
): string {
  return `${collectionPathOf(type, namespace)}/${encodeURIComponent(name)}`;
}

/**
 * 归一动作要用的命名空间
 *
 * 注：列表页可以「全部命名空间」，但删除 / 扩缩容必须落到一个具体命名空间 ——
 * 缺省用集群配置里的默认命名空间，仍为空时退回 `default`
 *
 * @param type 资源类型
 * @param given 前端提交的命名空间
 * @param fallback 集群配置的默认命名空间
 * @returns 具体命名空间，集群级资源为 `''`
 */
export function namespaceOf(
  type: KubernetesObjectType,
  given: string | undefined,
  fallback: string | undefined,
): string {
  if (isClusterScoped(type)) {
    return '';
  }
  /** 提交值 */
  const value = (given ?? '').trim();
  if (value !== '') {
    return value;
  }
  /** 配置值 */
  const config = (fallback ?? '').trim();
  return config === '' ? 'default' : config;
}

/**
 * 动作 → 方法与路径
 *
 * 注：路径模板写死在这里，是「不做透传」这条约束的落地点 —— 新增能力必须显式加一条，
 * 而不是把前端的参数拼进路径
 */
export const KUBERNETES_OBJECT_ACTIONS: Record<
  KubernetesObjectType,
  Partial<Record<KubernetesAction, KubernetesActionSpec>>
> = {
  namespaces: {
    remove: {
      method: 'DELETE',
      path: (_namespace, name) => itemPathOf('namespaces', '', name),
    },
  },
  nodes: {
    cordon: {
      method: 'PATCH',
      path: (_namespace, name) => itemPathOf('nodes', '', name),
      body: () => ({ spec: { unschedulable: true } }),
    },
    uncordon: {
      method: 'PATCH',
      path: (_namespace, name) => itemPathOf('nodes', '', name),
      body: () => ({ spec: { unschedulable: false } }),
    },
  },
  pods: {
    remove: {
      method: 'DELETE',
      path: (namespace, name, value) => {
        /** 单条路径 */
        const base = itemPathOf('pods', namespace, name);
        // 注：不传就不带查询串 —— 由 API Server 用 Pod 自己的优雅退出时间
        return value.gracePeriod === undefined
          ? base
          : `${base}?gracePeriodSeconds=${graceSecondsOf(value.gracePeriod)}`;
      },
    },
  },
  deployments: {
    restart: {
      method: 'PATCH',
      path: (namespace, name) => itemPathOf('deployments', namespace, name),
      body: (value) => ({
        spec: {
          template: {
            metadata: {
              annotations: {
                [KUBERNETES_RESTART_ANNOTATION]: value.restartedAt ?? '',
              },
            },
          },
        },
      }),
    },
    scale: {
      method: 'PATCH',
      path: (namespace, name) =>
        `${itemPathOf('deployments', namespace, name)}/scale`,
      body: (value) => ({ spec: { replicas: replicasOf(value.replicas) } }),
    },
    remove: {
      method: 'DELETE',
      path: (namespace, name) => itemPathOf('deployments', namespace, name),
    },
  },
  statefulsets: {
    restart: {
      method: 'PATCH',
      path: (namespace, name) => itemPathOf('statefulsets', namespace, name),
      body: (value) => ({
        spec: {
          template: {
            metadata: {
              annotations: {
                [KUBERNETES_RESTART_ANNOTATION]: value.restartedAt ?? '',
              },
            },
          },
        },
      }),
    },
    scale: {
      method: 'PATCH',
      path: (namespace, name) =>
        `${itemPathOf('statefulsets', namespace, name)}/scale`,
      body: (value) => ({ spec: { replicas: replicasOf(value.replicas) } }),
    },
    remove: {
      method: 'DELETE',
      path: (namespace, name) => itemPathOf('statefulsets', namespace, name),
    },
  },
  services: {
    remove: {
      method: 'DELETE',
      path: (namespace, name) => itemPathOf('services', namespace, name),
    },
  },
};

/** 命名空间列表项 */
export interface KubernetesNamespaceRow {
  /** 名称 */
  name: string;
  /** 阶段，`Active` / `Terminating` */
  phase: string;
  /** 创建时间（ISO 字符串） */
  created: string;
}

/** 节点列表项 */
export interface KubernetesNodeRow {
  /** 名称 */
  name: string;
  /** 状态，`Ready` / `NotReady` / `SchedulingDisabled` / `Unknown` */
  status: string;
  /** 角色，如 `control-plane,master`，注：没有角色标签的节点为空串 */
  roles: string;
  /** kubelet 版本 */
  version: string;
  /** 可分配 CPU（核） */
  cpu: number;
  /** 可分配内存（字节） */
  memory: number;
  /** 可分配 Pod 数 */
  pods: number;
  /** 内网地址 */
  ip: string;
  /** 创建时间 */
  created: string;
}

/** Pod 列表项 */
export interface KubernetesPodRow {
  /** 名称 */
  name: string;
  /** 命名空间 */
  namespace: string;
  /** 就绪容器数，如 `1/1` */
  ready: string;
  /** 状态，注：容器在 CrashLoopBackOff 时显示的是那个原因而不是 `Running` */
  status: string;
  /** 重启次数合计 */
  restarts: number;
  /** 所在节点 */
  node: string;
  /** 镜像（多个以 `, ` 连接，已去重） */
  images: string;
  /** Pod IP */
  ip: string;
  /** 创建时间 */
  created: string;
}

/** 工作负载列表项（Deployment / StatefulSet 同形） */
export interface KubernetesWorkloadRow {
  /** 名称 */
  name: string;
  /** 命名空间 */
  namespace: string;
  /** 就绪副本数，如 `2/3` */
  ready: string;
  /** 期望副本数 */
  replicas: number;
  /** 已更新副本数 */
  updated: number;
  /** 可用副本数 */
  available: number;
  /** 镜像 */
  images: string;
  /** 创建时间 */
  created: string;
}

/** Service 列表项 */
export interface KubernetesServiceRow {
  /** 名称 */
  name: string;
  /** 命名空间 */
  namespace: string;
  /** 类型，`ClusterIP` / `NodePort` / `LoadBalancer` / `ExternalName` */
  type: string;
  /** 集群内 IP */
  clusterIP: string;
  /** 端口文本，如 `80/TCP, 443/TCP→30443` */
  ports: string;
  /** 选择器文本，如 `app=web` */
  selector: string;
  /** 创建时间 */
  created: string;
}
