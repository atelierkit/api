// 外部依赖
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { tap, catchError } from 'rxjs';
// 内部依赖
import { AppRequest } from '../common/request.types.js';
import { QueueService } from '../queue/queue.service.js';
import { ReqEntity } from './req.entity.js';
import { ReqService } from './req.service.js';

/** 全局拦截器
 *
 * 给响应报文加上请求标记，并发出响应，发送记录日志任务
 */
@Injectable()
export class ReqInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ReqInterceptor.name);
  /**
   * 构造函数
   *
   * @param reqSrv 请求日志服务
   * @param queueSrv 队列服务
   */
  constructor(
    private readonly reqSrv: ReqService,
    private readonly queueSrv: QueueService,
  ) {}

  /**
   * 拦截器函数
   *
   * @param context 处理上下文
   * @param next 函数处理后
   * @returns 响应报文可观察者
   */
  intercept(context: ExecutionContext, next: CallHandler) {
    /**
     * 更新请求日志的用户ID，请求内容和响应内容
     * 1、异步处理，避免影响响应效率
     * 2、用户ID在登录验证等请求时，无法在路由守卫阶段获得，只能在业务处理逻辑中获得，所以需要在此处再次更新
     * 3、请求内容可能存在敏感数据，需要在业务处理逻辑中脱敏，所以需要在此处更新
     * 4、响应内容只能在业务处理逻辑完成后得到，所以在此处更新
     * 5、响应报文有时候也需要脱敏，需要注意处理逻辑
     */
    /** 请求上下文 */
    const req: Request = context.switchToHttp().getRequest();
    /** 响应上下文 */
    const res: Response = context.switchToHttp().getResponse();
    this.logger.debug('reqId', req['reqId']);
    if (req['reqId']) {
      res.setHeader('request_id', Number(req['reqId']));
    }
    const params = (res['params'] || {}) as Partial<ReqEntity>;
    return next.handle().pipe(
      // 请求异常时的处理
      catchError((err) => {
        const appReq = req as AppRequest;
        if (appReq.reqId) {
          /** 更新日志记录 */
          this.queueSrv.addTask(() =>
            this.reqSrv.insert({
              ...params,
              // 注：非 HttpException 的异常没有 status，此前会取到 undefined 并被实体默认值
              // 吞成 200（把 500 记成成功），此处兜底为 500
              status: (err as { status?: number })?.status ?? 500,
              endAt: Date.now(),
            }),
          );
        }
        throw err;
      }),
      // 请求正常时的处理
      tap(() => {
        const appReq = req as AppRequest;
        /** 更新日志记录 */
        if (appReq.reqId) {
          this.queueSrv.addTask(() =>
            this.reqSrv.insert({
              ...params,
              status: res.statusCode,
              endAt: Date.now(),
            }),
          );
        }
      }),
    );
  }
}
