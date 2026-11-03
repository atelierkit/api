/**
 * 宿主机下可管理的资源类型
 *
 * 注 1：类型会参与路径模板的选择（`DOCKER_OBJECT_ACTIONS`），因此必须用白名单校验，
 * 不能放任前端传任意串 —— Docker 的路径里有 `/exec`、`/build`、`/swarm/init` 这类等价于
 * 宿主机 root 的端点，本模块**不做任何路径透传**
 * 注 2：本阶段只做「列表 + 启停删」，卷与网络的创建/删除留到下一阶段
 */
export const DOCKER_OBJECT_TYPES = [
  'containers',
  'images',
  'volumes',
  'networks',
] as const;

/** 宿主机下可管理的资源类型 */
export type DockerObjectType = (typeof DOCKER_OBJECT_TYPES)[number];

/**
 * 资源动作
 *
 * 注：这是**并集**，某个类型具体支持哪些由 `DOCKER_OBJECT_ACTIONS` 决定；
 * DTO 用它挡住乱填，服务层再按类型校验一次
 */
export const DOCKER_ACTION_NAMES = [
  'start',
  'stop',
  'restart',
  'remove',
] as const;

/** 资源动作 */
export type DockerAction = (typeof DOCKER_ACTION_NAMES)[number];

/** 动作附带的参数 */
export interface DockerActionValue {
  /** 删除时是否强制（容器在运行 / 镜像被引用），缺省 false */
  force?: boolean;
  /** 停止或重启前的等待秒数，缺省 10 */
  timeout?: number;
}

/** 动作的映射规则 */
export interface DockerActionSpec {
  /** 请求方式 */
  method: 'POST' | 'DELETE';
  /**
   * 拼请求路径
   *
   * @param id 已编码的资源ID
   * @param value 动作参数
   * @returns 接口路径
   */
  path: (id: string, value: DockerActionValue) => string;
}

/** 停止 / 重启的等待秒数上限，注：超过 600 秒没有必要，也防止前端传个巨大的值把请求挂死 */
const MAX_WAIT_SECONDS = 600;

/**
 * 等待秒数归一
 *
 * @param timeout 前端提交的秒数
 * @returns 0 ~ 600 的整数，缺省 10
 */
export function waitSecondsOf(timeout: number | undefined): number {
  if (timeout === undefined || !Number.isFinite(timeout)) {
    return 10;
  }
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(timeout)));
}

/**
 * 动作 → 方法与路径
 *
 * 注：路径模板写死在这里，是「不做透传」这条约束的落地点 —— 新增能力必须显式加一条，
 * 而不是把前端的参数拼进路径
 */
export const DOCKER_OBJECT_ACTIONS: Record<
  DockerObjectType,
  Partial<Record<DockerAction, DockerActionSpec>>
> = {
  containers: {
    start: {
      method: 'POST',
      path: (id) => `/containers/${id}/start`,
    },
    stop: {
      method: 'POST',
      path: (id, value) => `/containers/${id}/stop?t=${waitSecondsOf(value.timeout)}`,
    },
    restart: {
      method: 'POST',
      path: (id, value) =>
        `/containers/${id}/restart?t=${waitSecondsOf(value.timeout)}`,
    },
    remove: {
      method: 'DELETE',
      path: (id, value) =>
        `/containers/${id}?force=${value.force === true ? 1 : 0}&v=1`,
    },
  },
  images: {
    remove: {
      method: 'DELETE',
      path: (id, value) =>
        `/images/${id}?force=${value.force === true ? 1 : 0}`,
    },
  },
  // 注：卷与网络的写操作（创建 / 删除）按约定留到下一阶段，这里先留空
  volumes: {},
  networks: {},
};

/** 容器列表项 */
export interface DockerContainerRow {
  /** 短 ID（12 位） */
  id: string;
  /** 名称，注：Docker 返回的带前导 `/`，已去掉 */
  name: string;
  /** 镜像名 */
  image: string;
  /** 状态，`running` / `exited` / `paused` / `created` / `restarting` / `dead` */
  state: string;
  /** 状态描述，如 `Up 3 hours` */
  status: string;
  /** 创建时间（秒级时间戳） */
  created: number;
  /** 端口映射，如 `8080→80/tcp` */
  ports: string;
  /** compose 项目名，注：非 compose 起的容器为空串 */
  project: string;
}

/** 镜像列表项 */
export interface DockerImageRow {
  /** 短 ID（12 位） */
  id: string;
  /** 标签清单，注：悬空镜像为 `<none>` */
  tags: string[];
  /** 大小（字节） */
  size: number;
  /** 创建时间（秒级时间戳） */
  created: number;
  /** 使用该镜像的容器数 */
  containers: number;
}

/** 数据卷列表项 */
export interface DockerVolumeRow {
  /** 卷名 */
  name: string;
  /** 驱动 */
  driver: string;
  /** 挂载点 */
  mountpoint: string;
  /** 创建时间（ISO 字符串），注：老 daemon 不返回该字段 */
  createdAt: string;
  /** 作用域，`local` / `global` */
  scope: string;
}

/** 网络列表项 */
export interface DockerNetworkRow {
  /** 短 ID（12 位） */
  id: string;
  /** 名称 */
  name: string;
  /** 驱动 */
  driver: string;
  /** 作用域 */
  scope: string;
  /** 是否内部网络 */
  internal: boolean;
  /** 是否允许手动接入 */
  attachable: boolean;
  /** 接入的容器数 */
  containers: number;
  /**
   * 创建时间（ISO 字符串）
   *
   * 注：daemon 返回的是 RFC3339 纳秒精度（如 `2026-10-27T09:58:32.481086667Z`），
   * 前端按毫秒解析即可（多余的位数会被截断），不做后端格式化
   */
  created: string;
}

/** 容器详情 */
export interface DockerContainerDetail {
  /** 短 ID */
  id: string;
  /** 名称 */
  name: string;
  /** 镜像名 */
  image: string;
  /** 状态 */
  state: string;
  /** 启动时间（ISO 字符串） */
  startedAt: string;
  /** 结束时间（ISO 字符串） */
  finishedAt: string;
  /** 重启次数 */
  restartCount: number;
  /** 启动命令 */
  command: string;
  /** 退出码，注：运行中的容器为 0 */
  exitCode: number;
  /** 挂载点，注：只给宿主路径与容器路径 */
  mounts: Array<{ source: string; destination: string; mode: string }>;
  /** 网络名 */
  networks: string[];
}

/** 镜像详情 */
export interface DockerImageDetail {
  /** 短 ID */
  id: string;
  /** 标签清单 */
  tags: string[];
  /** 大小（字节） */
  size: number;
  /** 创建时间（ISO 字符串） */
  created: string;
  /** 架构 */
  architecture: string;
  /** 操作系统 */
  os: string;
  /** 入口命令 */
  entrypoint: string[];
  /** 默认参数 */
  command: string[];
}
