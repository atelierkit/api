// 外部依赖
import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// 内部依赖
import { CommonService, OperateService, QueueService } from '@shared';
import { KongEntity, KongLogEntity } from './kong.entity.js';

/** Admin API 请求超时（毫秒），注：网关不可达时必须尽快失败，不能让浏览器一直挂着 */
const TIMEOUT = 10000;

/** KONG 网关站点服务 */
@Injectable()
export class KongService extends CommonService<KongEntity, KongLogEntity> {
  protected name = 'kong';

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param kongRepository 站点存储器
   * @param kongLogRepository 站点日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(KongEntity)
    private readonly kongRepository: Repository<KongEntity>,
    @InjectRepository(KongLogEntity)
    private readonly kongLogRepository: Repository<KongLogEntity>,
  ) {
    super(operateSrv, queueSrv, kongRepository, kongLogRepository);
  }

  /**
   * 获取站点的 Admin API 地址
   *
   * @param id 站点ID
   * @returns Admin API 地址
   */
  async url(id: number) {
    /** 站点 */
    const kong = await this.show(id);
    if (kong === null) {
      throw new NotFoundException('指定网关不存在！');
    }
    return kong.url;
  }

  /**
   * 获取网关许可报告
   *
   * @param id 站点ID
   * @returns 许可报告
   */
  async report(id: number) {
    return this.request(await this.url(id), '/default/license/report');
  }

  /**
   * 获取网关已启用的插件清单
   *
   * @param id 站点ID
   * @returns 插件清单
   */
  async plugin(id: number) {
    return this.request(await this.url(id), '/plugins/enabled');
  }

  /**
   * 请求 Admin API
   *
   * 注：旧私有项目用 `@nestjs/axios` + `validateStatus` 兜住所有状态码，这里改用运行时自带的
   * `fetch`（Node 18+），不引新依赖，语义一致：非 2xx 不抛网络错，由本方法按状态码转成
   * `HttpException` 原样透传给前端，避免网关的 401/404 被吞成 500
   *
   * @param base 站点 Admin API 地址
   * @param path 接口路径，以 `/` 开头
   * @returns 响应正文
   */
  private async request(base: string, path: string): Promise<unknown> {
    /** 目标地址，注：库里存的地址可能带结尾斜杠，统一去掉再拼，避免出现 `//plugins` */
    const target = `${base.replace(/\/+$/, '')}${path}`;
    /** 网关响应 */
    let response: Response;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      throw new HttpException(
        `网关请求失败：${err instanceof Error ? err.message : String(err)}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    /** 响应正文，注：Kong 正常返回 JSON，出错时返回 `{ message }` */
    const text = await response.text();
    /** 解析后的正文 */
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON 正文（如反向代理的 HTML 错误页）原样带回，交给下面的 message 兜底
    }
    if (!response.ok) {
      throw new HttpException(
        this.messageOf(body, response.statusText),
        response.status,
      );
    }
    return body;
  }

  /**
   * 提取错误信息
   *
   * @param body 响应正文
   * @param fallback 兜底文案
   * @returns 可直接展示的错误信息
   */
  private messageOf(body: unknown, fallback: string): string {
    if (body !== null && typeof body === 'object' && 'message' in body) {
      return String((body as { message: unknown }).message);
    }
    if (typeof body === 'string' && body.trim() !== '') {
      return body;
    }
    return fallback || '网关请求失败！';
  }
}
