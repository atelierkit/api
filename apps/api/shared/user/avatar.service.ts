// 外部依赖
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
// 内部依赖
import { fileStorage } from '../storage/local.storage.js';
import { AVATAR_KEY_PREFIX, AVATAR_MAX_BYTES } from '../storage/storage.constant.js';
import { sniffImageExtension } from '../storage/storage.util.js';
import { UserService } from './user.service.js';

/** 上传的图片（multer 内存存储产物的最小契约，不引 @types/multer 也能编译） */
export interface UploadedImage {
  /** 文件内容 */
  buffer: Buffer;
  /** 字节数，注：由 multer 按 `limits.fileSize` 截断前计算 */
  size: number;
  /** 客户端声明的 MIME，注：仅用于日志，校验一律走文件头 */
  mimetype?: string;
  /** 原始文件名，注：绝不用于落盘路径 */
  originalname?: string;
}

/** 头像服务 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  /**
   * 构造函数
   *
   * @param userSrv 用户服务
   */
  constructor(private readonly userSrv: UserService) {}

  /**
   * 上传头像
   *
   * 注：先写文件再落库；落库失败时把刚写入的文件删掉，避免留下无人引用的孤儿文件
   *
   * @param file 上传的图片
   * @param userId 当前用户ID
   * @param reqId 请求日志ID
   * @returns 可直接用于 `<img>` 的公开访问地址
   * @throws BadRequestException 文件缺失、超限或格式不受支持时抛出
   */
  async upload(
    file: UploadedImage | undefined,
    userId: number,
    reqId: number = 0,
  ): Promise<{ avatar: string }> {
    if (!file || !file.buffer?.length) {
      throw new BadRequestException('请选择要上传的图片！');
    }
    if (file.size > AVATAR_MAX_BYTES) {
      throw new BadRequestException(
        `图片不能超过${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)}MB！`,
      );
    }
    /** 文件头识别出的扩展名 */
    const ext = sniffImageExtension(file.buffer);
    if (!ext) {
      throw new BadRequestException('仅支持 PNG、JPEG、WebP 格式的图片！');
    }
    /** 存储 key，注：UUID 命名，不含用户信息与原始文件名（静态资源免令牌访问，靠不可猜测兜底） */
    const key = `${AVATAR_KEY_PREFIX}${randomUUID()}.${ext}`;
    /** 存储实现 */
    const storage = fileStorage();
    await storage.put(key, file.buffer);
    try {
      // 落库只存 key，域名与访问前缀由 `url()` 拼，换存储实现时数据不用迁移
      await this.userSrv.update(userId, { avatar: key }, userId, reqId);
    } catch (error) {
      await storage.remove(key);
      throw error;
    }
    this.logger.log(
      `用户 ${userId} 更新头像：${key}（${file.buffer.length} 字节，声明类型 ${file.mimetype ?? '未知'}）`,
    );
    return { avatar: storage.url(key) };
  }
}
