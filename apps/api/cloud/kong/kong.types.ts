/**
 * KONG 网关的版本与部署信息（`GET /`）
 *
 * 注：只声明本仓库确实用到的字段 —— Kong 的正文很大（含完整 configuration），
 * 其余部分不建模，避免每次升级都要跟着改类型
 */
export interface KongInfo {
  /** Kong 版本，如 `3.9.4` */
  version?: string;
  /** 版本类型，社区版为 `community`，企业版为 `enterprise` */
  edition?: string;
  /** 主机名 */
  hostname?: string;
  /** 节点ID */
  node_id?: string;
  /** Lua 运行时版本 */
  lua_version?: string;
  /** 插件信息 */
  plugins?: {
    /** 服务端可用插件，注：早期版本的 `/plugins/enabled` 就是这里的键 */
    available_on_server?: Record<string, unknown>;
    /** 集群内已启用的插件 */
    enabled_in_cluster?: string[];
  };
}

/**
 * KONG 网关运行状态（`GET /status`）
 *
 * 注：`/default/license/report` 只有企业版才有（社区版返回 404 `{"message":"Not found"}`），
 * 这里改用社区版同样提供的 `/status`，见 `KongService.summary`
 */
export interface KongStatus {
  /** 连接与请求计数 */
  server?: {
    /** 当前活跃连接数 */
    connections_active?: number;
    /** 当前正在读的连接数 */
    connections_reading?: number;
    /** 当前正在写的连接数 */
    connections_writing?: number;
    /** 空闲（等待中）的连接数 */
    connections_waiting?: number;
    /** 累计接受的连接数 */
    connections_accepted?: number;
    /** 累计处理过的连接数 */
    connections_handled?: number;
    /** 累计请求数 */
    total_requests?: number;
  };
  /** 内存占用，注：只取共享字典，键固定为字典名 */
  memory?: {
    /** 共享字典 */
    lua_shared_dicts?: Record<
      string,
      { capacity?: string; allocated_slabs?: string }
    >;
  };
  /** 数据库状态，注：无数据库模式（DB-less）下没有这一段 */
  database?: {
    /** 数据库是否可达 */
    reachable?: boolean;
  };
}

/**
 * 网关概览
 *
 * 注 1：把 `GET /` 与 `GET /status` 合并成一份扁平结构，前端一次请求即可渲染仪表板
 * 注 2：字段名转成前端习惯的驼峰形式，未取到的值统一给空串 / 0 / `null`，
 * 前端不需要到处写 `??`
 */
export interface KongSummary {
  /** Kong 版本 */
  version: string;
  /** 版本类型（`community` / `enterprise`） */
  edition: string;
  /** 主机名 */
  hostname: string;
  /** 节点ID */
  nodeId: string;
  /** Lua 运行时版本 */
  luaVersion: string;
  /** 服务端可用插件数 */
  pluginCount: number;
  /** 集群内已启用的插件数 */
  enabledCount: number;
  /** 当前活跃连接数 */
  connectionsActive: number;
  /** 累计请求数 */
  totalRequests: number;
  /** 数据库是否可达，注：无数据库模式下为 `null`（不适用） */
  dbReachable: boolean | null;
}
