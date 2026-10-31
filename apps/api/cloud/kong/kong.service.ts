// 外部依赖
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// 内部依赖
import { CommonService, OperateService, QueueService } from '@shared';
import { KongEntity, KongLogEntity } from './kong.entity.js';
import { kongRequest } from './kong.request.js';
import type { KongInfo, KongStatus, KongSummary } from './kong.types.js';

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
   * 获取网关的版本与部署信息（`GET /`）
   *
   * @param id 站点ID
   * @returns 版本与部署信息
   */
  async info(id: number): Promise<KongInfo> {
    return kongRequest<KongInfo>(await this.url(id), '/');
  }

  /**
   * 获取网关运行状态（`GET /status`）
   *
   * @param id 站点ID
   * @returns 运行状态
   */
  async status(id: number): Promise<KongStatus> {
    return kongRequest<KongStatus>(await this.url(id), '/status');
  }

  /**
   * 获取网关概览
   *
   * 注 1：旧私有项目的仪表板读 `/default/license/report`，那是**企业版专属**接口，
   * 社区版返回 404 `{"message":"Not found"}`（已在本机 3.9.4 上实测）⇒ 整页永远是空的；
   * 这里改用社区版也提供的 `/`（版本、插件）与 `/status`（连接、数据库），合并成一份扁平结果
   * 注 2：两个请求并行发，任一失败都按原状态码抛出 —— 概览页宁可报错，也不要显示半真半假的数据
   *
   * @param id 站点ID
   * @returns 概览
   */
  async summary(id: number): Promise<KongSummary> {
    /** Admin API 地址，注：先解析一次，两个请求复用，避免查两遍库 */
    const base = await this.url(id);
    /** 版本信息与运行状态，注：并行请求 */
    const [info, status] = await Promise.all([
      kongRequest<KongInfo>(base, '/'),
      kongRequest<KongStatus>(base, '/status'),
    ]);
    return {
      version: info.version ?? '',
      edition: info.edition ?? '',
      hostname: info.hostname ?? '',
      nodeId: info.node_id ?? '',
      luaVersion: info.lua_version ?? '',
      pluginCount: Object.keys(info.plugins?.available_on_server ?? {}).length,
      enabledCount: info.plugins?.enabled_in_cluster?.length ?? 0,
      connectionsActive: status.server?.connections_active ?? 0,
      totalRequests: status.server?.total_requests ?? 0,
      // 注：无数据库模式下正文里没有 database 这一段，此时给 null（不适用）而不是 false（不可达）
      dbReachable: status.database ? (status.database.reachable ?? false) : null,
    };
  }

  /**
   * 获取网关已启用的插件清单
   *
   * 注：`GET /plugins/enabled` 的返回形态随版本不同 —— Kong 3.x 返回
   * `{ enabled_plugins: [...] }`（本机 3.9.4 实测），2.x 直接返回数组；
   * 这里统一成 `string[]`，调用方不用各自判断
   *
   * @param id 站点ID
   * @returns 插件名清单
   */
  async plugin(id: number): Promise<string[]> {
    /** 响应正文 */
    const body = await kongRequest<unknown>(await this.url(id), '/plugins/enabled');
    if (Array.isArray(body)) {
      return body.map(String);
    }
    /** 3.x 的清单 */
    const list = (body as { enabled_plugins?: unknown } | null)?.enabled_plugins;
    return Array.isArray(list) ? list.map(String) : [];
  }
}
