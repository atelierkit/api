// 外部依赖
import {
  Controller,
  Get,
  Post,
  Delete,
  Headers,
  Body,
  Req,
} from '@nestjs/common';

// 内部依赖
import { RedisService } from '../redis/redis.service.js';
import { ClientIp, ReqId } from '../req/req.decorator.js';
import { TokenService } from '../token/token.service.js';
import { UserId } from './user.decorator.js';
import { TokenValidDto, PasswordDto, UserUpdateDto } from './user.dto.js';
import { UserService } from './user.service.js';
import type { AppRequest } from '../common/request.types.js';

/** 已登录用户控制器 */
@Controller('user')
export class UserController {
  /**
   * 构造函数
   *
   * @param userSrv 用户服务
   * @param tokenSrv 令牌服务
   * @param redisSrv Redis服务
   */
  constructor(
    private readonly userSrv: UserService,
    private readonly tokenSrv: TokenService,
    private readonly redisSrv: RedisService,
  ) {}

  /**
   * 已登录初始化
   *
   * @param userId 用户ID
   * @returns 用户信息
   */
  @Get('startup')
  async startup(@UserId() userId: number) {
    return this.userSrv.show(userId, 'startup');
  }

  /**
   * 获取用户IP
   *
   * @param req 请求上下文
   * @returns IP地址
   */
  @Get('ip')
  ip(@Req() req: AppRequest) {
    return { ip: req.ip };
  }

  /**
   * 获取用户信息
   *
   * @param userId 用户ID
   * @returns 新令牌
   */
  @Get('show')
  async show(@UserId() userId: number) {
    return this.userSrv.show(userId);
  }

  /**
   * 获取用户导航信息（注：分类与产品已移除，当前只返回快捷方式）
   *
   * @param userId 用户ID
   * @returns 新令牌
   */
  @Get('nav')
  async nav(@UserId() userId: number) {
    const result = await this.redisSrv.get(`shortcut:${userId}`);
    const orders = result ? (JSON.parse(result) as string[]) : [];
    return { orders };
  }

  /**
   * 刷新令牌
   *
   * 注：有效期以用户设置为准，不接受客户端指定，避免绕过用户的登录有效期设置
   *
   * @param token 原令牌
   * @param userId 用户ID
   * @returns 新令牌
   */
  @Post('refresh')
  async refresh(@Headers('token') token: string, @UserId() userId: number) {
    /** 用户在设置中指定的令牌有效期 */
    const valid = await this.userSrv.valid(userId);
    return this.tokenSrv.refresh(userId, token, valid);
  }

  /**
   * 设置登录令牌有效期
   *
   * 注：设置值作为后续登录的默认有效期，并在本次请求中立即应用到当前令牌
   *
   * @param body 有效期设置信息
   * @param token 当前令牌
   * @param userId 用户ID
   * @param reqId 请求ID
   * @returns 新令牌
   */
  @Post('valid')
  async valid(
    @Body() body: TokenValidDto,
    @Headers('token') token: string,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    // 先落库为用户的默认有效期，再按新有效期刷新当前令牌
    /** 设置后的令牌有效期 */
    const valid = await this.userSrv.setValid(userId, body.valid, reqId);
    return this.tokenSrv.refresh(userId, token, valid);
  }

  /**
   * 更新用户信息
   *
   * @param body 更新信息
   * @param userId 用户ID
   * @param reqId 请求ID
   * @returns 用户ID
   */
  @Post('update')
  update(
    @Body() body: UserUpdateDto,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.userSrv.update(userId, body, userId, reqId);
  }

  /**
   * 修改登录密码
   *
   * 注：保留当前令牌、作废其它会话，避免改密把自己踢下线
   *
   * @param body 改密信息
   * @param token 当前令牌
   * @param userId 用户ID
   * @param reqId 请求ID
   * @returns 响应报文
   */
  @Post('password')
  password(
    @Body() body: PasswordDto,
    @Headers('token') token: string,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.userSrv.password(userId, body, token, reqId);
  }

  /**
   * 修改绑定邮箱
   *
   * @param email 邮箱地址
   * @param userId 用户ID
   * @param ip 客户端IP
   * @returns 用户ID
   */
  @Post('email')
  email(
    @Body('email') email: string,
    @UserId() userId: number,
    @ClientIp() ip: string,
  ) {
    return this.userSrv.email(userId, email, ip);
  }

  /**
   * 退出登录
   *
   * @param token 待作废的令牌
   * @returns 作废令牌数
   */
  @Delete('logout')
  destroy(@Headers('token') token: string) {
    return this.tokenSrv.destroy(token);
  }
}
