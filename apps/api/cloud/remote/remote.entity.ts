// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '@shared';

/** 远程主机基类 */
export abstract class RemoteBaseEntity {
  /** 主机名称 */
  @Column({ type: 'text', name: 'name', default: '', comment: '主机名称' })
  name!: string;

  /** 主机说明 */
  @Column({
    type: 'text',
    name: 'description',
    default: '',
    comment: '主机说明',
  })
  description!: string;

  /** 主机名或 IP，注：不含协议前缀，SSH 只有一种 scheme */
  @Column({ type: 'text', name: 'host', default: '', comment: '主机名或IP' })
  host!: string;

  /** SSH 端口 */
  @Column({ type: 'int', name: 'port', default: 22, comment: 'SSH端口' })
  port!: number;

  /** 鉴权方式，注：`password` 用密码，`key` 用私钥（可带口令） */
  @Column({
    type: 'text',
    name: 'auth_type',
    default: 'password',
    comment: '鉴权方式',
  })
  authType!: string;

  /** 登录用户 */
  @Column({ type: 'text', name: 'username', default: '', comment: '登录用户' })
  username!: string;

  /**
   * 登录密码
   *
   * 注：**密文存储**（`enc:v1:` 前缀，见 `shared/common/secret.util.ts`），任何接口都不下发 ——
   * 拿到密码即可登录目标主机，故 `view()` 一律清空、只回 `hasPassword`
   */
  @Column({ type: 'text', name: 'password', default: '', comment: '登录密码（密文）' })
  password!: string;

  /** 客户端私钥 PEM，注：密文存储，同上 */
  @Column({
    type: 'text',
    name: 'private_key',
    default: '',
    comment: '私钥（密文）',
  })
  privateKey!: string;

  /** 私钥口令，注：密文存储，可空 */
  @Column({
    type: 'text',
    name: 'passphrase',
    default: '',
    comment: '私钥口令（密文）',
  })
  passphrase!: string;

  /**
   * 终端字符集
   *
   * 注：默认 `utf-8`；少数老系统或容器的 locale 是 GBK 时才需要改成 `gb18030`。
   * 传输层始终传原始字节，解码在浏览器侧做（见 `terminal.channel.ts`）
   */
  @Column({
    type: 'text',
    name: 'charset',
    default: 'utf-8',
    comment: '终端字符集',
  })
  charset!: string;

  /**
   * 主机公钥指纹（`SHA256:...`）
   *
   * 注：空串表示「尚未信任」。首次握手成功后回写，之后必须一致；不一致会断连并要求
   * 用户显式确认（TOFU），避免中间人攻击 —— 详见 `RemoteService.diagnose` 与 `trust`
   */
  @Column({
    type: 'text',
    name: 'fingerprint',
    default: '',
    comment: '主机公钥指纹',
  })
  fingerprint!: string;

  /** SFTP 起始目录，注：空串表示用户 home；P1 的功能，P0 只用于展示 */
  @Column({ type: 'text', name: 'root_path', default: '', comment: 'SFTP起始目录' })
  rootPath!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** 远程主机表 */
@Entity('remotes')
export class RemoteEntity extends RemoteBaseEntity {
  /** 主机ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '主机ID' })
  id!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** 远程主机变更日志表，注：结构与主表一致，由 CommonService 按操作序号整行搬入 */
@Entity('remotes_logs')
export class RemoteLogEntity extends RemoteBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 主机ID */
  @Column({ type: 'int', name: 'id', comment: '主机ID' })
  @Index()
  id!: number;
}
