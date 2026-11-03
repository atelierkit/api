// 外部依赖
import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsSelect,
  FindOptionsWhere,
  MoreThan,
  Repository,
} from 'typeorm';
// 内部依赖
import {
  CommonService,
  OperateService,
  QueueService,
  decryptSecret,
  encryptSecret,
  isSecret,
} from '@shared';
import { certificateErrorOf } from '../docker/docker.cert.js';
import { KubernetesCreateDto, KubernetesUpdateDto } from './kubernetes.dto.js';
import {
  KubernetesBaseEntity,
  KubernetesEntity,
  KubernetesLogEntity,
} from './kubernetes.entity.js';
import {
  authModeOf,
  isInsecure,
  kubernetesRequest,
  kubernetesTargetOf,
  type KubernetesTarget,
} from './kubernetes.request.js';
import type {
  KubernetesDiagnose,
  KubernetesList,
  KubernetesRawNamespace,
  KubernetesRawNode,
  KubernetesRawPod,
  KubernetesRawService,
  KubernetesRawWorkload,
  KubernetesSummary,
  KubernetesVersion,
} from './kubernetes.types.js';
import { nodeReadyOf, quantityOf } from './kubernetes.util.js';

/** 凭据占位符，注：与 Docker 私钥同风格；编辑时提交 `***` 或空串都表示「不修改」 */
export const KUBERNETES_SECRET_MASK = '***';

/** 未填默认命名空间时使用的值 */
export const KUBERNETES_DEFAULT_NAMESPACE = 'default';

/**
 * 对外可见的字段
 *
 * 注 1：**仍然带上 `token` / `key`** —— 服务端要靠它们判断「是否已配置」（回 `hasToken` / `hasKey`），
 * 但 `view()` 会把值清成空串，任何接口都不会把凭据或其密文下发浏览器
 * 注 2：TypeORM v1 起只认对象写法，嵌入列要展开成嵌套对象
 */
const ROW_SELECT = {
  id: true,
  name: true,
  description: true,
  endpoint: true,
  token: true,
  ca: true,
  cert: true,
  key: true,
  verify: true,
  namespace: true,
  status: true,
  create: { userId: true, at: true },
  update: {
    userId: true,
    operate: true,
    operateId: true,
    reqId: true,
    at: true,
  },
} satisfies FindOptionsSelect<KubernetesEntity>;

/** 视图，注：`hasToken` / `hasKey` 是派生字段，只告诉前端「凭据已配置」，不给凭据本身 */
type KubernetesView<T extends KubernetesBaseEntity> = T & {
  hasToken: boolean;
  hasKey: boolean;
};

/** 集群服务 */
@Injectable()
export class KubernetesService extends CommonService<
  KubernetesEntity,
  KubernetesLogEntity
> {
  protected name = 'kubernetes';

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param kubernetesRepository 集群存储器
   * @param kubernetesLogRepository 集群日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(KubernetesEntity)
    private readonly kubernetesRepository: Repository<KubernetesEntity>,
    @InjectRepository(KubernetesLogEntity)
    private readonly kubernetesLogRepository: Repository<KubernetesLogEntity>,
  ) {
    super(operateSrv, queueSrv, kubernetesRepository, kubernetesLogRepository);
  }

  /**
   * 获取集群清单
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 集群清单，注：凭据已清空，只回 `hasToken` / `hasKey`
   */
  async index(operateId: number = -1) {
    /** 集群清单 */
    const rows = await this.kubernetesRepository.find({
      select: ROW_SELECT,
      where: {
        update: { operateId: MoreThan(operateId) },
      } as FindOptionsWhere<KubernetesEntity>,
      order: { id: 'ASC' },
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * 获取集群详情
   *
   * @param id 集群ID
   * @returns 集群详情，注：凭据已清空
   */
  async show(id: number) {
    /** 集群 */
    const row = await this.kubernetesRepository.findOne({
      select: ROW_SELECT,
      where: { id } as FindOptionsWhere<KubernetesEntity>,
    });
    return row === null ? null : this.view(row);
  }

  /**
   * 获取变更历史
   *
   * @param id 集群ID
   * @returns 变更记录，注：日志表里存的是密文凭据，同样要清掉
   */
  async log(id: number) {
    /** 变更记录 */
    const rows = await this.kubernetesLogRepository.find({
      select: ROW_SELECT,
      where: { id } as FindOptionsWhere<KubernetesLogEntity>,
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * 创建集群
   *
   * @param value 创建信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 新集群ID
   */
  async create(
    value: KubernetesCreateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 是否允许明文连接，注：只是确认标记，不落库 */
    const allowInsecure = value.allowInsecure;
    // 注：先解析地址再判明文，地址非法时这里就会 422
    this.assertSecure(
      kubernetesTargetOf(value.endpoint, { verify: value.verify }),
      allowInsecure,
    );
    /** ServiceAccount Token，注：首尾空白是复制粘贴带进来的 */
    const token = (value.token ?? '').trim();
    /** 客户端证书 */
    const cert = value.cert ?? '';
    /** 客户端私钥 */
    const key = value.key ?? '';
    /** 鉴权方式的校验结果 */
    const authError = this.authErrorOf(token, cert, key);
    if (authError !== null) {
      throw new UnprocessableEntityException(authError);
    }
    // 注：配了客户端证书时先把证书与私钥校验一遍 —— 不匹配的证书在握手阶段只会得到一句
    // OpenSSL 的 `key values mismatch`，用户根本不知道是哪个框填错了
    if (cert !== '') {
      /** 证书校验结果 */
      const certError = certificateErrorOf(value.ca ?? '', cert, key);
      if (certError !== null) {
        throw new UnprocessableEntityException(certError);
      }
    }
    /** 落库内容，注：逐个挑字段，`allowInsecure` 不能被带进表里 */
    const entity: Partial<KubernetesEntity> = {
      name: value.name,
      description: value.description,
      endpoint: value.endpoint,
      token: this.encrypt(token),
      ca: value.ca ?? '',
      cert,
      key: this.encrypt(key),
      verify: value.verify,
      namespace: this.namespaceOrDefault(value.namespace),
      status: value.status,
    };
    return super.create(entity, userId, reqId);
  }

  /**
   * 更新集群
   *
   * @param id 集群ID
   * @param value 更新信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 集群ID
   */
  async update(
    id: number,
    value: KubernetesUpdateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 现有记录，注：要拿它补齐未提交的一半（如只改说明、不改地址） */
    const current = await this.row(id);
    if (current === null) {
      throw new NotFoundException('指定集群不存在！');
    }
    /** 最终地址 */
    const endpoint = value.endpoint ?? current.endpoint;
    /** 最终证书校验开关 */
    const verify = value.verify ?? current.verify;
    // 注：只在地址被提交时才做明文校验 —— 老记录本来就是明文时，
    // 改个说明不该被要求重新确认一次
    if (value.endpoint !== undefined) {
      this.assertSecure(
        kubernetesTargetOf(endpoint, { verify }),
        value.allowInsecure,
      );
    }
    /** 待更新字段，注：逐个挑，`allowInsecure` 不进表 */
    const patch: Partial<KubernetesEntity> = {};
    if (value.name !== undefined) {
      patch.name = value.name;
    }
    if (value.description !== undefined) {
      patch.description = value.description;
    }
    if (value.endpoint !== undefined) {
      patch.endpoint = value.endpoint;
    }
    if (value.ca !== undefined) {
      patch.ca = value.ca;
    }
    if (value.cert !== undefined) {
      patch.cert = value.cert;
    }
    if (value.verify !== undefined) {
      patch.verify = value.verify;
    }
    if (value.namespace !== undefined) {
      patch.namespace = this.namespaceOrDefault(value.namespace);
    }
    if (value.status !== undefined) {
      patch.status = value.status;
    }
    /** 本次提交的明文 Token，注：空串与占位符都表示「不修改」 */
    const plainToken = this.plainOf(value.token);
    /** 本次提交的明文私钥 */
    const plainKey = this.plainOf(value.key);
    /** 是否清空 Token */
    const clearToken = value.clearToken === true;
    /** 是否清空客户端证书三件套 */
    const clearCert = value.clearCert === true;
    if (clearToken) {
      patch.token = '';
    } else if (plainToken !== '') {
      patch.token = this.encrypt(plainToken);
    }
    if (clearCert) {
      patch.ca = '';
      patch.cert = '';
      patch.key = '';
    } else if (plainKey !== '') {
      patch.key = this.encrypt(plainKey);
    }
    /** 最终 Token 是否存在，注：库里的值是密文，只关心有无 */
    const hasToken = !clearToken && (plainToken !== '' || current.token !== '');
    /** 最终客户端证书 */
    const cert = clearCert ? '' : (patch.cert ?? current.cert);
    /** 最终私钥是否存在 */
    const hasKey = !clearCert && (plainKey !== '' || current.key !== '');
    /** 鉴权方式的校验结果 */
    const authError = this.authErrorOf(
      hasToken ? '***' : '',
      cert,
      hasKey ? '***' : '',
    );
    if (authError !== null) {
      throw new UnprocessableEntityException(authError);
    }
    // 注：只有「证书或私钥被提交、且没被清空」时才重新校验；只改说明不该因为库里的旧证书解析失败而卡住
    if (!clearCert && (value.cert !== undefined || plainKey !== '')) {
      /** 私钥明文，注：没提交就解密库里的，跨密文没法比对 */
      const key = plainKey !== '' ? plainKey : this.decrypt(current.key, '客户端私钥');
      /** 证书校验结果 */
      const certError = certificateErrorOf(patch.ca ?? current.ca, cert, key);
      if (certError !== null) {
        throw new UnprocessableEntityException(certError);
      }
    }
    return super.update(id, patch, userId, reqId);
  }

  /**
   * 获取集群的连接参数
   *
   * 注：Token 与私钥在这里解密，且只在服务端内存里存在
   *
   * @param id 集群ID
   * @returns 连接参数
   * @throws NotFoundException 集群不存在时抛出
   */
  async target(id: number): Promise<KubernetesTarget> {
    /** 集群 */
    const row = await this.row(id);
    if (row === null) {
      throw new NotFoundException('指定集群不存在！');
    }
    return kubernetesTargetOf(
      row.endpoint,
      {
        ca: row.ca,
        cert: row.cert,
        key: row.key === '' ? '' : this.decrypt(row.key, '客户端私钥'),
        token: row.token === '' ? '' : this.decrypt(row.token, 'ServiceAccount Token'),
        verify: row.verify,
      },
      row.namespace,
    );
  }

  /**
   * 获取集群概览
   *
   * 注 1：六次请求并行发（版本 / 节点 / 命名空间 / Pod / Deployment / Service），
   * 任一失败按原状态码抛出 —— 概览页宁可报错，也不要显示半真半假的数据
   * 注 2：这里用的都是**集群级**列表路径（`/api/v1/pods` 而不是带命名空间的），
   * 因此 ServiceAccount 需要 cluster 级 list 权限；权限不足时报 403，由用户自行降级
   *
   * @param id 集群ID
   * @returns 概览
   */
  async summary(id: number): Promise<KubernetesSummary> {
    /** 连接参数 */
    const target = await this.target(id);
    /** 版本与各类资源清单 */
    const [version, nodes, namespaces, pods, deployments, services] =
      await Promise.all([
        kubernetesRequest<KubernetesVersion>(target, '/version'),
        kubernetesRequest<KubernetesList<KubernetesRawNode>>(
          target,
          '/api/v1/nodes',
        ),
        kubernetesRequest<KubernetesList<KubernetesRawNamespace>>(
          target,
          '/api/v1/namespaces',
        ),
        kubernetesRequest<KubernetesList<KubernetesRawPod>>(
          target,
          '/api/v1/pods',
        ),
        kubernetesRequest<KubernetesList<KubernetesRawWorkload>>(
          target,
          '/apis/apps/v1/deployments',
        ),
        kubernetesRequest<KubernetesList<KubernetesRawService>>(
          target,
          '/api/v1/services',
        ),
      ]);
    /** 节点清单 */
    const nodeRows = nodes?.items ?? [];
    /** Pod 清单 */
    const podRows = pods?.items ?? [];
    /**
     * 按阶段计数
     *
     * @param phase 阶段名
     * @returns 该阶段的 Pod 数
     */
    const countOf = (phase: string): number =>
      podRows.filter((pod) => pod.status?.phase === phase).length;
    return {
      version: version?.gitVersion ?? '',
      platform: version?.platform ?? '',
      goVersion: version?.goVersion ?? '',
      nodes: nodeRows.length,
      nodesReady: nodeRows.filter((node) => nodeReadyOf(node)).length,
      namespaces: (namespaces?.items ?? []).length,
      pods: podRows.length,
      podsRunning: countOf('Running'),
      podsPending: countOf('Pending'),
      podsFailed: countOf('Failed'),
      podsSucceeded: countOf('Succeeded'),
      deployments: (deployments?.items ?? []).length,
      services: (services?.items ?? []).length,
      cpuCapacity: nodeRows.reduce(
        (sum, node) => sum + quantityOf(node.status?.capacity?.['cpu'] ?? ''),
        0,
      ),
      memoryCapacity: nodeRows.reduce(
        (sum, node) =>
          sum + quantityOf(node.status?.capacity?.['memory'] ?? ''),
        0,
      ),
    };
  }

  /**
   * 集群连通性诊断
   *
   * 注 1：`/healthz` 单独计时（它是最轻的接口，用来区分「连得上但慢」与「连不上」）
   * 注 2：风险项由后端判定后下发，前端不做同样的判断，避免两处口径不一致
   *
   * @param id 集群ID
   * @returns 诊断结果
   */
  async diagnose(id: number): Promise<KubernetesDiagnose> {
    /** 连接参数 */
    const target = await this.target(id);
    /** 计时起点 */
    const started = Date.now();
    /** `/healthz` 的原始响应 */
    const ping = await kubernetesRequest<string>(target, '/healthz', {
      raw: true,
    });
    /** 往返耗时 */
    const latencyMs = Date.now() - started;
    /** 版本信息 */
    const version = await kubernetesRequest<KubernetesVersion>(
      target,
      '/version',
    );
    /** 鉴权方式 */
    const authMode = authModeOf(target);
    /** 风险提示 */
    const warnings: string[] = [];
    if (authMode === 'anonymous') {
      warnings.push(
        '未配置 ServiceAccount Token 与客户端证书，只能访问匿名可见的接口，多数资源会返回 403。',
      );
    }
    if (isInsecure(target)) {
      warnings.push(
        '当前为明文连接（http），Token 与全部响应内容都会以明文经过链路，仅建议用于本机的 kubectl proxy。',
      );
    }
    if (target.protocol === 'https' && !target.verify) {
      warnings.push('已关闭证书校验，连接可能被中间人冒充。');
    }
    if (target.namespace === '') {
      warnings.push(
        '未配置默认命名空间，删除 / 扩缩容这类动作将退回 default 命名空间。',
      );
    }
    return {
      latencyMs,
      ping: typeof ping === 'string' ? ping.trim() : '',
      version: version?.gitVersion ?? '',
      platform: version?.platform ?? '',
      authMode,
      protocol: target.protocol,
      verify: target.verify,
      warnings,
    };
  }

  /**
   * 取含凭据的原始记录
   *
   * @param id 集群ID
   * @returns 原始记录，不存在时为 null
   */
  private async row(id: number): Promise<KubernetesEntity | null> {
    return this.kubernetesRepository.findOne({
      where: { id } as FindOptionsWhere<KubernetesEntity>,
    });
  }

  /**
   * 校验鉴权方式
   *
   * 注 1：**必须至少有一种凭据** —— 匿名连接能看到的资源非常有限，留着只会让用户以为
   * 「集群是空的」（实际是 403 被前端吞成了空列表）
   * 注 2：给了客户端证书就必须给私钥，否则握手必然失败
   *
   * @param token Token，注：库里的密文只用于判空
   * @param cert 客户端证书
   * @param key 客户端私钥，注：库里的密文只用于判空
   * @returns 错误文案，通过时返回 null
   */
  private authErrorOf(token: string, cert: string, key: string): string | null {
    if ((token ?? '') === '' && (cert ?? '') === '') {
      return '至少需要提供 ServiceAccount Token 或客户端证书（证书 + 私钥）之一！';
    }
    if ((cert ?? '') !== '' && (key ?? '') === '') {
      return '配置了客户端证书时必须同时提供私钥！';
    }
    return null;
  }

  /**
   * 明文连接必须由用户显式确认
   *
   * @param target 连接参数
   * @param allowInsecure 用户是否勾选了「允许明文连接」
   * @throws UnprocessableEntityException 明文且未确认时抛出
   */
  private assertSecure(
    target: KubernetesTarget,
    allowInsecure: boolean | undefined,
  ): void {
    if (isInsecure(target) && allowInsecure !== true) {
      throw new UnprocessableEntityException(
        '明文连接需要显式确认：请勾选「允许明文连接」后再保存（http 会把 Token 与全部响应暴露在链路上，仅建议用于本机的 kubectl proxy）！',
      );
    }
  }

  /**
   * 归一默认命名空间
   *
   * @param value 提交值
   * @returns 命名空间，空值时退回 `default`
   */
  private namespaceOrDefault(value: string | undefined): string {
    /** 去空白后的值 */
    const namespace = (value ?? '').trim();
    return namespace === '' ? KUBERNETES_DEFAULT_NAMESPACE : namespace;
  }

  /**
   * 取提交的明文凭据
   *
   * @param value 提交值
   * @returns 明文，注：空串与占位符都视为「未提交」，返回空串
   */
  private plainOf(value: string | undefined): string {
    /** 去空白后的值 */
    const plain = (value ?? '').trim();
    return plain === KUBERNETES_SECRET_MASK ? '' : plain;
  }

  /**
   * 加密凭据
   *
   * @param plain 明文，注：Token 首尾空白已在调用方去掉
   * @returns 密文，空串原样返回
   */
  private encrypt(plain: string): string {
    return plain === '' ? '' : encryptSecret(plain, this.settingKey());
  }

  /**
   * 解密凭据
   *
   * @param value 密文，注：不带 `enc:v1:` 前缀的值按明文使用（兼容手工 SQL 导入）
   * @param label 字段名，注：只用于错误文案
   * @returns 明文
   * @throws UnprocessableEntityException 解密失败（密钥被更换）时抛出可读错误
   */
  private decrypt(value: string, label: string): string {
    if (!isSecret(value)) {
      return value;
    }
    // 注：密钥要先取 —— 缺 SETTING_KEY 是配置问题（500），不能被下面的 catch 掩盖成「解密失败」
    /** 加解密密钥 */
    const key = this.settingKey();
    try {
      return decryptSecret(value, key);
    } catch {
      throw new UnprocessableEntityException(
        `${label}解密失败，请重新录入（SETTING_KEY 可能已被更换）！`,
      );
    }
  }

  /**
   * 取加解密密钥
   *
   * 注：与邮件授权码同一套算法，只是缺密钥时的提示按场景区分（同属 `SETTING_KEY`）
   *
   * @returns `SETTING_KEY` 环境变量
   * @throws InternalServerErrorException 未配置时抛出，注：不给「缺密钥就存明文」留后门
   */
  private settingKey(): string {
    /** 密钥口令 */
    const key = (process.env.SETTING_KEY ?? '').trim();
    if (key === '') {
      throw new InternalServerErrorException(
        '未配置 SETTING_KEY 环境变量，无法加解密 Kubernetes 凭据！',
      );
    }
    return key;
  }

  /**
   * 实体 → 下发视图
   *
   * @param row 实体
   * @returns 视图，注：Token 与私钥替换成空串，另给 `hasToken` / `hasKey`
   */
  private view<T extends KubernetesBaseEntity>(row: T): KubernetesView<T> {
    // 注：用 `Object.assign` 而不是展开运算符 —— 这里刻意把实体复制成普通对象
    // （响应体不需要 TypeORM 实体的原型，且展开 class instance 会被 lint 判为可疑用法）
    return Object.assign({}, row, {
      token: '',
      key: '',
      hasToken: (row.token ?? '') !== '',
      hasKey: (row.key ?? '') !== '',
    }) as KubernetesView<T>;
  }
}
