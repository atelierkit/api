// 外部依赖
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
// 内部依赖
import { SETUP_ALLOW_PATHS } from './setup.constant.js';
import { SetupService } from './setup.service.js';

/**
 * 初始化守卫
 *
 * 系统未初始化时，除白名单外的 passport 接口一律拒绝（428），
 * 保证「空库」状态下除了创建管理员之外什么都做不了
 *
 * 注：只拦 `/passport` 前缀 —— 其余路径的第一道关是令牌，空库发不出令牌，
 * 天然进不来，这样正常业务请求不必为初始化状态多付一次缓存查询
 */
@Injectable()
export class SetupGuard implements CanActivate {
  /**
   * 构造函数
   *
   * @param setupSrv 初始化服务
   */
  constructor(private readonly setupSrv: SetupService) {}

  /**
   * 路由守卫函数
   *
   * @param context 执行上下文
   * @returns 守卫通过标记
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    /** 请求上下文 */
    const req: Request = context.switchToHttp().getRequest();
    /** 请求路径 */
    const path = req.path;
    if (!path.startsWith('/passport')) {
      return true;
    }
    /** 路由标识 */
    const route = `${req.method.toUpperCase()} ${path}`;
    if (SETUP_ALLOW_PATHS.has(route)) {
      return true;
    }
    if (await this.setupSrv.ready()) {
      return true;
    }
    // 注：Nest 12 没有 PreconditionRequiredException 类，只能手抛 HttpException(428)
    throw new HttpException(
      '系统尚未初始化，请先创建管理员账号！',
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
}
