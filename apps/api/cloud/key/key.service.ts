// 外部依赖
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsSelect,
  FindOptionsWhere,
  MoreThan,
  Repository,
} from 'typeorm';
// 内部依赖
import { CommonService, OperateService, QueueService } from '@shared';
import { KeyEntity, KeyLogEntity } from './key.entity.js';

/**
 * 对外可见的密钥字段
 *
 * 注：**不含 `secret`** —— 访问密钥 Secret 只在服务端内部使用（调用云厂商接口时取），
 * 任何接口都不下发浏览器，否则等于把云账号交出去
 */
const PUBLIC_SELECT = [
  'id',
  'name',
  'description',
  'provider',
  'key',
  'status',
  'create.userId',
  'create.at',
  'update.userId',
  'update.operate',
  'update.operateId',
  'update.reqId',
  'update.at',
] as FindOptionsSelect<KeyEntity>;

/** 云服务密钥服务 */
@Injectable()
export class KeyService extends CommonService<KeyEntity, KeyLogEntity> {
  protected name = 'key';

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param keyRepository 密钥存储器
   * @param keyLogRepository 密钥日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(KeyEntity)
    private readonly keyRepository: Repository<KeyEntity>,
    @InjectRepository(KeyLogEntity)
    private readonly keyLogRepository: Repository<KeyLogEntity>,
  ) {
    super(operateSrv, queueSrv, keyRepository, keyLogRepository);
  }

  /**
   * 获取密钥清单
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 密钥清单，注：不含 secret
   */
  async index(operateId: number = -1) {
    return this.keyRepository.find({
      select: PUBLIC_SELECT,
      where: {
        update: { operateId: MoreThan(operateId) },
      } as FindOptionsWhere<KeyEntity>,
      order: { id: 'ASC' },
    });
  }

  /**
   * 获取密钥详情
   *
   * @param id 密钥ID
   * @returns 密钥详情，注：不含 secret
   */
  async show(id: number) {
    return this.keyRepository.findOne({
      select: PUBLIC_SELECT,
      where: { id } as FindOptionsWhere<KeyEntity>,
    });
  }

  /**
   * 获取密钥 Secret
   *
   * 注：仅供服务端内部调用（如云厂商接口鉴权），**不要**接到任何 HTTP 接口上
   *
   * @param id 密钥ID
   * @returns 密钥 Secret，不存在时为 null
   */
  async secret(id: number) {
    /** 密钥 */
    const key = await this.keyRepository.findOne({
      select: ['id', 'secret'] as FindOptionsSelect<KeyEntity>,
      where: { id } as FindOptionsWhere<KeyEntity>,
    });
    return key?.secret ?? null;
  }
}
