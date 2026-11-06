// 外部依赖
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Not, Repository } from 'typeorm';
// 内部依赖
import { CommonService, OperateService, QueueService } from '@shared';
import { AliyunContactEntity, AliyunContactLogEntity } from './contact.entity.js';

/**
 * 申请联系人服务
 *
 * 注：CRUD 全部由 `CommonService` 提供（含变更日志与操作序号），这里只多一件 —— 维护「唯一默认项」
 */
@Injectable()
export class ContactService extends CommonService<
  AliyunContactEntity,
  AliyunContactLogEntity
> {
  protected name = 'contact';

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param contactRepository 联系人存储器
   * @param contactLogRepository 联系人日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(AliyunContactEntity)
    private readonly contactRepository: Repository<AliyunContactEntity>,
    @InjectRepository(AliyunContactLogEntity)
    private readonly contactLogRepository: Repository<AliyunContactLogEntity>,
  ) {
    super(operateSrv, queueSrv, contactRepository, contactLogRepository);
  }

  /**
   * 创建联系人
   *
   * 注：标记为默认时先把其它行的默认位清掉 —— 两步不在同一事务里，
   * 极端情况下会退化成「没有默认项」，这是可接受的（下拉会退回第一项）；
   * 反过来先写后清空则可能短暂出现两个默认项，更容易被误用
   *
   * @param value 创建信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 新联系人ID
   */
  override async create(
    value: Partial<AliyunContactEntity>,
    userId: number = 0,
    reqId: number = 0,
  ) {
    if (value.isDefault === true) {
      await this.clearDefault(0);
    }
    return super.create(value, userId, reqId);
  }

  /**
   * 更新联系人
   *
   * @param id 联系人ID
   * @param value 更新信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 联系人ID
   */
  override async update(
    id: number,
    value: Partial<AliyunContactEntity>,
    userId: number = 0,
    reqId: number = 0,
  ) {
    if (value.isDefault === true) {
      await this.clearDefault(id);
    }
    return super.update(id, value, userId, reqId);
  }

  /**
   * 清空其它联系人的默认位
   *
   * @param keepId 需要保留的ID，注：0 表示全部清空（新建默认项时用）
   */
  private async clearDefault(keepId: number): Promise<void> {
    await this.contactRepository.update(
      { isDefault: true, id: Not(keepId) } as FindOptionsWhere<AliyunContactEntity>,
      { isDefault: false },
    );
  }
}
