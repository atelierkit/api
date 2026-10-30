// 外部依赖
import {
  UnauthorizedException,
  Controller,
  Get,
  Post,
  Body,
} from '@nestjs/common';
// 内部依赖
import { RedisService } from '../redis/redis.service.js';
import { UserId } from '../user/user.decorator.js';

/** 快捷方式控制器 */
@Controller('shortcut')
export class ShortcutController {
  /**
   * 构造函数
   *
   * @param redisSrv 缓存服务服务
   */
  constructor(private readonly redisSrv: RedisService) {}

  /**
   * 获取快捷方式
   *
   * @param userId 用户ID
   * @returns 快捷方式列表
   */
  @Get()
  async show(@UserId() userId: number) {
    if (!userId) {
      throw new UnauthorizedException('用户未登录');
    }
    const result = await this.redisSrv.get(`shortcut:${userId}`);
    if (result) {
      return JSON.parse(result) as string[];
    }
    return [];
  }

  /**
   * 更新快捷方式
   *
   * @param shortcuts 邮箱
   * @param userId 用户ID
   * @returns 邮箱状态
   */
  @Post()
  async update(
    @Body('shortcuts') shortcuts: string[],
    @UserId() userId: number,
  ) {
    if (!userId) {
      throw new UnauthorizedException('用户未登录');
    }
    const result = await this.redisSrv.set(
      `shortcut:${userId}`,
      JSON.stringify(shortcuts),
    );
    return { result };
  }
}
