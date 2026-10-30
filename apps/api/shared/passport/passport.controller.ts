// 外部依赖
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Req,
} from '@nestjs/common';
// 内部依赖
import type { AppRequest } from '../common/request.types.js';
import { ClientIp, ReqId } from '../req/req.decorator.js';
import { SettingService } from '../setting/setting.service.js';
import { SetupDto } from '../setup/setup.dto.js';
import { SetupService } from '../setup/setup.service.js';
import {
  CheckDto,
  LoginDto,
  RegisterDto,
  ResetCodeDto,
  ResetDto,
} from '../user/user.dto.js';
import { UserService } from '../user/user.service.js';

/** 未登录用户控制器 */
@Controller('passport')
export class PassportController {
  /**
   * 构造函数
   *
   * @param userSrv 用户服务
   * @param setupSrv 初始化服务
   * @param settingSrv 配置服务服务
   */
  constructor(
    private readonly userSrv: UserService,
    private readonly setupSrv: SetupService,
    private readonly settingSrv: SettingService,
  ) {}

  /**
   * 获取应用配置
   *
   * @returns 应用信息
   */
  @Get('app')
  async app(): Promise<unknown> {
    const result = await this.settingSrv.show('app');
    if (result) {
      return result.value;
    }
    return { name: '个人管理工具', description: '个人用管理工具' };
  }

  /**
   * 获取ICP配置
   *
   * @returns ICP信息
   */
  @Get('icp')
  async icp(): Promise<unknown> {
    const result = await this.settingSrv.show('icp');
    if (result) {
      return result.value;
    }
    return { owner: '个人站点', icp: '暂未申请' };
  }

  /**
   * 获取初始化状态
   *
   * 注：只返回布尔值，不暴露用户数、初始化时间等细节
   *
   * @returns 初始化状态
   */
  @Get('init')
  async init(): Promise<{ initialized: boolean }> {
    return { initialized: await this.setupSrv.ready() };
  }

  /**
   * 初始化管理员账号
   *
   * 注：仅在系统未初始化时可用，成功后直接返回令牌（等同完成登录）
   *
   * @param value 管理员信息
   * @param token 初始化凭据，注：请求头 X-Setup-Token
   * @param req 请求上下文，注：用于取直连对端地址做来源校验
   * @param ip 客户端IP
   * @param reqId 请求ID
   * @returns 令牌信息
   */
  @Post('setup')
  setup(
    @Body() value: SetupDto,
    @Headers('x-setup-token') token: string,
    @Req() req: AppRequest,
    @ClientIp() ip: string,
    @ReqId() reqId: number,
  ) {
    // 直连对端地址，注：不能用 X-Forwarded-For，客户端可自填
    const peerIp = req.socket?.remoteAddress ?? '';
    return this.setupSrv.setup(value, token, peerIp, ip, reqId);
  }

  /**
   * 用户名密码登录
   *
   * @param value 登录信息
   * @param ip 客户端IP
   * @param reqId 请求ID
   * @returns 令牌信息
   */
  @Post('login')
  login(
    @Body() value: LoginDto,
    @ClientIp() ip: string,
    @ReqId() reqId: number,
  ) {
    return this.userSrv.login(value, reqId, ip);
  }

  /**
   * 用户名查重
   *
   * 注：仅供注册/初始化页面使用，避免重复提交后才知道重名
   *
   * @param value 用户名
   * @param ip 客户端IP
   * @returns 查重结果
   */
  @Post('check')
  check(@Body() value: CheckDto, @ClientIp() ip: string) {
    return this.userSrv.check(value.username, ip);
  }

  /**
   * 发送重置密码验证码
   *
   * @param value 邮箱
   * @param ip 客户端IP
   * @returns 响应报文
   */
  @Post('reset')
  resetCode(@Body() value: ResetCodeDto, @ClientIp() ip: string) {
    return this.userSrv.sendResetCode(value.email, ip);
  }

  /**
   * 通过邮箱验证码重置密码
   *
   * @param value 重置信息
   * @param reqId 请求ID
   * @returns 响应报文
   */
  @Post('reset/confirm')
  reset(@Body() value: ResetDto, @ReqId() reqId: number) {
    return this.userSrv.reset(value, reqId);
  }

  /**
   * 用户注册
   *
   * 注：默认关闭（ALLOW_SIGNUP 未置为 true 时返回 410），账号由管理员或初始化流程创建
   *
   * @param value 注册信息
   * @param reqId 请求ID
   * @param ip 客户端IP
   * @returns 用户ID
   */
  @Post('register')
  register(
    @Body() value: RegisterDto,
    @ReqId() reqId: number,
    @ClientIp() ip: string,
  ) {
    return this.userSrv.register(value, reqId, ip);
  }

  /**
   * 校验激活码
   *
   * @param code 激活码
   * @param reqId 请求ID
   * @returns 校验结果
   */
  @Post('activate')
  activate(@Body('code') code: string, @ReqId() reqId: number) {
    if (!code) {
      throw new BadRequestException(`请输入有效的激活码！`);
    }
    return this.userSrv.activate(code, reqId);
  }
}
