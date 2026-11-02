// 外部依赖
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
// 内部依赖
import { ReqId } from '../req/req.decorator.js';
import { AVATAR_MAX_BYTES } from '../storage/storage.constant.js';
import { AvatarService, UploadedImage } from './avatar.service.js';
import { UserId } from './user.decorator.js';

/**
 * 用户头像控制器
 *
 * 注：与 `UserController` 同为 `user` 前缀但类名不同 —— `ReqInterceptor` 按类名记账，
 * 重名会让两类请求在日志里分不开
 */
@Controller('user/avatar')
export class UserAvatarController {
  /**
   * 构造函数
   *
   * @param avatarSrv 头像服务
   */
  constructor(private readonly avatarSrv: AvatarService) {}

  /**
   * 上传头像
   *
   * 注：走内存存储（multer 默认），校验文件头后再落盘 —— 先落盘再校验会留下脏文件；
   * `limits.fileSize` 超限由 multer 抛 413，业务层的 400 只兜「刚好绕过限制」的情况
   *
   * @param file 上传的图片（表单字段名固定为 `file`）
   * @param userId 当前用户ID
   * @param reqId 请求日志ID
   * @returns 新的头像地址
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
    }),
  )
  upload(
    @UploadedFile() file: UploadedImage | undefined,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.avatarSrv.upload(file, userId, reqId);
  }
}
