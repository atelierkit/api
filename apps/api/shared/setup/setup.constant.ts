/** 初始化标记在 settings 表中的编码 */
export const SETUP_SETTING_CODE = 'init';

/** 初始化完成标记的缓存键，注：无 TTL，只缓存「已初始化」这一正向结果 */
export const SETUP_CACHE_KEY = 'init';

/**
 * 未初始化时仍可访问的接口白名单
 *
 * 注：`/passport/app`、`/passport/icp` 是纯展示配置（应用名、备案号），
 * 创建管理员页面也要用它们渲染页头，因此一并放行
 */
export const SETUP_ALLOW_PATHS: Set<string> = new Set([
  'GET /passport/init',
  'POST /passport/setup',
  'GET /passport/app',
  'GET /passport/icp',
]);
