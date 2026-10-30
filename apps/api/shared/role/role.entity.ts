// 外部依赖
import { Entity, Column, PrimaryColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '../common/common.entity.js';

/** 角色基类表 */
export abstract class RoleBaseEntity {
  /** 名称 */
  @Column({ type: 'text', name: 'name', default: '', comment: '名称' })
  name!: string;

  /** 描述 */
  @Column({ type: 'text', name: 'description', default: '', comment: '描述' })
  description!: string;

  /** 排序 */
  @Column({ type: 'int', name: 'sort', default: 0, comment: '排序' })
  sort!: number;

  /** 状态，true表示可用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** 角色表 */
@Entity('roles')
export class RoleEntity extends RoleBaseEntity {
  /** id */
  @PrimaryColumn({ type: 'text', name: 'id', comment: 'id' })
  id!: string;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** 角色日志表 */
@Entity('roles_logs')
export class RoleLogEntity extends RoleBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** id */
  @Column({ type: 'text', name: 'id', comment: 'id' })
  id!: string;
}
