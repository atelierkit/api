/**
 * 站点下可管理的 KONG 对象类型
 *
 * 注 1：类型会直接拼进 Admin API 的路径（`/{type}`），因此必须用白名单校验，不能放任前端传任意串
 * 注 2：与旧私有项目 `src/kong/object` 的六种对象一致（路由 / 服务 / 用户 / 证书 / 插件 / 上游）
 */
export const KONG_OBJECT_TYPES = [
  'routes',
  'services',
  'consumers',
  'certificates',
  'plugins',
  'upstreams',
] as const;

/** 站点下可管理的 KONG 对象类型 */
export type KongObjectType = (typeof KONG_OBJECT_TYPES)[number];

/**
 * KONG 对象
 *
 * 注：Kong 各组对象的字段差异很大（且随版本增减），这里只约定后端确实用到的 `id`，
 * 其余字段原样透传，不在后端建模 —— 否则每次 Kong 升级都要跟着改 DTO
 */
export interface KongObject {
  /** 对象ID，注：Kong 允许按 id 或 name 操作，故是字符串 */
  id?: string;
  /** 其余字段 */
  [key: string]: unknown;
}

/** KONG 分页响应，注：`offset` 只在还有下一页时出现 */
export interface KongPage {
  /** 当前页数据 */
  data?: KongObject[];
  /** 下一页游标 */
  offset?: string;
  /** 下一页地址，注：不同 Kong 版本给的形态不同（路径或完整 URL），故不使用，改用 offset 自行拼 */
  next?: string;
}
