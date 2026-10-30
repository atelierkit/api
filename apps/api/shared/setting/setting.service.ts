// 外部依赖
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// 内部依赖
import { OperateService } from '../operate/operate.service.js';
import { OptionService } from '../option/option.service.js';
import { QueueService } from '../queue/queue.service.js';
import { SettingEntity, SettingLogEntity } from './setting.entity.js';

/** 配置服务 */
@Injectable()
export class SettingService extends OptionService<
  SettingEntity,
  SettingLogEntity
> {
  protected keyName = 'code';
  protected name = 'setting';
  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param settingRepository 配置存储器
   * @param settingLogRepository 配置日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(SettingEntity)
    protected readonly settingRepository: Repository<SettingEntity>,
    @InjectRepository(SettingLogEntity)
    protected readonly settingLogRepository: Repository<SettingLogEntity>,
  ) {
    super(operateSrv, queueSrv, settingRepository, settingLogRepository);
  }
}
