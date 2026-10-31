// 外部依赖
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// 内部依赖
import { CommonService, OperateService, QueueService } from '@shared';
import { KongEntity, KongLogEntity } from './kong.entity.js';
import { kongRequest } from './kong.request.js';

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
    return kongRequest(await this.url(id), '/default/license/report');
  }

  /**
   * 获取网关已启用的插件清单
   *
   * @param id 站点ID
   * @returns 插件清单
   */
  async plugin(id: number) {
    return kongRequest(await this.url(id), '/plugins/enabled');
  }
}
