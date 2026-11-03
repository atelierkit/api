// 外部依赖
import { BadRequestException, Injectable } from '@nestjs/common';
// 内部依赖
import { dockerRequest } from '../docker.request.js';
import { DockerService } from '../docker.service.js';
import {
  DOCKER_OBJECT_ACTIONS,
  type DockerAction,
  type DockerActionValue,
  type DockerContainerDetail,
  type DockerContainerRow,
  type DockerImageDetail,
  type DockerImageRow,
  type DockerNetworkRow,
  type DockerObjectType,
  type DockerVolumeRow,
} from './object.types.js';

/** 容器列表的原始条目，注：只声明用到的字段 */
interface RawContainer {
  /** 完整 ID */
  Id?: string;
  /** 名称清单，注：带前导 `/` */
  Names?: string[];
  /** 镜像名 */
  Image?: string;
  /** 状态 */
  State?: string;
  /** 状态描述 */
  Status?: string;
  /** 创建时间（秒级） */
  Created?: number;
  /** 端口映射 */
  Ports?: Array<{
    /** 容器内端口 */
    PrivatePort?: number;
    /** 宿主端口 */
    PublicPort?: number;
    /** 协议 */
    Type?: string;
  }>;
  /** 标签 */
  Labels?: Record<string, string>;
  /**
   * 网络设置
   *
   * 注：网络列表**不返回**容器明细（`GET /networks` 的 `Containers` 字段在 daemon 29.x 上
   * 整个缺失，已实测），所以「某个网络接了哪些容器」只能从容器这一侧反推 —— 每条的
   * `NetworkSettings.Networks` 的键就是它接入的网络名
   */
  NetworkSettings?: {
    /** 网络名 → 端点配置 */
    Networks?: Record<string, unknown> | null;
  };
}

/** 容器详情 */
interface RawContainerInspect {
  /** 完整 ID */
  Id?: string;
  /** 名称，注：带前导 `/` */
  Name?: string;
  /** 配置 */
  Config?: {
    /** 镜像名 */
    Image?: string;
  };
  /** 运行状态 */
  State?: {
    /** 状态 */
    Status?: string;
    /** 启动时间 */
    StartedAt?: string;
    /** 结束时间 */
    FinishedAt?: string;
    /** 退出码 */
    ExitCode?: number;
  };
  /** 重启次数 */
  RestartCount?: number;
  /** 启动命令 */
  Path?: string;
  /** 启动参数 */
  Args?: string[];
  /** 挂载点 */
  Mounts?: Array<{
    /** 宿主路径 */
    Source?: string;
    /** 容器路径 */
    Destination?: string;
    /** 读写模式 */
    Mode?: string;
  }>;
  /** 网络配置 */
  NetworkSettings?: {
    /** 接入的网络 */
    Networks?: Record<string, unknown> | null;
  };
}

/** 镜像列表的原始条目 */
interface RawImage {
  /** 完整 ID，注：`sha256:` 前缀 */
  Id?: string;
  /** 标签清单，注：悬空镜像为 `['<none>:<none>']` 或 null */
  RepoTags?: string[] | null;
  /** 大小（字节） */
  Size?: number;
  /** 创建时间（秒级） */
  Created?: number;
  /** 使用该镜像的容器数 */
  Containers?: number;
}

/** 镜像详情 */
interface RawImageInspect {
  /** 完整 ID */
  Id?: string;
  /** 标签清单 */
  RepoTags?: string[] | null;
  /** 大小（字节） */
  Size?: number;
  /** 创建时间（ISO 字符串） */
  Created?: string;
  /** 架构 */
  Architecture?: string;
  /** 操作系统 */
  Os?: string;
  /** 配置 */
  Config?: {
    /** 入口命令 */
    Entrypoint?: string[] | null;
    /** 默认参数 */
    Cmd?: string[] | null;
  };
}

/** 数据卷的原始条目 */
interface RawVolume {
  /** 卷名 */
  Name?: string;
  /** 驱动 */
  Driver?: string;
  /** 挂载点 */
  Mountpoint?: string;
  /** 创建时间 */
  CreatedAt?: string;
  /** 作用域 */
  Scope?: string;
}

/** 数据卷列表响应 */
interface RawVolumeList {
  /** 卷清单，注：无卷时为 null */
  Volumes?: RawVolume[] | null;
}

/** 网络的原始条目 */
interface RawNetwork {
  /** 完整 ID */
  Id?: string;
  /** 名称 */
  Name?: string;
  /** 驱动 */
  Driver?: string;
  /** 作用域 */
  Scope?: string;
  /** 是否内部网络 */
  Internal?: boolean;
  /** 是否允许手动接入 */
  Attachable?: boolean;
  /** 创建时间（RFC3339，纳秒精度） */
  Created?: string;
  /**
   * 接入的容器，注：**列表接口不返回该字段**（实测 daemon 29.x），只有详情接口才有；
   * 列表里的容器数由 `networkCountsOf` 从容器侧统计
   */
  Containers?: Record<string, unknown> | null;
}

/**
 * 统计每个网络接入的容器数
 *
 * 注：同一容器可以接多个网络，故按容器逐个累加，不能只取主网络
 *
 * @param containers 容器列表（`GET /containers/json?all=1` 的结果）
 * @returns 网络名 → 容器数
 */
export function networkCountsOf(
  containers: readonly RawContainer[],
): Map<string, number> {
  /** 统计结果 */
  const counts = new Map<string, number>();
  for (const container of containers) {
    for (const name of Object.keys(container.NetworkSettings?.Networks ?? {})) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 截短 ID
 *
 * @param id 完整 ID
 * @returns 12 位短 ID，注：镜像 ID 的 `sha256:` 前缀先去掉
 */
export function shortIdOf(id: string | undefined): string {
  return (id ?? '').replace(/^sha256:/, '').slice(0, 12);
}

/**
 * 名称去掉前导斜杠
 *
 * @param name 容器名
 * @returns 展示用名称
 */
function nameOf(name: string | undefined): string {
  return (name ?? '').replace(/^\//, '');
}

/**
 * 端口映射 → 展示文本
 *
 * @param ports 原始端口清单
 * @returns 如 `8080→80/tcp`，多项以 `, ` 连接
 */
export function portsTextOf(ports: RawContainer['Ports']): string {
  if (!Array.isArray(ports)) {
    return '';
  }
  return ports
    .filter((item) => typeof item?.PrivatePort === 'number')
    .map((item) => {
      /** 容器内端口 */
      const inner = `${item.PrivatePort}/${item.Type ?? 'tcp'}`;
      return item.PublicPort ? `${item.PublicPort}→${inner}` : inner;
    })
    .join(', ');
}

/**
 * 标签清单归整
 *
 * @param tags 原始标签
 * @returns 标签清单，注：悬空镜像的 `<none>:<none>` 归成空数组
 */
function tagsOf(tags: string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter((tag) => tag !== '' && tag !== '<none>:<none>');
}

/**
 * Docker 宿主机下的资源服务
 *
 * 注 1：与 KONG 的对象层刻意不同 —— Docker 的各资源**不是**同构 REST，写操作必须落到
 * 白名单动作上（见 `DOCKER_OBJECT_ACTIONS`），这里不提供任何「传路径」的能力
 * 注 2：列表做投影（只下发展示需要的字段）—— `/containers/json` 单个容器 30+ 字段，
 * 整份透传会让表格明显变慢
 * 注 3：Docker 没有 offset 分页，清单接口一次返回全量
 */
@Injectable()
export class DockerObjectService {
  /**
   * 构造函数
   *
   * @param dockerSrv 宿主机服务，注：用于把宿主机ID换成连接参数（不存在时抛 404）
   */
  constructor(private readonly dockerSrv: DockerService) {}

  /**
   * 获取资源清单
   *
   * @param dockerId 宿主机ID
   * @param type 资源类型
   * @returns 资源清单
   */
  async index(
    dockerId: number,
    type: DockerObjectType,
  ): Promise<
    | DockerContainerRow[]
    | DockerImageRow[]
    | DockerVolumeRow[]
    | DockerNetworkRow[]
  > {
    /** 连接参数 */
    const target = await this.dockerSrv.target(dockerId);
    switch (type) {
      case 'containers': {
        /** 容器清单，注：`all=1` 才会带上已停止的容器 */
        const rows = await dockerRequest<RawContainer[]>(
          target,
          '/containers/json?all=1',
        );
        return (rows ?? []).map((row) => this.containerRow(row));
      }
      case 'images': {
        /** 镜像清单 */
        const rows = await dockerRequest<RawImage[]>(target, '/images/json');
        return (rows ?? []).map((row) => this.imageRow(row));
      }
      case 'volumes': {
        /** 卷清单，注：响应是 `{ Volumes }` 而不是数组 */
        const body = await dockerRequest<RawVolumeList>(target, '/volumes');
        return (body?.Volumes ?? []).map((row) => this.volumeRow(row));
      }
      case 'networks': {
        // 注：网络列表不返回容器明细（`Containers` 字段在 daemon 29.x 上整个缺失，已实测），
        // 故并行取一次容器列表，用每条的 `NetworkSettings.Networks` 反推每个网络接了几个容器；
        // 容器请求失败时降级成 `null`（退回网络对象自带的 Containers，可能为空），
        // 不能让「统计数量」这种附加信息的失败把整张网络列表打掉
        /** 网络清单与容器统计 */
        const [rows, counts] = await Promise.all([
          dockerRequest<RawNetwork[]>(target, '/networks'),
          dockerRequest<RawContainer[]>(
            target,
            '/containers/json?all=1',
          )
            .then((list) => networkCountsOf(list ?? []))
            .catch(() => null),
        ]);
        return (rows ?? []).map((row) => this.networkRow(row, counts));
      }
      default:
        // 注：类型已由 DTO 白名单挡过，这里只是防止将来新增类型时静默返回 undefined
        throw new BadRequestException(`不支持的资源类型：${String(type)}！`);
    }
  }

  /**
   * 获取资源详情
   *
   * @param dockerId 宿主机ID
   * @param type 资源类型
   * @param id 资源ID
   * @returns 资源详情
   */
  async show(
    dockerId: number,
    type: DockerObjectType,
    id: string,
  ): Promise<
    DockerContainerDetail | DockerImageDetail | DockerVolumeRow | DockerNetworkRow
  > {
    /** 连接参数 */
    const target = await this.dockerSrv.target(dockerId);
    /** 已编码的资源ID，注：镜像 tag 里的 `:` 与 `@` 需要编码后再进路径 */
    const ref = encodeURIComponent(id);
    switch (type) {
      case 'containers': {
        /** 容器详情 */
        const body = await dockerRequest<RawContainerInspect>(
          target,
          `/containers/${ref}/json`,
        );
        return this.containerDetail(body);
      }
      case 'images': {
        /** 镜像详情 */
        const body = await dockerRequest<RawImageInspect>(
          target,
          `/images/${ref}/json`,
        );
        return this.imageDetail(body);
      }
      case 'volumes': {
        /** 卷详情，注：卷没有 `/json` 后缀 */
        const body = await dockerRequest<RawVolume>(
          target,
          `/volumes/${ref}`,
        );
        return this.volumeRow(body);
      }
      case 'networks': {
        /** 网络详情 */
        const body = await dockerRequest<RawNetwork>(
          target,
          `/networks/${ref}`,
        );
        // 注：详情接口自带 `Containers` 明细，不需要再统计一次
        return this.networkRow(body, null);
      }
      default:
        throw new BadRequestException(`不支持的资源类型：${String(type)}！`);
    }
  }

  /**
   * 执行资源动作
   *
   * @param dockerId 宿主机ID
   * @param type 资源类型
   * @param action 动作
   * @param id 资源ID
   * @param value 动作参数
   * @throws BadRequestException 该类型不支持此动作时抛出
   */
  async action(
    dockerId: number,
    type: DockerObjectType,
    action: DockerAction,
    id: string,
    value: DockerActionValue = {},
  ): Promise<void> {
    /** 动作规则 */
    const spec = DOCKER_OBJECT_ACTIONS[type]?.[action];
    if (spec === undefined) {
      throw new BadRequestException(
        `不支持的操作：${type} 不能执行 ${action}！`,
      );
    }
    /** 连接参数 */
    const target = await this.dockerSrv.target(dockerId);
    // 注：路径模板写死在 `DOCKER_OBJECT_ACTIONS` 里，此处只做一次编码
    await dockerRequest(target, spec.path(encodeURIComponent(id), value), {
      method: spec.method,
    });
  }

  /**
   * 容器 → 列表项
   *
   * @param row 原始条目
   * @returns 列表项
   */
  private containerRow(row: RawContainer): DockerContainerRow {
    return {
      id: shortIdOf(row.Id),
      name: nameOf(row.Names?.[0]),
      image: row.Image ?? '',
      state: row.State ?? '',
      status: row.Status ?? '',
      created: row.Created ?? 0,
      ports: portsTextOf(row.Ports),
      // 注：只取 compose 项目名，其余标签不下发（有的镜像把整份环境信息塞在标签里）
      project: row.Labels?.['com.docker.compose.project'] ?? '',
    };
  }

  /**
   * 容器详情
   *
   * @param body 原始详情
   * @returns 详情，注：**不下发环境变量**（常见把密码写在 Env 里）
   */
  private containerDetail(body: RawContainerInspect): DockerContainerDetail {
    return {
      id: shortIdOf(body.Id),
      name: nameOf(body.Name),
      image: body.Config?.Image ?? '',
      state: body.State?.Status ?? '',
      startedAt: body.State?.StartedAt ?? '',
      finishedAt: body.State?.FinishedAt ?? '',
      restartCount: body.RestartCount ?? 0,
      command: [body.Path ?? '', ...(body.Args ?? [])].join(' ').trim(),
      exitCode: body.State?.ExitCode ?? 0,
      mounts: (body.Mounts ?? []).map((mount) => ({
        source: mount.Source ?? '',
        destination: mount.Destination ?? '',
        mode: mount.Mode ?? '',
      })),
      networks: Object.keys(body.NetworkSettings?.Networks ?? {}),
    };
  }

  /**
   * 镜像 → 列表项
   *
   * @param row 原始条目
   * @returns 列表项
   */
  private imageRow(row: RawImage): DockerImageRow {
    return {
      id: shortIdOf(row.Id),
      tags: tagsOf(row.RepoTags),
      size: row.Size ?? 0,
      created: row.Created ?? 0,
      containers: row.Containers ?? 0,
    };
  }

  /**
   * 镜像详情
   *
   * @param body 原始详情
   * @returns 详情
   */
  private imageDetail(body: RawImageInspect): DockerImageDetail {
    return {
      id: shortIdOf(body.Id),
      tags: tagsOf(body.RepoTags),
      size: body.Size ?? 0,
      created: body.Created ?? '',
      architecture: body.Architecture ?? '',
      os: body.Os ?? '',
      entrypoint: body.Config?.Entrypoint ?? [],
      command: body.Config?.Cmd ?? [],
    };
  }

  /**
   * 卷 → 列表项
   *
   * @param row 原始条目
   * @returns 列表项
   */
  private volumeRow(row: RawVolume): DockerVolumeRow {
    return {
      name: row.Name ?? '',
      driver: row.Driver ?? '',
      mountpoint: row.Mountpoint ?? '',
      createdAt: row.CreatedAt ?? '',
      scope: row.Scope ?? '',
    };
  }

  /**
   * 网络 → 列表项
   *
   * @param row 原始条目
   * @param counts 容器统计，注：`null` 表示容器列表没取到，退回网络对象自带的 `Containers`
   * @returns 列表项
   */
  private networkRow(
    row: RawNetwork,
    counts: Map<string, number> | null,
  ): DockerNetworkRow {
    /** 网络名，注：统计结果按网络名索引 */
    const name = row.Name ?? '';
    return {
      id: shortIdOf(row.Id),
      name,
      driver: row.Driver ?? '',
      scope: row.Scope ?? '',
      internal: row.Internal === true,
      attachable: row.Attachable === true,
      containers:
        counts === null
          ? Object.keys(row.Containers ?? {}).length
          : (counts.get(name) ?? 0),
      created: row.Created ?? '',
    };
  }
}
