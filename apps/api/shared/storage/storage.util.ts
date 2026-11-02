// 外部依赖
import { join, resolve, sep } from 'node:path';
// 内部依赖
import type { AvatarExtension } from './storage.constant.js';
import {
  STATIC_URL_PREFIX,
  UPLOAD_DIR_DEFAULT,
  UPLOAD_DIR_KEY,
} from './storage.constant.js';

/**
 * 解析上传根目录
 *
 * 注：一律返回绝对路径 —— `express.static` 与 `fs` 对相对路径的解释依赖当前工作目录，
 * 容器内与开发态的工作目录不同，用相对路径会出现「开发能看、容器 404」
 *
 * @returns 上传根目录的绝对路径
 */
export function storageRoot(): string {
  /** 环境变量中的目录 */
  const dir = (process.env[UPLOAD_DIR_KEY] ?? '').trim();
  return resolve(dir || join(process.cwd(), UPLOAD_DIR_DEFAULT));
}

/**
 * 嗅探图片真实格式
 *
 * 注：只认文件头，**不信** 客户端提交的 `mimetype` 与文件名（两者都可伪造）；
 * 无法识别时返回 `null`，由调用方转 400
 *
 * @param buffer 文件内容
 * @returns 识别到的扩展名，无法识别时为 null
 */
export function sniffImageExtension(buffer: Buffer): AvatarExtension | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG：FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  // WebP：RIFF....WEBP（第 1~4 字节为长度，与内容无关）
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * 判断是否为外部地址
 *
 * 注：历史数据里可能存在直接粘贴的图床地址，这类值不做任何改写
 *
 * @param value 头像字段值
 * @returns 是外部地址时为 true
 */
export function isExternalUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value);
}

/**
 * 判断存储 key 是否安全
 *
 * 注：key 会拼进磁盘路径，必须挡掉 `..`、反斜杠、绝对路径与空段，
 * 否则 `avatar/../../etc/passwd` 这类值可以读写上传根之外的文件
 *
 * @param key 存储 key
 * @returns 安全时为 true
 */
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || key.trim() === '' || key.length > 255) {
    return false;
  }
  // 反斜杠（Windows 下的路径分隔符）与控制字符：后者用码点判断，
  // 避免在正则里写控制字符区间（`no-control-regex` 会告警）
  if (key.includes('\\')) {
    return false;
  }
  if (Array.from(key).some((ch) => ch.charCodeAt(0) < 0x20)) {
    return false;
  }
  if (key.startsWith('/')) {
    return false;
  }
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * 存储 key 转物理路径
 *
 * @param root 上传根目录（绝对路径）
 * @param key 存储 key
 * @returns 物理路径，key 非法或越出根目录时为 null
 */
export function toStoragePath(root: string, key: string): string | null {
  if (!isSafeKey(key)) {
    return null;
  }
  /** 根目录绝对路径，注：先归一化，传相对路径时前缀比较才不会两边不一致 */
  const base = resolve(root);
  /** 目标绝对路径 */
  const target = resolve(base, ...key.split('/'));
  /** 根目录前缀（带分隔符，避免 `/data/uploads2` 被当成 `/data/uploads` 的子路径） */
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return target.startsWith(prefix) ? target : null;
}

/**
 * 存储 key 转公开访问地址
 *
 * 注：对外下发一律是「后端可达绝对路径或完整外链」，前端再拼 `baseUrl`；
 * 空值返回空串，交由前端回退到首字符头像
 *
 * @param key 存储 key（或历史遗留的外链）
 * @returns 公开访问地址
 */
export function toPublicUrl(key: string | null | undefined): string {
  /** 归一化后的值 */
  const value = (key ?? '').trim();
  if (value === '') {
    return '';
  }
  // 历史外链与已拼好的地址原样返回，避免二次拼接
  if (isExternalUrl(value) || value.startsWith('/')) {
    return value;
  }
  return `${STATIC_URL_PREFIX}${value}`;
}

/**
 * 公开地址反解为存储 key
 *
 * 注：仅用于「删除被替换的旧头像」，外链（别人图床上的图）绝不能删，
 * 因此解析不出本地 key 时返回 null，调用方直接跳过
 *
 * @param url 头像字段值（可能是外链、`/static/...` 或裸 key）
 * @returns 存储 key，非本地文件时为 null
 */
export function toStorageKey(url: string | null | undefined): string | null {
  /** 归一化后的值 */
  const value = (url ?? '').trim();
  if (value === '' || isExternalUrl(value)) {
    return null;
  }
  /** 去掉公开前缀后的 key */
  if (value.startsWith(STATIC_URL_PREFIX)) {
    const key = value.slice(STATIC_URL_PREFIX.length);
    return isSafeKey(key) ? key : null;
  }
  // 其它以 `/` 开头的站内路径（历史数据里手填的地址）不是本服务托管的文件：
  // 既不能当 key 去拼磁盘路径，也不能在换头像时被删掉
  if (value.startsWith('/')) {
    return null;
  }
  return isSafeKey(value) ? value : null;
}
