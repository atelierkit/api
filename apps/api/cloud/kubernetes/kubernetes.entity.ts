// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from '@shared';

/** Kubernetes 集群基类 */
export abstract class KubernetesBaseEntity {
  /** 集群名称 */
  @Column({ type: 'text', name: 'name', default: '', comment: '集群名称' })
  name!: string;

  /** 集群说明 */
  @Column({
    type: 'text',
    name: 'description',
    default: '',
    comment: '集群说明',
  })
  description!: string;

  /**
   * API Server 地址
   *
   * 注：形如 `https://192.168.1.3:6443`；`http://` 仅用于本机的 `kubectl proxy`（明文，需显式确认）
   */
  @Column({ type: 'text', name: 'endpoint', default: '', comment: 'API Server 地址' })
  endpoint!: string;

  /**
   * ServiceAccount Token
   *
   * 注：**密文存储**（`enc:v1:` 前缀，见 `shared/common/secret.util.ts`），任何接口都不下发浏览器 ——
   * 拿到 token 即以该 ServiceAccount 的身份操作集群
   */
  @Column({ type: 'text', name: 'token', default: '', comment: '访问令牌（密文）' })
  token!: string;

  /** CA 证书 PEM，注：空串表示用系统根证书；kubeadm 集群通常要填 `/etc/kubernetes/pki/ca.crt` */
  @Column({ type: 'text', name: 'ca', default: '', comment: 'CA 证书' })
  ca!: string;

  /** 客户端证书 PEM */
  @Column({ type: 'text', name: 'cert', default: '', comment: '客户端证书' })
  cert!: string;

  /** 客户端私钥 PEM，注：**密文存储**，与 token 同一条加解密路径 */
  @Column({ type: 'text', name: 'key', default: '', comment: '客户端私钥（密文）' })
  key!: string;

  /** 是否校验证书链与主机名，false 仅用于自签证书的临时联调 */
  @Column({ type: 'bool', name: 'verify', default: true, comment: '校验证书' })
  verify!: boolean;

  /**
   * 默认命名空间
   *
   * 注 1：列表页可以显式切到「全部命名空间」，但删除 / 扩缩容这类动作必须落到一个具体命名空间，
   * 缺省就用这里的值；仍为空时服务层退回 `default`
   * 注 2：集群级资源（节点 / 命名空间）不使用该列
   */
  @Column({ type: 'text', name: 'namespace', default: 'default', comment: '默认命名空间' })
  namespace!: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @Column({ type: 'bool', name: 'status', default: true, comment: '启用状态' })
  status!: boolean;

  /** 更新信息 */
  @Column(() => UpdateEntity)
  update!: UpdateEntity;
}

/** Kubernetes 集群表 */
@Entity('kubernetes')
export class KubernetesEntity extends KubernetesBaseEntity {
  /** 集群ID */
  @PrimaryGeneratedColumn({ type: 'int', name: 'id', comment: '集群ID' })
  id!: number;

  /** 创建信息 */
  @Column(() => CreateEntity)
  create!: CreateEntity;
}

/** Kubernetes 集群变更日志表，注：结构与主表一致，由 CommonService 按操作序号整行搬入 */
@Entity('kubernetes_logs')
export class KubernetesLogEntity extends KubernetesBaseEntity {
  /** 日志信息 */
  @Column(() => LogEntity)
  log!: LogEntity;

  /** 集群ID */
  @Column({ type: 'int', name: 'id', comment: '集群ID' })
  @Index()
  id!: number;
}
