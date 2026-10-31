// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '@shared';
// 注：`emitDecoratorMetadata` + `isolatedModules` 下，装饰器签名里用到的类型必须走 `import type`
import type { KeyProvider } from './key.constant.js';

/** 云服务密钥基类 */
export abstract class KeyBaseEntity {
  /** 密钥名称 */
  @Column({ type: 'text', name: 'name', default: '', comment: '密钥名称' })
  name!: string;

  /** 密钥说明 */
  @Column({
    type: 'text',
    name: 'description',
    default: '',
    comment: '密钥说明',
  })
  description!: string;

  /** 云服务商 */
  @Column({ type: 'text', name: 'provider', comment: '云服务商' })
  provider!: KeyProvider;

  /** 访问密钥 ID */
  @Column({ type: 'text', name: 'key', comment: 'key' })
  key!: string;

  /** 访问密钥 Secret，注：只在服务端使用，任何接口都不下发浏览器 */
  @Column({ type: 'text', name: 'secret', comment: 'KeySecret' })
  secret!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** 云服务密钥表 */
@Entity('cloud_keys')
export class KeyEntity extends KeyBaseEntity {
  /** 密钥ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '密钥ID' })
  id!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** 云服务密钥变更日志表，注：结构与主表一致，由 CommonService 按操作序号整行搬入 */
@Entity('cloud_keys_logs')
export class KeyLogEntity extends KeyBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 密钥ID */
  @Column({ type: 'int', name: 'id', comment: '密钥ID' })
  @Index()
  id!: number;
}
