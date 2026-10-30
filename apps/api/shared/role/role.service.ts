// 外部依赖
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// 内部依赖
import { OperateService } from '../operate/operate.service.js';
import { OptionService } from '../option/option.service.js';
import { QueueService } from '../queue/queue.service.js';
import { RoleEntity, RoleLogEntity } from './role.entity.js';

/** 默认管理员角色信息，注：该角色缺失时，系统将没有任何角色可通过管理员接口鉴权 */
const ADMIN_ROLE: Pick<
  RoleEntity,
  'id' | 'name' | 'description' | 'sort' | 'status'
> = {
  id: 'admin',
  name: '管理员',
  description: '超级管理员，默认拥有所有权限',
  sort: 1,
  status: true,
};

/** 角色服务 */
@Injectable()
export class RoleService
  extends OptionService<RoleEntity, RoleLogEntity>
  implements OnApplicationBootstrap
{
  protected keyName = 'id';
  protected name = 'role';
  /** 日志记录器 */
  private readonly logger = new Logger(RoleService.name);

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param roleRepository 产品存储器
   * @param roleLogRepository 产品日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(RoleEntity)
    protected readonly roleRepository: Repository<RoleEntity>,
    @InjectRepository(RoleLogEntity)
    protected readonly roleLogRepository: Repository<RoleLogEntity>,
  ) {
    super(operateSrv, queueSrv, roleRepository, roleLogRepository);
  }

  /**
   * 应用启动时初始化默认角色
   *
   * 注：管理员接口均以 admin 角色鉴权，数据库中缺少该角色时无人可以进入管理后台，
   * 因此启动时补建；初始化失败不影响服务启动，仅记录日志
   */
  async onApplicationBootstrap() {
    await this.initAdmin();
  }

  /**
   * 初始化默认管理员角色
   */
  private async initAdmin() {
    try {
      /** 管理员角色存在标记 */
      const exist = await this.roleRepository.existsBy({ id: ADMIN_ROLE.id });
      // 角色已存在，无需处理
      if (exist) {
        this.logger.debug(`默认管理员角色${ADMIN_ROLE.id}已存在，无需创建`);
        return;
      }
      await this.create({ ...ADMIN_ROLE }, 0, 0);
      this.logger.log(
        `数据库中缺少默认管理员角色，已自动创建：${ADMIN_ROLE.id}`,
      );
    } catch (error) {
      this.logger.error(
        `默认管理员角色${ADMIN_ROLE.id}初始化失败（不影响服务启动）：` +
          `${(error as Error).message}`,
      );
    }
  }

  /**
   * 角色排序
   *
   * @param values 排序后的角色信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 角色主键值
   */
  async sort(
    values: Partial<RoleEntity>[],
    userId: number = 0,
    reqId: number = 0,
  ) {
    const operateId = await this.operateSrv.create(this.name, 'sort', userId);
    await this.roleRepository.save(
      values.map((value) => ({
        ...value,
        update: {
          userId,
          operate: 'sort',
          operateId,
          reqId,
          at: Date.now(),
        },
      })),
    );
    return { length: values.length };
  }
}
