/** 用户名规则，注：小写字母、数字、下划线、短横线，长度 3-20，入库前统一转小写 */
export const USERNAME_RE = /^[a-z0-9_-]{3,20}$/;

/** 用户名最小长度 */
export const USERNAME_MIN = 3;

/** 用户名最大长度 */
export const USERNAME_MAX = 20;

/** 密码最小长度 */
export const PASSWORD_MIN = 8;

/** 密码最大长度 */
export const PASSWORD_MAX = 64;

/** scrypt 计算成本参数 N，注：必须是 2 的幂，16384 约 16MB 内存开销 */
export const SCRYPT_N = 16384;

/** scrypt 块大小参数 r */
export const SCRYPT_R = 8;

/** scrypt 并行度参数 p */
export const SCRYPT_P = 1;

/** scrypt 派生密钥长度（字节） */
export const SCRYPT_KEYLEN = 64;

/** scrypt 盐长度（字节） */
export const SCRYPT_SALT_BYTES = 16;

/** scrypt 内存上限，注：默认 32MB 对 N=16384/r=8 偏紧，显式放宽到 64MB */
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 登录失败次数上限，达到后锁定账号 */
export const LOGIN_FAIL_MAX = 5;

/** 登录失败计数有效期（秒） */
export const LOGIN_FAIL_TTL = 600;

/** 账号锁定有效期（秒） */
export const LOGIN_LOCK_TTL = 300;

/** 单 IP 每分钟登录请求上限 */
export const LOGIN_LIMIT_PER_MINUTE = 10;

/** 单 IP 每分钟用户名查重请求上限 */
export const CHECK_LIMIT_PER_MINUTE = 3;

/** 重置密码验证码有效期（分钟） */
export const RESET_VALID_MINUTES = 2;

/** 重置密码验证码最大尝试次数 */
export const RESET_FAIL_MAX = 5;

/** 系统允许的最大用户数 */
export const USER_MAX = 20;
