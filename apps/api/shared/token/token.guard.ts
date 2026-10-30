// 外部依赖
import {
  UnauthorizedException,
  ForbiddenException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AddressInfo } from 'net';
import { Response, Request } from 'express';
// 内部依赖
import { QueueService } from '../queue/queue.service.js';
import { RedisService } from '../redis/redis.service.js';
import { getClientIp } from '../req/req.decorator.js';
import { ReqEntity } from '../req/req.entity.js';
import { ReqService } from '../req/req.service.js';
import { TokenService } from './token.service.js';
import { UserService } from '../user/user.service.js';

/** 全局路由守卫
 *
 * 统一完成token令牌访问控制和权限点访问控制
 */
@Injectable()
export class TokenGuard implements CanActivate {
  private readonly logger = new Logger(TokenGuard.name);
  /**
   * 构造函数
   *
   * @param reflector 反射器
   * @param redisSrv Redis服务
   * @param reqSrv 请求日志服务
   * @param userSrv 用户服务
   * @param tokenSrv 令牌服务
   * @param queueSrv 队列服务
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly redisSrv: RedisService,
    private readonly reqSrv: ReqService,
    private readonly userSrv: UserService,
    private readonly tokenSrv: TokenService,
    private readonly queueSrv: QueueService,
  ) {}

  /**
   * 路由守卫函数
   *
   * @param context 执行上下文
   * @returns 守卫通过标记
   */
  async canActivate(context: ExecutionContext) {
    /** 请求时间 */
    const at = Date.now();
    /** 请求上下文 */
    const req: Request = context.switchToHttp().getRequest();
    /** 响应上下文 */
    const res: Response = context.switchToHttp().getResponse();
    /** 请求ID */
    const reqId = await this.redisSrv.incr('reqId');
    // 将请求ID添加到请求上下文
    req['reqId'] = reqId;
    /** 请求路径，注：使用 req.path 而非 req.url，避免 query string 混入日志记录导致无法按路径聚合与筛选 */
    const path = req.path;
    /** 请求客户端IP（真实公网IP） */
    const clientIp = getClientIp(req);
    this.logger.debug('clientIp', clientIp);
    res['ip'] = clientIp;
    /** 响应服务端信息 */
    const addressInfo = req.socket.address() as AddressInfo;
    /** 响应服务端IP */
    const serverIp = addressInfo.address;
    /** 控制器 */
    const controller = context.getClass().name;
    /** 方法名 */
    const action = context.getHandler().name;
    /** 组装请求日志参数 */
    let params = {
      reqId,
      userId: 0,
      url: path,
      controller,
      action,
      clientIp,
      serverIp,
      startAt: at,
    } as Partial<ReqEntity>;
    res['params'] = params;
    this.logger.debug('url', path, path.startsWith('/stock'));
    if (path.startsWith('/passport')) {
      // 返回验证通过
      return true;
    }
    /** 消息头中的令牌 */
    const tokenKey = req.headers.token as string;
    /** 缓存中的令牌 */
    const token = await this.tokenSrv.show(tokenKey);
    /** 用户ID */
    const userId = Number((token as { id: unknown }).id) || 0;
    params = { ...params, userId };
    /** 异常过滤处理 */
    const send = async (result: string, status: number = 401) => {
      /** 请求日志ID */
      await this.reqSrv.insert({
        ...params,
        // 注：使用入参状态码，401 与 403 各记各的，此前硬编码 401 会把 403 也记成 401
        status,
        endAt: Date.now(),
      });
      // 将请求ID设置到响应头
      res.setHeader('request_id', reqId);
      // 抛出异常。注：路由守卫抛出异常后，将不会再调用拦截器，请求也不会再转发到控制器
      if (status === 403) {
        throw new ForbiddenException(result);
      } else {
        throw new UnauthorizedException(result);
      }
    };
    // 如果用户ID无效，则令牌验证无效
    if (!userId) {
      await send('用户令牌验证无效！');
      return false;
    }
    const user = await this.userSrv.show(userId, 'status');
    if (!user) {
      await send(`用户ID${userId}验证无效！`);
      return false;
    }
    if (!user.status) {
      await send(`用户${user.username}已被禁用！`);
      return false;
    }
    // 用户身份已校验，更新用户的最后会话时间
    this.queueSrv.addTask(async () => {
      await this.userSrv.session(userId);
    });
    /** 当前路由需要角色，注：方法级声明优先于类级 */
    const roles = this.reflector.getAllAndOverride<string[]>('role', [
      context.getHandler(),
      context.getClass(),
    ]);
    // 当路由需要角色授权时，注：命中任意一个角色即视为通过
    if (roles?.length && !roles.some((role) => user?.roles?.includes(role))) {
      await send(`用户${user?.username}没有被授权访问该接口！`, 403);
      return false;
    }
    // 其余情况为验证通过，在请求上下文中记录用户信息
    req['user'] = user;
    // 返回验证通过
    return true;
  }
}
