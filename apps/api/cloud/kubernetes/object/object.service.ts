// 外部依赖
import { BadRequestException, Injectable } from '@nestjs/common';
// 内部依赖
import { kubernetesRequest } from '../kubernetes.request.js';
import { KubernetesService } from '../kubernetes.service.js';
import type {
  KubernetesList,
  KubernetesRawNamespace,
  KubernetesRawNode,
  KubernetesRawPod,
  KubernetesRawService,
  KubernetesRawServicePort,
  KubernetesRawWorkload,
} from '../kubernetes.types.js';
import {
  nodeAddressOf,
  nodeRolesOf,
  nodeStatusOf,
  quantityOf,
} from '../kubernetes.util.js';
import {
  KUBERNETES_OBJECT_ACTIONS,
  collectionPathOf,
  itemPathOf,
  namespaceOf,
  type KubernetesAction,
  type KubernetesActionValue,
  type KubernetesNamespaceRow,
  type KubernetesNodeRow,
  type KubernetesObjectType,
  type KubernetesPodRow,
  type KubernetesServiceRow,
  type KubernetesWorkloadRow,
} from './object.types.js';

/**
 * Pod 就绪容器数
 *
 * @param pod Pod 对象
 * @returns 如 `1/1`，注：分母优先取期望容器数，老集群没有 `containerStatuses` 时退回容器清单长度
 */
export function podReadyOf(pod: KubernetesRawPod): string {
  /** 期望容器数 */
  const total =
    pod.spec?.containers?.length ?? pod.status?.containerStatuses?.length ?? 0;
  /** 就绪容器数 */
  const ready = (pod.status?.containerStatuses ?? []).filter(
    (status) => status.ready === true,
  ).length;
  return `${ready}/${total}`;
}

/**
 * Pod 重启次数
 *
 * @param pod Pod 对象
 * @returns 各容器 `restartCount` 之和
 */
export function podRestartsOf(pod: KubernetesRawPod): number {
  return (pod.status?.containerStatuses ?? []).reduce(
    (sum, status) => sum + (status.restartCount ?? 0),
    0,
  );
}

/**
 * Pod 状态
 *
 * 注 1：**容器级的等待 / 终止原因优先于阶段** —— `CrashLoopBackOff`、`ImagePullBackOff` 这类
 * 信息才是用户要看的，只显示 `Running` 等于把故障藏起来
 * 注 2：`Completed` 是 Job 正常结束，不算异常，故排除掉
 *
 * @param pod Pod 对象
 * @returns 状态文案
 */
export function podStatusOf(pod: KubernetesRawPod): string {
  /** 容器状态 */
  const statuses = pod.status?.containerStatuses ?? [];
  /** 等待中的原因 */
  const waiting = statuses.find(
    (status) => (status.state?.waiting?.reason ?? '') !== '',
  );
  if (waiting !== undefined) {
    return waiting.state?.waiting?.reason ?? '';
  }
  /** 终止原因，注：`Completed` 是正常结束 */
  const terminated = statuses.find((status) => {
    /** 终止原因 */
    const reason = status.state?.terminated?.reason ?? '';
    return reason !== '' && reason !== 'Completed';
  });
  if (terminated !== undefined) {
    return terminated.state?.terminated?.reason ?? '';
  }
  return pod.status?.phase ?? pod.status?.reason ?? '';
}

/**
 * Pod 镜像清单
 *
 * @param pod Pod 对象
 * @returns 去重后的镜像，以 `, ` 连接
 */
export function podImagesOf(pod: KubernetesRawPod): string {
  /** 镜像清单 */
  const images = (pod.spec?.containers ?? [])
    .map((container) => container.image ?? '')
    .filter((image) => image !== '');
  return [...new Set(images)].join(', ');
}

/**
 * 工作负载就绪副本数
 *
 * @param workload 工作负载对象
 * @returns 如 `2/3`
 */
export function workloadReadyOf(workload: KubernetesRawWorkload): string {
  /** 期望副本数，注：`spec.replicas` 缺省时 Kubernetes 按 1 处理 */
  const replicas = workload.spec?.replicas ?? workload.status?.replicas ?? 0;
  /** 就绪副本数 */
  const ready = workload.status?.readyReplicas ?? 0;
  return `${ready}/${replicas}`;
}

/**
 * Service 端口文本
 *
 * @param ports 端口清单
 * @returns 如 `80/TCP, 443/TCP→30443`，注：箭头后面是 NodePort
 */
export function servicePortsOf(
  ports: KubernetesRawServicePort[] | null | undefined,
): string {
  if (!Array.isArray(ports)) {
    return '';
  }
  return ports
    .filter((item) => typeof item?.port === 'number')
    .map((item) => {
      /** 容器侧端口文本 */
      const text = `${item.port}/${item.protocol ?? 'TCP'}`;
      return item.nodePort ? `${text}→${item.nodePort}` : text;
    })
    .join(', ');
}

/**
 * Service 选择器文本
 *
 * @param selector 选择器
 * @returns 如 `app=web,tier=front`，注：按键排序，保证同一份选择器每次显示一致
 */
export function selectorTextOf(
  selector: Record<string, string> | null | undefined,
): string {
  if (selector === null || selector === undefined) {
    return '';
  }
  return Object.keys(selector)
    .sort()
    .map((key) => `${key}=${selector[key]}`)
    .join(',');
}

/**
 * Kubernetes 集群下的资源服务
 *
 * 注 1：与 Docker 的对象层同构 —— 各资源不是同构 REST 的子资源写操作必须落到白名单动作上
 * （见 `KUBERNETES_OBJECT_ACTIONS`），这里不提供任何「传路径」的能力
 * 注 2：列表做投影（只下发展示需要的字段）—— `/api/v1/pods` 单条就有几十 KB，
 * 整份透传会让表格明显变慢
 * 注 3：Kubernetes 的清单接口一次返回全量（没有 offset），分页靠 `limit` + `continue`，
 * 家用集群规模用不到，故不做分页
 */
@Injectable()
export class KubernetesObjectService {
  /**
   * 构造函数
   *
   * @param kubernetesSrv 集群服务，注：用于把集群ID换成连接参数（不存在时抛 404）
   */
  constructor(private readonly kubernetesSrv: KubernetesService) {}

  /**
   * 获取资源清单
   *
   * @param kubernetesId 集群ID
   * @param type 资源类型
   * @param namespace 命名空间，注：空串表示全部命名空间（集群级资源忽略）
   * @returns 资源清单
   */
  async index(
    kubernetesId: number,
    type: KubernetesObjectType,
    namespace = '',
  ): Promise<
    | KubernetesNamespaceRow[]
    | KubernetesNodeRow[]
    | KubernetesPodRow[]
    | KubernetesWorkloadRow[]
    | KubernetesServiceRow[]
  > {
    /** 连接参数 */
    const target = await this.kubernetesSrv.target(kubernetesId);
    /** 列表路径，注：命名空间为空串时给的是集群级列表路径（全部命名空间） */
    const path = collectionPathOf(type, this.scopeOf(type, namespace));
    switch (type) {
      case 'namespaces': {
        /** 命名空间清单 */
        const body = await kubernetesRequest<
          KubernetesList<KubernetesRawNamespace>
        >(target, path);
        return (body?.items ?? []).map((row) => this.namespaceRow(row));
      }
      case 'nodes': {
        /** 节点清单 */
        const body = await kubernetesRequest<KubernetesList<KubernetesRawNode>>(
          target,
          path,
        );
        return (body?.items ?? []).map((row) => this.nodeRow(row));
      }
      case 'pods': {
        /** Pod 清单 */
        const body = await kubernetesRequest<KubernetesList<KubernetesRawPod>>(
          target,
          path,
        );
        return (body?.items ?? []).map((row) => this.podRow(row));
      }
      case 'deployments':
      case 'statefulsets': {
        /** 工作负载清单 */
        const body = await kubernetesRequest<
          KubernetesList<KubernetesRawWorkload>
        >(target, path);
        return (body?.items ?? []).map((row) => this.workloadRow(row));
      }
      case 'services': {
        /** Service 清单 */
        const body = await kubernetesRequest<
          KubernetesList<KubernetesRawService>
        >(target, path);
        return (body?.items ?? []).map((row) => this.serviceRow(row));
      }
      default:
        // 注：类型已由 DTO 白名单挡过，这里只是防止将来新增类型时静默返回 undefined
        throw new BadRequestException(`不支持的资源类型：${String(type)}！`);
    }
  }

  /**
   * 获取资源详情
   *
   * 注：与列表用同一套投影 —— `show` 只给「列表那一行 + 少量补充字段」，
   * 完整对象（含 `managedFields`、`status` 全量）不下发，避免把 API Server 的原始结构透给浏览器
   *
   * @param kubernetesId 集群ID
   * @param type 资源类型
   * @param id 资源名
   * @param namespace 命名空间
   * @returns 资源详情
   */
  async show(
    kubernetesId: number,
    type: KubernetesObjectType,
    id: string,
    namespace = '',
  ): Promise<
    | KubernetesNamespaceRow
    | KubernetesNodeRow
    | KubernetesPodRow
    | KubernetesWorkloadRow
    | KubernetesServiceRow
  > {
    /** 连接参数 */
    const target = await this.kubernetesSrv.target(kubernetesId);
    /** 单条资源路径，注：命名空间按动作口径归一（详情必须落到具体命名空间） */
    const path = itemPathOf(
      type,
      namespaceOf(type, namespace, target.namespace),
      id,
    );
    switch (type) {
      case 'namespaces':
        return this.namespaceRow(
          await kubernetesRequest<KubernetesRawNamespace>(target, path),
        );
      case 'nodes':
        return this.nodeRow(
          await kubernetesRequest<KubernetesRawNode>(target, path),
        );
      case 'pods':
        return this.podRow(
          await kubernetesRequest<KubernetesRawPod>(target, path),
        );
      case 'deployments':
      case 'statefulsets':
        return this.workloadRow(
          await kubernetesRequest<KubernetesRawWorkload>(target, path),
        );
      case 'services':
        return this.serviceRow(
          await kubernetesRequest<KubernetesRawService>(target, path),
        );
      default:
        throw new BadRequestException(`不支持的资源类型：${String(type)}！`);
    }
  }

  /**
   * 执行资源动作
   *
   * @param kubernetesId 集群ID
   * @param type 资源类型
   * @param action 动作
   * @param id 资源名
   * @param value 动作参数
   * @param namespace 命名空间
   * @throws BadRequestException 该类型不支持此动作、或扩缩容没给副本数时抛出
   */
  async action(
    kubernetesId: number,
    type: KubernetesObjectType,
    action: KubernetesAction,
    id: string,
    value: KubernetesActionValue = {},
    namespace = '',
  ): Promise<void> {
    /** 动作规则 */
    const spec = KUBERNETES_OBJECT_ACTIONS[type]?.[action];
    if (spec === undefined) {
      throw new BadRequestException(
        `不支持的操作：${type} 不能执行 ${action}！`,
      );
    }
    // 注：扩缩容没给副本数时不能默默按 0 处理 —— 那等于「把服务缩到零」，是不可逆的破坏性操作
    if (action === 'scale' && value.replicas === undefined) {
      throw new BadRequestException('扩缩容必须指定目标副本数！');
    }
    /** 连接参数 */
    const target = await this.kubernetesSrv.target(kubernetesId);
    /** 动作参数，注：重启注解的时间戳由服务端生成，不接受前端指定 */
    const payload: KubernetesActionValue = {
      ...value,
      restartedAt: value.restartedAt ?? new Date().toISOString(),
    };
    /** 具体命名空间 */
    const scope = namespaceOf(type, namespace, target.namespace);
    await kubernetesRequest(target, spec.path(scope, id, payload), {
      method: spec.method,
      ...(spec.body === undefined
        ? {}
        : {
            body: spec.body(payload),
            // 注：Kubernetes 的 PATCH 必须声明合并类型，缺了会得到 415 Unsupported Media Type
            contentType: 'application/merge-patch+json',
          }),
    });
  }

  /**
   * 列表用的命名空间口径
   *
   * 注：与动作不同，列表允许空串（全部命名空间），故只对集群级资源强制清空
   *
   * @param type 资源类型
   * @param namespace 提交的命名空间
   * @returns 命名空间
   */
  private scopeOf(type: KubernetesObjectType, namespace: string): string {
    /** 去空白后的值 */
    const value = (namespace ?? '').trim();
    return type === 'namespaces' || type === 'nodes' ? '' : value;
  }

  /**
   * 命名空间 → 列表项
   *
   * @param row 原始对象
   * @returns 列表项
   */
  private namespaceRow(row: KubernetesRawNamespace): KubernetesNamespaceRow {
    return {
      name: row.metadata?.name ?? '',
      phase: row.status?.phase ?? '',
      created: row.metadata?.creationTimestamp ?? '',
    };
  }

  /**
   * 节点 → 列表项
   *
   * @param row 原始对象
   * @returns 列表项
   */
  private nodeRow(row: KubernetesRawNode): KubernetesNodeRow {
    return {
      name: row.metadata?.name ?? '',
      status: nodeStatusOf(row),
      roles: nodeRolesOf(row),
      version: row.status?.nodeInfo?.kubeletVersion ?? '',
      cpu: quantityOf(row.status?.capacity?.['cpu'] ?? ''),
      memory: quantityOf(row.status?.capacity?.['memory'] ?? ''),
      pods: quantityOf(row.status?.capacity?.['pods'] ?? ''),
      ip: nodeAddressOf(row),
      created: row.metadata?.creationTimestamp ?? '',
    };
  }

  /**
   * Pod → 列表项
   *
   * @param row 原始对象
   * @returns 列表项
   */
  private podRow(row: KubernetesRawPod): KubernetesPodRow {
    return {
      name: row.metadata?.name ?? '',
      namespace: row.metadata?.namespace ?? '',
      ready: podReadyOf(row),
      status: podStatusOf(row),
      restarts: podRestartsOf(row),
      node: row.spec?.nodeName ?? '',
      images: podImagesOf(row),
      ip: row.status?.podIP ?? '',
      created: row.metadata?.creationTimestamp ?? '',
    };
  }

  /**
   * 工作负载 → 列表项
   *
   * @param row 原始对象
   * @returns 列表项
   */
  private workloadRow(row: KubernetesRawWorkload): KubernetesWorkloadRow {
    return {
      name: row.metadata?.name ?? '',
      namespace: row.metadata?.namespace ?? '',
      ready: workloadReadyOf(row),
      replicas: row.spec?.replicas ?? row.status?.replicas ?? 0,
      updated: row.status?.updatedReplicas ?? 0,
      available: row.status?.availableReplicas ?? 0,
      images: [
        ...new Set(
          (row.spec?.template?.spec?.containers ?? [])
            .map((container) => container.image ?? '')
            .filter((image) => image !== ''),
        ),
      ].join(', '),
      created: row.metadata?.creationTimestamp ?? '',
    };
  }

  /**
   * Service → 列表项
   *
   * @param row 原始对象
   * @returns 列表项
   */
  private serviceRow(row: KubernetesRawService): KubernetesServiceRow {
    return {
      name: row.metadata?.name ?? '',
      namespace: row.metadata?.namespace ?? '',
      type: row.spec?.type ?? '',
      clusterIP: row.spec?.clusterIP ?? '',
      ports: servicePortsOf(row.spec?.ports),
      selector: selectorTextOf(row.spec?.selector),
      created: row.metadata?.creationTimestamp ?? '',
    };
  }
}
