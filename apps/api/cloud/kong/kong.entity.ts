// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '@shared';

/** KONG 网关站点基类 */
export abstract class KongBaseEntity {
  /** 实例名称 */
  @Column({ type: 'text', name: 'name', default: '', comment: '实例名称' })
  name!: string;

  /** 实例说明 */
  @Column({
    type: 'text',
    name: 'description',
    default: '',
    comment: '实例说明',
  })
  description!: string;

  /** Admin API 地址 */
  @Column({ type: 'text', name: 'url', default: '', comment: '接口地址' })
  url!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** KONG 网关站点表 */
@Entity('kongs')
export class KongEntity extends KongBaseEntity {
  /** 实例ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '实例ID' })
  id!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** KONG 网关站点变更日志表，注：结构与主表一致，由 CommonService 按操作序号整行搬入 */
@Entity('kongs_logs')
export class KongLogEntity extends KongBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 实例ID */
  @Column({ type: 'int', name: 'id', comment: '实例ID' })
  @Index()
  id!: number;
}
