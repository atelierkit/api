// 内部依赖
import type { KubernetesRawNode } from './kubernetes.types.js';

/**
 * 资源单位的换算表
 *
 * 注：Kubernetes 的 quantity 用「数字 + 单位」表示（`8`、`500m`、`16Gi`、`1M`）；
 * 十进制单位（`k` / `M` / `G` / `T`）与二进制单位（`Ki` / `Mi` / `Gi` / `Ti`）**不能混用**，
 * 这里按官方定义逐个列出，不认识的单位按 1 处理
 */
const QUANTITY_UNITS: Record<string, number> = {
  '': 1,
  // 注：`m` 是千分之一（CPU 的 `500m` = 0.5 核）
  m: 0.001,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};

/**
 * 解析 Kubernetes 的 quantity
 *
 * 注 1：内存量统一换算成**字节**、CPU 归成**核数** —— 两者共用本函数，调用方按用途解读
 * 注 2：解析不了时返回 0（老集群可能不给 `capacity`，界面显示 0 比显示 NaN 好）
 *
 * @param value quantity 字符串，如 `8`、`500m`、`16Gi`
 * @returns 数值
 */
export function quantityOf(value: string): number {
  /** 数字与单位 */
  const matched = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$/.exec((value ?? '').trim());
  if (matched === null) {
    return 0;
  }
  /** 数值部分 */
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return amount * (QUANTITY_UNITS[matched[2]] ?? 1);
}

/**
 * 判断节点是否就绪
 *
 * 注：只看 `Ready` 这一条条件 —— `MemoryPressure` 之类的条件为 True 反而是「有问题」，
 * 不能拿「全部条件为 True」当健康判据
 *
 * @param node 节点对象
 * @returns 就绪时为 true
 */
export function nodeReadyOf(node: KubernetesRawNode): boolean {
  /** `Ready` 条件 */
  const ready = (node.status?.conditions ?? []).find(
    (condition) => condition.type === 'Ready',
  );
  return ready?.status === 'True';
}

/**
 * 节点状态文案
 *
 * 注：`kubectl get nodes` 的 STATUS 列就是这个口径 —— 被 cordon 的节点显示
 * `SchedulingDisabled`（即使它是 Ready 的），因为运维看到这个要立刻想起来「这台上不会再有新 Pod」
 *
 * @param node 节点对象
 * @returns 状态文案
 */
export function nodeStatusOf(node: KubernetesRawNode): string {
  if (node.spec?.unschedulable === true) {
    return 'SchedulingDisabled';
  }
  /** `Ready` 条件 */
  const ready = (node.status?.conditions ?? []).find(
    (condition) => condition.type === 'Ready',
  );
  if (ready?.status === 'True') {
    return 'Ready';
  }
  return ready?.status === 'False' ? 'NotReady' : 'Unknown';
}

/**
 * 取节点角色
 *
 * 注：角色来自标签 `node-role.kubernetes.io/<role>`（值为空串），kubeadm 的 master 节点
 * 还会有 `node-role.kubernetes.io/control-plane`；没有角色标签的（多数工作节点）返回空串，
 * 由前端显示成横线，不要编造一个 `worker`
 *
 * @param node 节点对象
 * @returns 逗号分隔的角色，如 `control-plane,master`
 */
export function nodeRolesOf(node: KubernetesRawNode): string {
  /** 角色前缀 */
  const prefix = 'node-role.kubernetes.io/';
  return Object.keys(node.metadata?.labels ?? {})
    .filter((key) => key.startsWith(prefix) && key.length > prefix.length)
    .map((key) => key.slice(prefix.length))
    .sort()
    .join(',');
}

/**
 * 取节点内网地址
 *
 * @param node 节点对象
 * @returns 内网 IP，没有时退回主机名，都没有时为空串
 */
export function nodeAddressOf(node: KubernetesRawNode): string {
  /** 地址清单 */
  const addresses = node.status?.addresses ?? [];
  /** 内网地址 */
  const internal = addresses.find((item) => item.type === 'InternalIP');
  if (internal?.address) {
    return internal.address;
  }
  /** 主机名 */
  const hostname = addresses.find((item) => item.type === 'Hostname');
  return hostname?.address ?? '';
}
