/**
 * Docker daemon 的版本信息（`GET /version`）
 *
 * 注：只声明本仓库确实用到的字段 —— daemon 的正文还包含大量组件版本细节，
 * 其余部分不建模，避免每次升级都要跟着改类型
 */
export interface DockerVersion {
  /** daemon 版本，如 `27.3.1` */
  Version?: string;
  /** API 版本，如 `1.47`，注：请求路径的 `/v1.47` 前缀取它 */
  ApiVersion?: string;
  /** 最低兼容 API 版本 */
  MinAPIVersion?: string;
  /** 操作系统，如 `linux` */
  Os?: string;
  /** CPU 架构，如 `amd64` */
  Arch?: string;
  /** 内核版本，注：Docker Desktop 下是虚拟机内核 */
  KernelVersion?: string;
  /** 构建信息 */
  GitCommit?: string;
}

/**
 * Docker daemon 的运行概览（`GET /info`）
 *
 * 注：`GET /info` 的正文很大（含插件、运行时的完整清单），这里只取仪表板要展示的字段
 */
export interface DockerInfo {
  /** 主机名 */
  Name?: string;
  /** 容器总数 */
  Containers?: number;
  /** 运行中的容器数 */
  ContainersRunning?: number;
  /** 暂停的容器数 */
  ContainersPaused?: number;
  /** 已停止的容器数 */
  ContainersStopped?: number;
  /** 镜像总数 */
  Images?: number;
  /** 宿主机 CPU 核数 */
  NCPU?: number;
  /** 宿主机内存总量（字节） */
  MemTotal?: number;
  /** 存储驱动，如 `overlay2` */
  Driver?: string;
  /** 数据根目录 */
  DockerRootDir?: string;
  /** 已启用的运行时，如 `runc` */
  DefaultRuntime?: string;
  /** 是否为 swarm 管理节点 */
  Swarm?: {
    /** swarm 状态，`inactive` 表示未启用 */
    LocalNodeState?: string;
  };
}

/**
 * 宿主机概览
 *
 * 注 1：把 `GET /version` 与 `GET /info` 合并成一份扁平结构，前端一次请求即可渲染仪表板
 * 注 2：字段名转成前端习惯的驼峰形式，未取到的值统一给空串 / 0，前端不需要到处写 `??`
 */
export interface DockerSummary {
  /** daemon 版本 */
  version: string;
  /** API 版本 */
  apiVersion: string;
  /** 操作系统 */
  os: string;
  /** CPU 架构 */
  arch: string;
  /** 内核版本 */
  kernelVersion: string;
  /** 主机名 */
  name: string;
  /** 容器总数 */
  containers: number;
  /** 运行中的容器数 */
  containersRunning: number;
  /** 暂停的容器数 */
  containersPaused: number;
  /** 已停止的容器数 */
  containersStopped: number;
  /** 镜像总数 */
  images: number;
  /** CPU 核数 */
  cpus: number;
  /** 内存总量（字节） */
  memoryTotal: number;
  /** 存储驱动 */
  driver: string;
  /** 数据根目录 */
  dockerRootDir: string;
  /** 默认运行时 */
  defaultRuntime: string;
  /** swarm 是否启用 */
  swarmActive: boolean;
}

/**
 * 宿主机连通性诊断
 *
 * 注：`latencyMs` 是 `GET /_ping` 的往返耗时，用来区分「连得上但慢」与「连不上」；
 * `warnings` 是后端判定的风险项（明文连接、关闭证书校验、API 版本不一致），前端原样展示
 */
export interface DockerDiagnose {
  /** `_ping` 往返耗时（毫秒） */
  latencyMs: number;
  /** `_ping` 的原始响应，正常为 `OK` */
  ping: string;
  /** daemon 版本 */
  version: string;
  /** API 版本 */
  apiVersion: string;
  /** 本次实际使用的 API 版本，注：可能是手工配置值，也可能来自探测 */
  usedApiVersion: string;
  /** 实际使用的协议 */
  protocol: string;
  /** 是否启用了 TLS 客户端证书 */
  tls: boolean;
  /** 是否校验证书链 */
  verify: boolean;
  /** 风险提示 */
  warnings: string[];
}
