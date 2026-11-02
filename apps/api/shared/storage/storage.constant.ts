/** 头像对象在存储中的 key 前缀，注：`users.avatar` 只存 key（形如 `avatar/<uuid>.webp`），不存域名与访问路径 */
export const AVATAR_KEY_PREFIX = 'avatar/';

/** 静态资源访问前缀，注：由 `main.ts` 的 `useStaticAssets` 提供，与存储根目录一一对应 */
export const STATIC_URL_PREFIX = '/static/';

/** 头像文件大小上限（字节），注：前端已裁到 256×256，2MB 足够且能挡住误传原图 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 头像允许的扩展名，注：不含 svg（同源打开即可执行脚本）与 gif（无意义且攻击面更大） */
export const AVATAR_EXTENSIONS = ['png', 'jpg', 'webp'] as const;

/** 头像允许的扩展名类型 */
export type AvatarExtension = (typeof AVATAR_EXTENSIONS)[number];

/** 上传目录环境变量，注：容器部署时必须挂卷并指向卷内目录，否则重建容器即丢文件 */
export const UPLOAD_DIR_KEY = 'UPLOAD_DIR';

/** 上传目录默认值（相对启动工作目录） */
export const UPLOAD_DIR_DEFAULT = 'data/uploads';
