// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '@shared';

/**
 * 申请联系人基类
 *
 * 注 1：这些字段就是`CreateDVOrderAudit` 要求手填的那几项 —— 每次申请都重新输一遍既慢又易错
 * （省市要拼音、手机号有格式要求），故落库成可复用的备选
 * 注 2：手机号与邮箱**明文存储**。它们不是访问凭据，加密反而会让「申请时下拉选联系人」每次都要解密，
 * 收益被抵消；脱敏放在前端展示层（见 `web` 侧的联系人页）
 */
export abstract class ContactBaseEntity {
  /** 备注名，如「个人」「公司」 */
  @Column({ type: 'text', name: 'name', default: '', comment: '备注名' })
  name!: string;

  /** 申请人姓名 */
  @Column({ type: 'text', name: 'username', comment: '申请人姓名' })
  username!: string;

  /** 申请人邮箱 */
  @Column({ type: 'text', name: 'email', comment: '申请人邮箱' })
  email!: string;

  /** 申请人手机号 */
  @Column({ type: 'text', name: 'phone', comment: '申请人手机号' })
  phone!: string;

  /** 省份（拼音） */
  @Column({ type: 'text', name: 'province', default: '', comment: '省份' })
  province!: string;

  /** 城市（拼音） */
  @Column({ type: 'text', name: 'city', default: '', comment: '城市' })
  city!: string;

  /** 是否默认项，注：全局只允许一项为 true，由 `ContactService` 在写入时互斥维护 */
  @Column({
    type: 'bool',
    name: 'is_default',
    default: false,
    comment: '是否默认联系人',
  })
  isDefault!: boolean;

  /** 启用状态，注：停用的不进入申请下拉 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** 申请联系人表 */
@Entity('aliyun_contacts')
export class AliyunContactEntity extends ContactBaseEntity {
  /** 联系人ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '联系人ID' })
  id!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** 申请联系人变更日志表，注：结构与主表一致，由 `CommonService` 按操作序号整行搬入 */
@Entity('aliyun_contacts_logs')
export class AliyunContactLogEntity extends ContactBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 联系人ID */
  @Column({ type: 'int', name: 'id', comment: '联系人ID' })
  @Index()
  id!: number;
}
