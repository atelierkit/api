// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '@shared';

/** Docker 宿主机基类 */
export abstract class DockerBaseEntity {
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

  /**
   * daemon 地址
   *
   * 注：形如 `tcp://192.168.1.3:2376`、`https://docker.lan:2376` 或 `http://127.0.0.1:2375`；
   * `tcp://` 的实际协议由 `tls` 决定（开 TLS 走 https，否则走 http）
   */
  @Column({ type: 'text', name: 'endpoint', default: '', comment: 'daemon 地址' })
  endpoint!: string;

  /** 是否启用 TLS 客户端证书，true 表示走 https 并带上 cert / key */
  @Column({ type: 'bool', name: 'tls', default: false, comment: '启用 TLS' })
  tls!: boolean;

  /** CA 证书 PEM，注：空串表示用系统根证书 */
  @Column({ type: 'text', name: 'ca', default: '', comment: 'CA 证书' })
  ca!: string;

  /** 客户端证书 PEM */
  @Column({ type: 'text', name: 'cert', default: '', comment: '客户端证书' })
  cert!: string;

  /**
   * 客户端私钥 PEM
   *
   * 注：**密文存储**（`enc:v1:` 前缀，见 `shared/common/secret.util.ts`），任何接口都不下发浏览器 ——
   * 拿到私钥即可冒充 api 访问宿主机 daemon，等于拿到宿主 root
   */
  @Column({ type: 'text', name: 'key', default: '', comment: '客户端私钥（密文）' })
  key!: string;

  /** 是否校验证书链与主机名，false 仅用于自签证书的临时联调 */
  @Column({ type: 'bool', name: 'verify', default: true, comment: '校验证书' })
  verify!: boolean;

  /**
   * 手工指定的 API 版本（如 `1.47`）
   *
   * 注：空串表示自动探测（取 daemon 的 `/version` 的 `ApiVersion`，见 `DockerService`）
   */
  @Column({ type: 'text', name: 'api_version', default: '', comment: 'API 版本' })
  apiVersion!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** Docker 宿主机表 */
@Entity('dockers')
export class DockerEntity extends DockerBaseEntity {
  /** 实例ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '实例ID' })
  id!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** Docker 宿主机变更日志表，注：结构与主表一致，由 CommonService 按操作序号整行搬入 */
@Entity('dockers_logs')
export class DockerLogEntity extends DockerBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 实例ID */
  @Column({ type: 'int', name: 'id', comment: '实例ID' })
  @Index()
  id!: number;
}
