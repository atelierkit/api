/**
 * Kubernetes API 的原始响应与对外视图
 *
 * 注：原始响应只声明本仓库确实用到的字段 —— 集群版本升级时对象会多出大量字段，
 * 逐个建模只会让类型跟着上游跑；对外视图则是后端投影后的扁平结构，字段名转成前端习惯的驼峰
 */

/** 列表响应，注：Kubernetes 的列表恒为 `{ items: [...] }`，无数据时 `items` 为 `[]` */
export interface KubernetesList<T> {
  /** 条目清单 */
  items?: T[] | null;
}

/** 版本信息（`GET /version`） */
export interface KubernetesVersion {
  /** 主版本号，如 `1` */
  major?: string;
  /** 次版本号，如 `30+`（部分发行版带 `+`，原样下发） */
  minor?: string;
  /** Git 版本，如 `v1.30.4` */
  gitVersion?: string;
  /** 构建时间 */
  buildDate?: string;
  /** Go 版本 */
  goVersion?: string;
  /** 平台，如 `linux/amd64` */
  platform?: string;
}

/** 节点对象（只取投影要用的字段） */
export interface KubernetesRawNode {
  /** 元数据 */
  metadata?: {
    /** 名称 */
    name?: string;
    /** 创建时间（RFC3339） */
    creationTimestamp?: string;
    /** 标签，注：`node-role.kubernetes.io/<role>` 的键就是节点角色 */
    labels?: Record<string, string> | null;
  };
  /** 期望状态 */
  spec?: {
    /** 是否禁止调度，注：`kubectl cordon` 就是把它置为 true */
    unschedulable?: boolean;
  };
  /** 实际状态 */
  status?: {
    /** 状态条件，注：`Ready` 那一条的 status 为 `True` 才算就绪 */
    conditions?: Array<{
      /** 条件类型 */
      type?: string;
      /** 条件结果，`True` / `False` / `Unknown` */
      status?: string;
      /** 原因 */
      reason?: string;
    }>;
    /** 可分配资源，注：值是 Kubernetes 的 quantity 字符串（`8`、`16Gi`） */
    capacity?: Record<string, string> | null;
    /** 节点信息 */
    nodeInfo?: {
      /** kubelet 版本 */
      kubeletVersion?: string;
      /** 操作系统镜像 */
      osImage?: string;
      /** 容器运行时 */
      containerRuntimeVersion?: string;
    };
    /** 地址清单 */
    addresses?: Array<{
      /** 地址类型，`InternalIP` / `Hostname` */
      type?: string;
      /** 地址 */
      address?: string;
    }>;
  };
}

/** Pod 对象 */
export interface KubernetesRawPod {
  /** 元数据 */
  metadata?: {
    /** 名称 */
    name?: string;
    /** 命名空间 */
    namespace?: string;
    /** 创建时间 */
    creationTimestamp?: string;
    /** 属主，注：由 Deployment / StatefulSet / DaemonSet 创建的 Pod 才有 */
    ownerReferences?: Array<{
      /** 属主类型，如 `ReplicaSet` */
      kind?: string;
      /** 属主名 */
      name?: string;
    }>;
  };
  /** 期望状态 */
  spec?: {
    /** 所在节点 */
    nodeName?: string;
    /** 容器清单 */
    containers?: Array<{
      /** 容器名 */
      name?: string;
      /** 镜像 */
      image?: string;
    }>;
  };
  /** 实际状态 */
  status?: {
    /** 阶段，`Pending` / `Running` / `Succeeded` / `Failed` / `Unknown` */
    phase?: string;
    /** 原因，如 `Evicted` */
    reason?: string;
    /** Pod IP */
    podIP?: string;
    /** 启动时间 */
    startTime?: string;
    /** 容器状态 */
    containerStatuses?: Array<{
      /** 容器名 */
      name?: string;
      /** 是否就绪 */
      ready?: boolean;
      /** 重启次数 */
      restartCount?: number;
      /** 当前状态 */
      state?: {
        /** 等待中，注：`CrashLoopBackOff` / `ImagePullBackOff` 都在这里 */
        waiting?: { reason?: string };
        /** 已终止 */
        terminated?: { reason?: string };
      };
    }>;
  };
}

/** 工作负载对象（Deployment / StatefulSet 同形） */
export interface KubernetesRawWorkload {
  /** 元数据 */
  metadata?: {
    /** 名称 */
    name?: string;
    /** 命名空间 */
    namespace?: string;
    /** 创建时间 */
    creationTimestamp?: string;
  };
  /** 期望状态 */
  spec?: {
    /** 期望副本数 */
    replicas?: number;
    /** Pod 模板 */
    template?: {
      /** 模板元数据 */
      metadata?: Record<string, unknown>;
      /** 模板期望状态 */
      spec?: {
        /** 容器清单 */
        containers?: Array<{
          /** 容器名 */
          name?: string;
          /** 镜像 */
          image?: string;
        }>;
      };
    };
  };
  /** 实际状态 */
  status?: {
    /** 当前副本数 */
    replicas?: number;
    /** 就绪副本数 */
    readyReplicas?: number;
    /** 已更新副本数 */
    updatedReplicas?: number;
    /** 可用副本数 */
    availableReplicas?: number;
  };
}

/** Service 端口 */
export interface KubernetesRawServicePort {
  /** 端口名 */
  name?: string;
  /** 服务端口 */
  port?: number;
  /** 容器端口 */
  targetPort?: string | number;
  /** 节点端口 */
  nodePort?: number;
  /** 协议 */
  protocol?: string;
}

/** Service 对象 */
export interface KubernetesRawService {
  /** 元数据 */
  metadata?: {
    /** 名称 */
    name?: string;
    /** 命名空间 */
    namespace?: string;
    /** 创建时间 */
    creationTimestamp?: string;
  };
  /** 期望状态 */
  spec?: {
    /** 类型，`ClusterIP` / `NodePort` / `LoadBalancer` / `ExternalName` */
    type?: string;
    /** 集群内 IP */
    clusterIP?: string;
    /** 外部 IP */
    externalIPs?: string[] | null;
    /** 端口清单 */
    ports?: KubernetesRawServicePort[] | null;
    /** 选择器 */
    selector?: Record<string, string> | null;
  };
}

/** 命名空间对象 */
export interface KubernetesRawNamespace {
  /** 元数据 */
  metadata?: {
    /** 名称 */
    name?: string;
    /** 创建时间 */
    creationTimestamp?: string;
  };
  /** 实际状态 */
  status?: {
    /** 阶段，`Active` / `Terminating` */
    phase?: string;
  };
}

/**
 * 集群概览
 *
 * 注：把版本、节点、命名空间、Pod、工作负载、Service 六次请求合并成一份扁平结构，
 * 前端一次请求即可渲染仪表板
 */
export interface KubernetesSummary {
  /** 集群版本，如 `v1.30.4` */
  version: string;
  /** 平台，如 `linux/amd64` */
  platform: string;
  /** Go 版本 */
  goVersion: string;
  /** 节点总数 */
  nodes: number;
  /** 就绪节点数 */
  nodesReady: number;
  /** 命名空间数 */
  namespaces: number;
  /** Pod 总数 */
  pods: number;
  /** 运行中的 Pod 数 */
  podsRunning: number;
  /** 等待中的 Pod 数 */
  podsPending: number;
  /** 失败的 Pod 数 */
  podsFailed: number;
  /** 已完成的 Pod 数 */
  podsSucceeded: number;
  /** 工作负载（Deployment）数 */
  deployments: number;
  /** Service 数 */
  services: number;
  /** 可分配 CPU 总核数，注：由各节点 `capacity.cpu` 累加 */
  cpuCapacity: number;
  /** 可分配内存总量（字节），注：由各节点 `capacity.memory` 累加 */
  memoryCapacity: number;
}

/**
 * 集群连通性诊断
 *
 * 注：`latencyMs` 是 `/healthz` 的往返耗时，用来区分「连得上但慢」与「连不上」；
 * `warnings` 由后端判定，前端原样展示，避免两处口径不一致
 */
export interface KubernetesDiagnose {
  /** `/healthz` 往返耗时（毫秒） */
  latencyMs: number;
  /** `/healthz` 的原始响应，正常为 `ok` */
  ping: string;
  /** 集群版本 */
  version: string;
  /** 平台 */
  platform: string;
  /** 实际使用的鉴权方式，`token` / `cert` / `anonymous` */
  authMode: string;
  /** 实际使用的协议 */
  protocol: string;
  /** 是否校验证书链 */
  verify: boolean;
  /** 风险提示 */
  warnings: string[];
}
