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
import { DockerCreateDto, DockerUpdateDto } from './docker.dto.js';
import {
  certificateErrorOf,
  certificateFormatErrorOf,
  keyPairErrorOf,
} from './docker.cert.js';
import { DockerBaseEntity, DockerEntity, DockerLogEntity } from './docker.entity.js';
import {
  dockerRequest,
  dockerTargetOf,
  isInsecure,
  type DockerTarget,
} from './docker.request.js';
import type {
  DockerDiagnose,
  DockerInfo,
  DockerSummary,
  DockerVersion,
} from './docker.types.js';

/** 私钥占位符，注：与邮件授权码同风格；编辑时提交 `***` 与空串都表示「不修改」 */
export const DOCKER_KEY_MASK = '***';

/** API 版本探测结果的缓存时长（毫秒），注：daemon 升级后最迟 5 分钟自愈，不必重启 api */
export const DOCKER_VERSION_TTL = 5 * 60 * 1000;

/**
 * 主表与日志表共用的可见字段
 *
 * 注 1：**仍然带上 `key`** —— 服务端要靠它判断「是否已配置私钥」（回 `hasKey`），
 * 但 `view()` 会把它的值清成空串，任何接口都不会把私钥或其密文下发浏览器
 * 注 2：TypeORM v1 起只认对象写法，嵌入列要展开成嵌套对象
 * 注 3：**这里刻意不含 `create`** —— 日志表没有这一列（历史行是整行拷贝，创建信息已并入 `update`），
 * 把它一起 select 会让日志查询抛 `EntityPropertyNotFoundError`
 */
const BASE_SELECT: Omit<FindOptionsSelect<DockerEntity>, 'create'> = {
  id: true,
  name: true,
  description: true,
  endpoint: true,
  tls: true,
  ca: true,
  cert: true,
  key: true,
  verify: true,
  apiVersion: true,
  status: true,
  update: {
    userId: true,
    operate: true,
    operateId: true,
    reqId: true,
    at: true,
  },
};

/** 主表可见字段，注：比日志表多一个 `create` */
const ROW_SELECT = {
  ...BASE_SELECT,
  create: { userId: true, at: true },
} satisfies FindOptionsSelect<DockerEntity>;

/** 日志表可见字段，注：`satisfies` 会挡住「照抄主表的 `create`」这类写法 */
const LOG_SELECT = BASE_SELECT satisfies FindOptionsSelect<DockerLogEntity>;

/** 视图，注：`hasKey` 是派生字段，只告诉前端「私钥已配置」，不给私钥本身 */
type DockerView<T extends DockerBaseEntity> = T & { hasKey: boolean };

/** Docker 宿主机服务 */
@Injectable()
export class DockerService extends CommonService<DockerEntity, DockerLogEntity> {
  protected name = 'docker';

  /**
   * API 版本探测缓存
   *
   * 注：键为「协议 + 主机 + 端口 + 证书校验开关」—— 同一个 daemon 的不同校验方式可能走不同
   * 反向代理，故不按下配置 ID 缓存；值为探测到的版本与该次探测的时刻
   */
  private readonly versions = new Map<string, { version: string; at: number }>();

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param dockerRepository 宿主机存储器
   * @param dockerLogRepository 宿主机日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    @InjectRepository(DockerEntity)
    private readonly dockerRepository: Repository<DockerEntity>,
    @InjectRepository(DockerLogEntity)
    private readonly dockerLogRepository: Repository<DockerLogEntity>,
  ) {
    super(operateSrv, queueSrv, dockerRepository, dockerLogRepository);
  }

  /**
   * 获取宿主机清单
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 宿主机清单，注：私钥已清空，只回 `hasKey`
   */
  async index(operateId: number = -1) {
    /** 宿主机清单 */
    const rows = await this.dockerRepository.find({
      select: ROW_SELECT,
      where: {
        update: { operateId: MoreThan(operateId) },
      } as FindOptionsWhere<DockerEntity>,
      order: { id: 'ASC' },
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * 获取宿主机详情
   *
   * @param id 宿主机ID
   * @returns 宿主机详情，注：私钥已清空，只回 `hasKey`
   */
  async show(id: number) {
    /** 宿主机 */
    const row = await this.dockerRepository.findOne({
      select: ROW_SELECT,
      where: { id } as FindOptionsWhere<DockerEntity>,
    });
    return row === null ? null : this.view(row);
  }

  /**
   * 获取变更历史
   *
   * @param id 宿主机ID
   * @returns 变更记录，注：日志表里存的是密文私钥，同样要清掉
   */
  async log(id: number) {
    /** 变更记录 */
    const rows = await this.dockerLogRepository.find({
      select: LOG_SELECT,
      where: { id } as FindOptionsWhere<DockerLogEntity>,
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * 创建宿主机
   *
   * @param value 创建信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 新宿主机ID
   */
  async create(
    value: DockerCreateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 是否允许明文连接，注：只是确认标记，不落库 */
    const allowInsecure = value.allowInsecure;
    /** 连接参数，注：先解析再用它做明文校验，地址非法时这里就会 422 */
    const target = dockerTargetOf(value.endpoint, value.tls, {
      verify: value.verify,
    });
    this.assertSecure(target, allowInsecure);
    // 注：启用 TLS 时先把证书与私钥校验一遍 —— 不匹配的证书在握手阶段只会得到一句
    // OpenSSL 的 `key values mismatch`，用户根本不知道是哪个框填错了
    if (value.tls) {
      /** 证书校验结果 */
      const certError = certificateErrorOf(
        value.ca ?? '',
        value.cert ?? '',
        value.key ?? '',
      );
      if (certError !== null) {
        throw new UnprocessableEntityException(certError);
      }
    }
    /** 落库内容，注：逐个挑字段，`allowInsecure` 不能被带进表里 */
    const entity: Partial<DockerEntity> = {
      name: value.name,
      description: value.description,
      endpoint: value.endpoint,
      tls: value.tls,
      ca: value.tls ? (value.ca ?? '') : '',
      cert: value.tls ? (value.cert ?? '') : '',
      key: value.tls ? this.encrypt(value.key ?? '') : '',
      verify: value.verify,
      apiVersion: value.apiVersion ?? '',
      status: value.status,
    };
    return super.create(entity, userId, reqId);
  }

  /**
   * 更新宿主机
   *
   * @param id 宿主机ID
   * @param value 更新信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 宿主机ID
   */
  async update(
    id: number,
    value: DockerUpdateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 现有记录，注：要拿它补齐未提交的一半（如只改地址、不改 TLS 开关） */
    const current = await this.row(id);
    if (current === null) {
      throw new NotFoundException('指定宿主机不存在！');
    }
    /** 最终地址 */
    const endpoint = value.endpoint ?? current.endpoint;
    /** 最终 TLS 开关 */
    const tls = value.tls ?? current.tls;
    /** 最终证书校验开关 */
    const verify = value.verify ?? current.verify;
    // 注：只在地址或 TLS 开关被提交时才做明文校验 —— 老记录本来就是明文时，
    // 改个说明不该被要求重新确认一次
    if (value.endpoint !== undefined || value.tls !== undefined) {
      this.assertSecure(
        dockerTargetOf(endpoint, tls, { verify }),
        value.allowInsecure,
      );
    }
    /** 待更新字段，注：逐个挑，`allowInsecure` 不进表 */
    const patch: Partial<DockerEntity> = {};
    if (value.name !== undefined) {
      patch.name = value.name;
    }
    if (value.description !== undefined) {
      patch.description = value.description;
    }
    if (value.endpoint !== undefined) {
      patch.endpoint = value.endpoint;
    }
    if (value.tls !== undefined) {
      patch.tls = value.tls;
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
    if (value.apiVersion !== undefined) {
      patch.apiVersion = value.apiVersion;
    }
    if (value.status !== undefined) {
      patch.status = value.status;
    }
    // 注：只有**显式**关掉 TLS 时才连带清空证书三件套 —— 否则任何一次改说明都会把密钥抹掉
    if (value.tls === false) {
      patch.ca = '';
      patch.cert = '';
      patch.key = '';
    } else if (
      value.key !== undefined &&
      value.key !== '' &&
      value.key !== DOCKER_KEY_MASK
    ) {
      patch.key = this.encrypt(value.key);
    }
    // 注：从明文改成 TLS 但没给证书时挡住 —— DTO 的联动校验只管创建，更新时字段是可选的
    if (tls === true) {
      /** 最终客户端证书 */
      const cert = patch.cert ?? current.cert;
      /** 最终私钥，注：patch 里是密文，只判空 */
      const key = patch.key ?? current.key;
      if (!cert || !key) {
        throw new UnprocessableEntityException(
          '启用 TLS 时必须提供客户端证书与私钥，请重新填写后再保存！',
        );
      }
      /** 证书形态（只允许一张、且能解析） */
      const formatError = certificateFormatErrorOf(
        patch.ca ?? current.ca,
        cert,
      );
      if (formatError !== null) {
        throw new UnprocessableEntityException(formatError);
      }
      // 注：只有提交了**明文**私钥时才能做配对校验（库里的私钥是密文，跨密文没法比对）；
      // 只换证书不换私钥的情形留给连接阶段，那时 `dockerRequest` 会把 OpenSSL 的
      // 同步异常转成可读的 422
      if (
        value.key !== undefined &&
        value.key !== '' &&
        value.key !== DOCKER_KEY_MASK
      ) {
        /** 配对校验结果 */
        const pairError = keyPairErrorOf(cert, value.key);
        if (pairError !== null) {
          throw new UnprocessableEntityException(pairError);
        }
      }
    }
    return super.update(id, patch, userId, reqId);
  }

  /**
   * 获取宿主机的连接参数
   *
   * 注 1：私钥在这里解密，且只在服务端内存里存在
   * 注 2：未配置 API 版本时先探测一次（结果缓存），否则请求会退回 daemon 的最低兼容版本
   *
   * @param id 宿主机ID
   * @returns 连接参数
   * @throws NotFoundException 宿主机不存在时抛出
   */
  async target(id: number): Promise<DockerTarget> {
    /** 宿主机 */
    const row = await this.row(id);
    if (row === null) {
      throw new NotFoundException('指定宿主机不存在！');
    }
    /** 连接参数 */
    const target = dockerTargetOf(
      row.endpoint,
      row.tls,
      {
        ca: row.ca,
        cert: row.cert,
        key: row.key === '' ? '' : this.decrypt(row.key),
        verify: row.verify,
      },
      row.apiVersion,
    );
    if (target.apiVersion === '') {
      target.apiVersion = await this.apiVersionOf(target);
    }
    return target;
  }

  /**
   * 获取宿主机概览（`GET /version` + `GET /info`）
   *
   * 注：两个请求并行发，任一失败按原状态码抛出 —— 概览页宁可报错，也不要显示半真半假的数据
   *
   * @param id 宿主机ID
   * @returns 概览
   */
  async summary(id: number): Promise<DockerSummary> {
    /** 连接参数 */
    const target = await this.target(id);
    /** 版本信息与运行信息 */
    const [version, info] = await Promise.all([
      dockerRequest<DockerVersion>(target, '/version'),
      dockerRequest<DockerInfo>(target, '/info'),
    ]);
    return {
      version: version.Version ?? '',
      apiVersion: version.ApiVersion ?? '',
      os: version.Os ?? '',
      arch: version.Arch ?? '',
      kernelVersion: version.KernelVersion ?? '',
      name: info.Name ?? '',
      containers: info.Containers ?? 0,
      containersRunning: info.ContainersRunning ?? 0,
      containersPaused: info.ContainersPaused ?? 0,
      containersStopped: info.ContainersStopped ?? 0,
      images: info.Images ?? 0,
      cpus: info.NCPU ?? 0,
      memoryTotal: info.MemTotal ?? 0,
      driver: info.Driver ?? '',
      dockerRootDir: info.DockerRootDir ?? '',
      defaultRuntime: info.DefaultRuntime ?? '',
      swarmActive: info.Swarm?.LocalNodeState === 'active',
    };
  }

  /**
   * 宿主机连通性诊断
   *
   * 注：`_ping` 单独计时（它是最轻的接口，用来区分「连得上但慢」与「连不上」）；
   * 风险项由后端判定后下发，前端不做同样的判断，避免两处口径不一致
   *
   * @param id 宿主机ID
   * @returns 诊断结果
   */
  async diagnose(id: number): Promise<DockerDiagnose> {
    /** 连接参数 */
    const target = await this.target(id);
    /** 计时起点 */
    const started = Date.now();
    /** `_ping` 的原始响应 */
    const ping = await dockerRequest<string>(target, '/_ping', { raw: true });
    /** 往返耗时 */
    const latencyMs = Date.now() - started;
    /** 版本信息 */
    const version = await dockerRequest<DockerVersion>(target, '/version');
    /** 风险提示 */
    const warnings: string[] = [];
    if (isInsecure(target)) {
      warnings.push(
        '当前为明文连接（http），daemon 没有鉴权，局域网内任何人都能控制这台宿主机。',
      );
    }
    if (target.protocol === 'https' && !target.verify) {
      warnings.push('已关闭证书校验，连接可能被中间人冒充。');
    }
    if (
      target.apiVersion !== '' &&
      version.ApiVersion !== undefined &&
      target.apiVersion !== version.ApiVersion
    ) {
      warnings.push(
        `配置的 API 版本 ${target.apiVersion} 与 daemon 的 ${version.ApiVersion} 不一致，部分接口可能返回 400。`,
      );
    }
    if (target.apiVersion === '') {
      warnings.push(
        '未能探测到 daemon 的 API 版本，请求已退回最低兼容版本（1.24），部分新字段可能缺失。',
      );
    }
    return {
      latencyMs,
      ping: typeof ping === 'string' ? ping.trim() : '',
      version: version.Version ?? '',
      apiVersion: version.ApiVersion ?? '',
      usedApiVersion: target.apiVersion,
      protocol: target.protocol,
      // 注：连接参数里没有单独的 tls 开关，有客户端证书即视为启用了 mTLS（service 层就是这么组装的）
      tls: target.cert !== '',
      verify: target.verify,
      warnings,
    };
  }

  /**
   * 取含私钥的原始记录
   *
   * @param id 宿主机ID
   * @returns 原始记录，不存在时为 null
   */
  private async row(id: number): Promise<DockerEntity | null> {
    return this.dockerRepository.findOne({
      where: { id } as FindOptionsWhere<DockerEntity>,
    });
  }

  /**
   * 探测 daemon 的 API 版本
   *
   * 注：`/version` 在不带版本前缀时也可用，故探测请求本身不受前缀影响；
   * 探测结果按连接维度缓存，失败时不写缓存（下次再试）
   *
   * @param target 连接参数，注：其 `apiVersion` 必须为空
   * @returns API 版本，探测不到时为空串
   */
  private async apiVersionOf(target: DockerTarget): Promise<string> {
    /** 缓存键 */
    const cacheKey = `${target.protocol}://${target.host}:${target.port}|${target.verify}`;
    /** 缓存命中 */
    const hit = this.versions.get(cacheKey);
    if (hit !== undefined && Date.now() - hit.at < DOCKER_VERSION_TTL) {
      return hit.version;
    }
    /** 版本信息 */
    const version = await dockerRequest<DockerVersion>(target, '/version');
    /** 探测到的版本 */
    const apiVersion = version.ApiVersion ?? '';
    if (apiVersion !== '') {
      this.versions.set(cacheKey, { version: apiVersion, at: Date.now() });
    }
    return apiVersion;
  }

  /**
   * 明文连接必须由用户显式确认
   *
   * @param target 连接参数
   * @param allowInsecure 用户是否勾选了「允许明文连接」
   * @throws UnprocessableEntityException 明文且未确认时抛出
   */
  private assertSecure(
    target: DockerTarget,
    allowInsecure: boolean | undefined,
  ): void {
    if (isInsecure(target) && allowInsecure !== true) {
      throw new UnprocessableEntityException(
        '明文连接需要显式确认：请勾选「允许明文连接」后再保存（2375 端口没有鉴权，局域网内任何人都能控制宿主机）！',
      );
    }
  }

  /**
   * 加密私钥
   *
   * @param plain 明文私钥
   * @returns 密文，空串原样返回
   */
  private encrypt(plain: string): string {
    if (plain === '') {
      return '';
    }
    return encryptSecret(plain, this.settingKey());
  }

  /**
   * 解密私钥
   *
   * @param value 密文，注：不带 `enc:v1:` 前缀的值按明文使用（兼容手工 SQL 导入）
   * @returns 明文私钥
   * @throws UnprocessableEntityException 解密失败（密钥被更换）时抛出可读错误
   */
  private decrypt(value: string): string {
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
        '客户端私钥解密失败，请重新录入私钥（SETTING_KEY 可能已被更换）！',
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
        '未配置 SETTING_KEY 环境变量，无法加解密 Docker 客户端私钥！',
      );
    }
    return key;
  }

  /**
   * 实体 → 下发视图
   *
   * @param row 实体
   * @returns 视图，注：私钥替换成空串，另给 `hasKey`
   */
  private view<T extends DockerBaseEntity>(row: T): DockerView<T> {
    // 注：用 `Object.assign` 而不是展开运算符 —— 这里刻意把实体复制成普通对象
    // （响应体不需要 TypeORM 实体的原型，且展开 class instance 会被 lint 判为可疑用法）
    return Object.assign({}, row, {
      key: '',
      hasKey: (row.key ?? '') !== '',
    }) as DockerView<T>;
  }
}
