// 外部依赖
import {
  UnprocessableEntityException,
  NotFoundException,
} from '@nestjs/common';
import { Repository, ObjectLiteral, FindOptionsWhere, MoreThan } from 'typeorm';

// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '../common/common.entity.js';
import { OperateService } from '../operate/operate.service.js';
import { QueueService } from '../queue/queue.service.js';

/** 配置对象实体 */
export type OptionEntity = ObjectLiteral & {
  /** 创建信息 */
  create?: CreateEntity;
  /** 更新信息 */
  update: UpdateEntity;
};

/** 配置对象日志实体 */
export type OptionEntityLog = ObjectLiteral & {
  /** 日志信息 */
  log: LogEntity;
  /** 创建信息 */
  create?: CreateEntity;
  /** 更新信息 */
  update: UpdateEntity;
};

/**
 * 配置对象基础服务
 *
 * @template Entity - 配置对象实体
 * @template EntityLog - 配置对象日志实体
 */
export abstract class OptionService<
  Entity extends OptionEntity,
  EntityLog extends OptionEntityLog,
> {
  /** 主键字段名 */
  protected abstract keyName: string;
  /** 对象名称 */
  protected abstract name: string;

  /**
   * 构造函数
   *
   * @param operateSrv 操作记录服务
   * @param queueSrv 队列服务
   * @param optionRepository 对象存储器
   * @param optionLogRepository 对象日志存储器
   */
  protected constructor(
    protected readonly operateSrv: OperateService,
    protected readonly queueSrv: QueueService,
    protected readonly optionRepository: Repository<Entity>,
    protected readonly optionLogRepository: Repository<EntityLog>,
  ) {}

  /**
   * 根据操作ID追加日志
   *
   * @param operateId 操作ID
   */
  protected addLog(operateId: number): void {
    this.queueSrv.addTask(async () => {
      const sourceTable = this.optionRepository.metadata.tableName;
      const logTable = this.optionLogRepository.metadata.tableName;
      const columns = this.optionLogRepository.metadata.columns
        .map((col) => `"${col.databaseName}"`)
        .filter((name) => name !== '"log_id"');
      const sql = `
      INSERT INTO "${logTable}" (${columns.join(', ')})
      SELECT ${columns.join(', ')}
      FROM "${sourceTable}"
      WHERE update_operate_id = $1`;
      await this.optionLogRepository.query(sql, [operateId]);
    });
  }

  /**
   * 获取对象清单
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 对象清单
   */
  async index(operateId: number = -1) {
    return this.optionRepository.findBy({
      update: {
        operateId: MoreThan(operateId),
      },
    } as FindOptionsWhere<Entity>);
  }

  /**
   * 获取对象记录数
   *
   * @returns 记录数
   */
  async count() {
    return this.optionRepository.count();
  }

  /**
   * 获取对象详情
   *
   * @param key 主键值
   * @returns 对象详情
   */
  async show(key: string) {
    return this.optionRepository.findOneBy({
      [this.keyName]: key,
    } as FindOptionsWhere<Entity>);
  }

  /**
   * 获取对象变更日志
   *
   * @param key 主键值
   * @returns 对象变更记录
   */
  async log(key: string) {
    return this.optionLogRepository.findBy({
      [this.keyName]: key,
    } as FindOptionsWhere<EntityLog>);
  }

  /**
   * 创建对象
   *
   * @param value 对象创建信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 新对象主键ID，如果创建失败则抛出异常
   */
  async create(value: Partial<Entity>, userId: number = 0, reqId: number = 0) {
    /** 对象存在标记 */
    const exist = await this.optionRepository.existsBy({
      [this.keyName]: value[this.keyName],
    } as FindOptionsWhere<Entity>);
    // 如果键值已存在，则抛出异常
    if (exist) {
      throw new UnprocessableEntityException(`主键已使用，无法创建对象！`);
    }
    /** 创建操作序号 */
    const operateId = await this.operateSrv.create(this.name, 'create', userId);
    /** 创建对象结果 */
    const result = await this.optionRepository.insert({
      ...value,
      create: { userId, at: Date.now() },
      update: {
        userId,
        operate: 'create',
        operateId,
        reqId,
        at: Date.now(),
      },
    });
    if (result.identifiers.length) {
      // 追加日志
      this.addLog(operateId);
      return {
        [this.keyName]: value[this.keyName],
      };
    }
    throw new UnprocessableEntityException(`对象创建失败！`);
  }

  /**
   * 更新对象
   *
   * @param key 主键值
   * @param value 对象信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 对象主键值
   */
  async update(
    key: string,
    value: Partial<Entity>,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 对象存在标记 */
    let exist = await this.optionRepository.existsBy({
      [this.keyName]: key,
    } as FindOptionsWhere<Entity>);
    // 如果原键值不存在，则抛出异常
    if (!exist) {
      throw new NotFoundException(`原对象主键不存在，无法更新！`);
    }
    // 如果主键值发生修改，需判断新键值是否已使用
    if (key !== value[this.keyName]) {
      exist = await this.optionRepository.existsBy({
        [this.keyName]: value[this.keyName],
      } as FindOptionsWhere<Entity>);
      // 如果新键值已存在，则抛出异常
      if (exist) {
        throw new UnprocessableEntityException(`新对象主键已存在，无法更新！`);
      }
    }
    /** 更新操作序号 */
    const operateId = await this.operateSrv.create(this.name, 'update', userId);
    /** 更新对象结果 */
    const result = await this.optionRepository.update(
      {
        [this.keyName]: key,
      } as FindOptionsWhere<Entity>,
      {
        ...value,
        update: {
          userId,
          operate: 'update',
          operateId,
          reqId,
          at: Date.now(),
        },
      },
    );
    if (result.affected) {
      // 异步追加日志
      this.addLog(operateId);
      return { [this.keyName]: value[this.keyName] };
    }
    throw new UnprocessableEntityException(`更新对象信息失败！`);
  }
}
