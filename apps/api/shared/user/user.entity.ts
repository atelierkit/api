// 外部依赖
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  AfterLoad,
} from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '../common/common.entity.js';
import { TOKEN_VALID_DEFAULT } from '../token/token.constant.js';

/** 用户表基类 */
export abstract class UserBaseEntity {
  /** 登录用户名，注：入库前统一 trim + 转小写，唯一性由 users 表上的唯一索引保证 */
  @Column({ type: 'text', name: 'username', default: '', comment: '登录用户名' })
  username!: string;

  /** 昵称 */
  @Column({ type: 'text', name: 'name', default: '', comment: '昵称' })
  name!: string;

  /** 头像URL */
  @Column({ type: 'text', name: 'avatar', default: '', comment: '头像URL' })
  avatar!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 用户授权角色 */
  @Column({
    type: 'text',
    name: 'roles',
    default: [],
    array: true,
    comment: '用户授权角色',
  })
  roles!: string[];

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** 用户表，增加登录名字段为唯一性索引 */
@Entity('users')
@Index('idx_users_username', ['username'], { unique: true })
export class UserEntity extends UserBaseEntity {
  /** 用户ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '用户ID' })
  id!: number;

  /**
   * 电子邮箱
   *
   * 注：可选资料（找回密码/通知用），故允许为 NULL；
   * PostgreSQL 的唯一索引不限制多个 NULL，所以「多个用户都不填邮箱」不会冲突（存空串则会）
   */
  @Column({
    type: 'text',
    name: 'email',
    nullable: true,
    default: null,
    comment: '电子邮箱',
  })
  @Index({ unique: true })
  email!: string | null;

  /**
   * 密码哈希
   *
   * 注：select:false ⇒ 默认不查出来，登录/改密时显式指定字段；空串表示尚未设置密码
   */
  @Column({
    type: 'text',
    name: 'password',
    default: '',
    select: false,
    comment: '密码哈希',
  })
  password!: string;

  /** 密码最后修改时间，注：0 表示从未设置 */
  @Column({
    type: 'bigint',
    name: 'password_at',
    default: 0,
    comment: '密码最后修改时间',
  })
  passwordAt!: number;

  /** 登录令牌有效期（单位：分钟），注：0 表示长期有效，作为该用户登录签发与令牌续期的默认值 */
  @Column({
    type: 'int',
    name: 'token_valid',
    default: TOKEN_VALID_DEFAULT,
    comment: '令牌有效期（分钟），0表示长期有效',
  })
  tokenValid!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;

  /** 登录次数 */
  @Column({ type: 'int', name: 'login_times', default: 0, comment: '登录次数' })
  loginTimes!: number;

  /** 首次登录时间 */
  @Column({
    type: 'bigint',
    name: 'first_login_at',
    default: 0,
    comment: '首次登录时间',
  })
  firstLoginAt!: number;

  /** 最后登录IP */
  @Column({
    type: 'inet',
    name: 'last_login_ip',
    default: '127.0.0.1',
    comment: '最后登录IP',
  })
  lastLoginIp!: string;

  /** 最后登录时间 */
  @Column({
    type: 'bigint',
    name: 'last_login_at',
    default: 0,
    comment: '最后登录时间',
  })
  lastLoginAt!: number;

  /** 最后会话时间 */
  @Column({
    type: 'bigint',
    name: 'last_session_at',
    default: 0,
    comment: '最后会话时间',
  })
  lastSessionAt!: number;

  /** 对长整型数据返回时，进行数据转换 */
  @AfterLoad()
  userLoad() {
    this.firstLoginAt = this.firstLoginAt ? Number(this.firstLoginAt) : 0;
    this.lastLoginAt = this.lastLoginAt ? Number(this.lastLoginAt) : 0;
    this.lastSessionAt = this.lastSessionAt ? Number(this.lastSessionAt) : 0;
    this.passwordAt = this.passwordAt ? Number(this.passwordAt) : 0;
  }
}

/** 用户日志表 */
@Entity('users_logs')
export class UserLogEntity extends UserBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 用户ID */
  @Column({ type: 'int', name: 'id', comment: '用户ID' })
  @Index()
  id!: number;

  /** 电子邮箱，注：跟随主表允许为 NULL，否则日志回填时会被非空约束打断 */
  @Column({
    type: 'text',
    name: 'email',
    nullable: true,
    default: null,
    comment: '电子邮箱',
  })
  email!: string | null;
}
