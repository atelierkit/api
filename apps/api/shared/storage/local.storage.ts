// 外部依赖
import { Logger } from '@nestjs/common';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
// 内部依赖
import { STATIC_URL_PREFIX } from './storage.constant.js';
import { storageRoot, toPublicUrl, toStoragePath } from './storage.util.js';

/**
 * 文件存储抽象
 *
 * 注：业务只依赖这个接口与「存储 key」，不关心文件落在本地磁盘还是对象存储 ——
 * 将来接入 S3（Garage / SeaweedFS）时只加一个实现，DB 与接口都不用动
 */
export interface FileStorage {
  /**
   * 写入文件
   *
   * @param key 存储 key
   * @param data 文件内容
   */
  put(key: string, data: Buffer): Promise<void>;

  /**
   * 删除文件，注：文件不存在不算失败
   *
   * @param key 存储 key
   */
  remove(key: string): Promise<void>;

  /**
   * 存储 key 转公开访问地址
   *
   * @param key 存储 key
   * @returns 公开访问地址
   */
  url(key: string): string;
}

/** 本地磁盘存储 */
export class LocalFileStorage implements FileStorage {
  private readonly logger = new Logger(LocalFileStorage.name);

  /**
   * 构造函数
   *
   * @param root 上传根目录，缺省取 `UPLOAD_DIR` 或 `data/uploads`
   */
  constructor(private readonly root: string = storageRoot()) {}

  /**
   * 写入文件
   *
   * 注：以 `wx` 打开，重名直接失败而不是覆盖 —— key 由 UUID 生成，出现重名说明调用方有问题，
   * 静默覆盖会让别人的头像变成这一张
   *
   * @param key 存储 key
   * @param data 文件内容
   */
  async put(key: string, data: Buffer): Promise<void> {
    /** 目标物理路径 */
    const target = toStoragePath(this.root, key);
    if (!target) {
      throw new Error(`非法的存储 key：${key}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx', mode: 0o644 });
  }

  /**
   * 删除文件
   *
   * @param key 存储 key
   */
  async remove(key: string): Promise<void> {
    /** 目标物理路径 */
    const target = toStoragePath(this.root, key);
    if (!target) {
      this.logger.warn(`跳过非法的存储 key：${key}`);
      return;
    }
    try {
      await unlink(target);
    } catch (error) {
      // 文件已被替换或手工删除时不算失败，其余错误只记日志，不影响业务
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`删除文件失败：${key}（${(error as Error).message}）`);
      }
    }
  }

  /**
   * 存储 key 转公开访问地址
   *
   * @param key 存储 key
   * @returns 公开访问地址
   */
  url(key: string): string {
    return toPublicUrl(key);
  }
}

/** 存储实现单例，注：当前只有本地实现，接入对象存储后按配置在这里切换 */
let instance: FileStorage | null = null;

/**
 * 获取文件存储实现
 *
 * @returns 文件存储实现
 */
export function fileStorage(): FileStorage {
  if (!instance) {
    instance = new LocalFileStorage();
  }
  return instance;
}

/**
 * 重置存储实现，注：仅供单元测试隔离使用
 */
export function resetFileStorage(): void {
  instance = null;
}

/** 静态资源前缀，注：`main.ts` 注册静态托管时用，与 `url()` 的产物必须一致 */
export const STATIC_PREFIX = STATIC_URL_PREFIX;
