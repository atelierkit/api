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
import { RemoteCreateDto, RemoteUpdateDto } from './remote.dto.js';
import { RemoteBaseEntity, RemoteEntity, RemoteLogEntity } from './remote.entity.js';
import { fingerprintOf, normalizePrivateKey } from './remote.key.js';
import type { RemoteKeyInfo } from './remote.key.js';
import {
  SUMMARY_COMMAND,
  UNAME_COMMAND,
  parseLinuxSummary,
  tcpProbe,
} from './remote.probe.js';
import { RemoteSshService, httpErrorOf } from './remote.ssh.js';
import type { SshConfig } from './remote.ssh.js';
import {
  RemoteError,
  type RemoteDiagnose,
  type RemoteDiagnoseStage,
  type RemoteSummary,
} from './remote.types.js';

/** 凭据占位符，注：与邮件授权码 / Docker 私钥同风格；编辑时提交 `***` 与空串都表示「不修改」 */
export const REMOTE_SECRET_MASK = '***';

/** 缺省字符集 */
export const DEFAULT_CHARSET = 'utf-8';

/**
 * 对外可见的字段
 *
 * 注 1：**仍然带上三列密文** —— 服务端要靠它们判断「是否已配置」（回 `hasXxx`），
 * 但 `view()` 会把值清成空串，任何接口都不会把凭据或其密文下发浏览器
 * 注 2：TypeORM v1 起只认对象写法，嵌入列要展开成嵌套对象
 */
const ROW_SELECT = {
  id: true,
  name: true,
  description: true,
  host: true,
  port: true,
  authType: true,
  username: true,
  password: true,
  privateKey: true,
  passphrase: true,
  charset: true,
  fingerprint: true,
  rootPath: true,
  status: true,
  create: { userId: true, at: true },
  update: {
    userId: true,
    operate: true,
    operateId: true,
    reqId: true,
    at: true,
  },
} satisfies FindOptionsSelect<RemoteEntity>;

/** 视图，注：`hasXxx` 是派生字段，只告诉前端「已配置」，不给凭据本身 */
type RemoteView<T extends RemoteBaseEntity> = T & {
  /** 是否已配置密码 */
  hasPassword: boolean;
  /** 是否已配置私钥 */
  hasKey: boolean;
  /** 是否已配置私钥口令 */
  hasPassphrase: boolean;
};

/** 私钥预检结果，注：刻意 `Omit` 掉 `privateKey` —— 凭据不下发浏览器 */
export type RemoteKeyView = Omit<RemoteKeyInfo, 'privateKey'>;

/** 连接所需的全部信息 */
export interface RemoteTarget {
  /** SSH 连接参数，注：凭据已解密，只存在于服务端内存 */
  config: SshConfig;
  /** 终端字符集 */
  charset: string;
  /** 已记录的主机指纹，空串表示尚未信任（首连 TOFU） */
  fingerprint: string;
  /**
   * 取本次握手观察到的主机指纹
   *
   * 注：必须握手之后才有值。首次连接要靠它回写 TOFU 记录 —— 服务端不能「先记指纹再连」，
   * 那样连都没连上留下一条假记录，之后就再也连不上了
   *
   * @returns 指纹，尚未握手时为空串
   */
  observed: () => string;
}

/** 远程主机服务 */
@Injectable()
export class RemoteService extends CommonService<
  RemoteEntity,
  RemoteLogEntity
> {
  protected name = 'remote';

  /**
   * 构造函数
   *
   * @param operateSrv 操作序号服务
   * @param queueSrv 队列服务
   * @param sshSrv SSH 服务
   * @param remoteRepository 主机存储器
   * @param remoteLogRepository 主机日志存储器
   */
  constructor(
    operateSrv: OperateService,
    queueSrv: QueueService,
    private readonly sshSrv: RemoteSshService,
    @InjectRepository(RemoteEntity)
    private readonly remoteRepository: Repository<RemoteEntity>,
    @InjectRepository(RemoteLogEntity)
    private readonly remoteLogRepository: Repository<RemoteLogEntity>,
  ) {
    super(operateSrv, queueSrv, remoteRepository, remoteLogRepository);
  }

  /**
   * 获取主机清单
   *
   * @param operateId 操作序号，用于获取增量数据
   * @returns 主机清单，注：凭据已清空，只回 `hasXxx`
   */
  async index(operateId: number = -1) {
    /** 主机清单 */
    const rows = await this.remoteRepository.find({
      select: ROW_SELECT,
      where: {
        update: { operateId: MoreThan(operateId) },
      } as FindOptionsWhere<RemoteEntity>,
      order: { id: 'ASC' },
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * 获取主机详情
   *
   * @param id 主机ID
   * @returns 主机详情，注：凭据已清空
   */
  async show(id: number) {
    /** 主机 */
    const row = await this.remoteRepository.findOne({
      select: ROW_SELECT,
      where: { id } as FindOptionsWhere<RemoteEntity>,
    });
    return row === null ? null : this.view(row);
  }

  /**
   * 获取变更历史
   *
   * @param id 主机ID
   * @returns 变更记录，注：日志表里存的是密文凭据，同样要清掉
   */
  async log(id: number) {
    /** 变更记录 */
    const rows = await this.remoteLogRepository.find({
      select: ROW_SELECT,
      where: { id } as FindOptionsWhere<RemoteLogEntity>,
    });
    return rows.map((row) => this.view(row));
  }

  /**
   * 预检私钥文件内容
   *
   * 注 1：前端「选择本地私钥文件」后先调它，把「格式是否受支持、要不要口令、指纹是多少」
   * 在保存前告诉用户，不必等到点保存才吃一个 422
   * 注 2：**不回传私钥明文** —— 这份内容浏览器本来就有，但没有任何理由再从服务端绕一圈，
   * 否则「凭据永不下发」这条边界就出现了例外；真正的转换发生在保存时（同一套函数，幂等）
   *
   * @param content 私钥原文（本地文件内容的文本）
   * @param passphrase 私钥口令，空串表示无口令
   * @returns 识别结果，注：不含私钥本身
   * @throws UnprocessableEntityException 私钥形态不正确或口令不对时抛出
   */
  inspectKey(content: string, passphrase = ''): RemoteKeyView {
    /** 规范化结果 */
    const result = normalizePrivateKey(content, passphrase);
    if (!result.ok) {
      throw new UnprocessableEntityException(result.message);
    }
    return {
      format: result.info.format,
      converted: result.info.converted,
      encrypted: result.info.encrypted,
      fingerprint: result.info.fingerprint,
    };
  }

  /**
   * 创建主机
   *
   * @param value 创建信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 新主机ID
   * @throws UnprocessableEntityException 私钥形态不正确时抛出
   */
  async create(
    value: RemoteCreateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 是否私钥鉴权 */
    const byKey = value.authType === 'key';
    /** 规范化后的私钥，注：PKCS#8 在这里被转成 PEM，落库的一律是 ssh2 能直接解析的形态 */
    let privateKey = '';
    // 注：私钥在保存时就解析一遍 —— 连接阶段才发现「格式不对 / 口令错」，
    // 用户只会看到一句 OpenSSL 原文，根本不知道是哪个框填错了
    if (byKey) {
      /** 私钥规范化结果 */
      const keyResult = normalizePrivateKey(
        value.privateKey ?? '',
        value.passphrase ?? '',
      );
      if (!keyResult.ok) {
        throw new UnprocessableEntityException(keyResult.message);
      }
      privateKey = keyResult.info.privateKey;
    }
    /** 落库内容，注：逐个挑字段，只留当前鉴权方式用到的那套凭据 */
    const entity: Partial<RemoteEntity> = {
      name: value.name,
      description: value.description,
      host: value.host,
      port: value.port,
      authType: value.authType,
      username: value.username,
      password: byKey ? '' : this.encrypt(value.password ?? ''),
      privateKey: byKey ? this.encrypt(privateKey) : '',
      passphrase: byKey ? this.encrypt(value.passphrase ?? '') : '',
      charset: value.charset ?? DEFAULT_CHARSET,
      // 注：指纹一律从空起步，首连时由 TOFU 记录，不允许新建时就手工填一个「假指纹」
      fingerprint: '',
      rootPath: value.rootPath ?? '',
      status: value.status,
    };
    return super.create(entity, userId, reqId);
  }

  /**
   * 更新主机
   *
   * @param id 主机ID
   * @param value 更新信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 主机ID
   * @throws NotFoundException 主机不存在时抛出
   * @throws UnprocessableEntityException 私钥形态不正确或切换后凭据缺失时抛出
   */
  async update(
    id: number,
    value: RemoteUpdateDto,
    userId: number = 0,
    reqId: number = 0,
  ) {
    /** 现有记录，注：要拿它补齐未提交的部分（如只改端口、不改鉴权方式） */
    const current = await this.row(id);
    if (current === null) {
      throw new NotFoundException('指定主机不存在！');
    }
    /** 最终鉴权方式 */
    const authType = value.authType ?? current.authType;
    /** 待更新字段，注：逐个挑；`fingerprint` 刻意不在这里（只能走 `trust`） */
    const patch: Partial<RemoteEntity> = {};
    if (value.name !== undefined) {
      patch.name = value.name;
    }
    if (value.description !== undefined) {
      patch.description = value.description;
    }
    if (value.host !== undefined) {
      patch.host = value.host;
    }
    if (value.port !== undefined) {
      patch.port = value.port;
    }
    if (value.authType !== undefined) {
      patch.authType = value.authType;
    }
    if (value.username !== undefined) {
      patch.username = value.username;
    }
    if (value.charset !== undefined) {
      patch.charset = value.charset;
    }
    if (value.rootPath !== undefined) {
      patch.rootPath = value.rootPath;
    }
    if (value.status !== undefined) {
      patch.status = value.status;
    }
    // 注：切鉴权方式时必须显式清掉另一套凭据 —— 详情不下发密文，「空串」只能表示
    // 「不修改」，没有这一步就永远切不干净，旧密码会一直留在库里
    if (value.authType === 'password') {
      patch.privateKey = '';
      patch.passphrase = '';
    }
    if (value.authType === 'key') {
      patch.password = '';
    }
    /** 是否提交了新的明文密码 */
    const newPassword =
      value.password !== undefined &&
      value.password !== '' &&
      value.password !== REMOTE_SECRET_MASK;
    /** 是否提交了新的明文私钥 */
    const newKey =
      value.privateKey !== undefined &&
      value.privateKey !== '' &&
      value.privateKey !== REMOTE_SECRET_MASK;
    if (newPassword) {
      patch.password = this.encrypt(value.password ?? '');
    }
    // 注：口令可能只是改口令而私钥不变，故单独处理；空串与 `***` 都表示不修改
    if (
      value.passphrase !== undefined &&
      value.passphrase !== '' &&
      value.passphrase !== REMOTE_SECRET_MASK
    ) {
      patch.passphrase = this.encrypt(value.passphrase);
    }
    if (newKey) {
      /** 私钥规范化结果，注：口令要用「本次提交的」或「库里已有的解密值」 */
      const keyResult = normalizePrivateKey(
        value.privateKey ?? '',
        value.passphrase !== undefined && value.passphrase !== REMOTE_SECRET_MASK
          ? (value.passphrase ?? '')
          : this.decrypt(current.passphrase),
      );
      if (!keyResult.ok) {
        throw new UnprocessableEntityException(keyResult.message);
      }
      patch.privateKey = this.encrypt(keyResult.info.privateKey);
    }
    // 注：切换后的凭据必须齐 —— DTO 的联动校验只管创建，更新时字段都是可选的
    if (authType === 'key') {
      if ((patch.privateKey ?? current.privateKey) === '') {
        throw new UnprocessableEntityException(
          '私钥鉴权必须提供私钥，请填写私钥后再保存！',
        );
      }
    } else if ((patch.password ?? current.password) === '') {
      throw new UnprocessableEntityException(
        '密码鉴权必须提供密码，请填写密码后再保存！',
      );
    }
    return super.update(id, patch, userId, reqId);
  }

  /**
   * 主机概览
   *
   * 注：一次 `exec` 取全量（复合命令带分段标记），避免 8 次往返；解析容错，
   * 某段缺失只让对应字段为空
   *
   * @param id 主机ID
   * @returns 概览
   * @throws HttpException 连接或认证失败时抛出（状态码按原因区分）
   */
  async summary(id: number): Promise<RemoteSummary> {
    /** 连接信息 */
    const target = await this.target(id);
    return this.withClient(target, async (client) => {
      /** 复合命令的输出 */
      const raw = await this.sshSrv.exec(client, SUMMARY_COMMAND);
      return parseLinuxSummary(raw);
    });
  }

  /**
   * 主机连通性诊断
   *
   * 注 1：分五段（TCP → 握手 → 认证 → 环境 → 指纹），任一段失败即停，
   * 诊断结果本身不抛异常 —— 失败原因就是诊断的产出
   * 注 2：**不写指纹**：只读诊断不该改变信任状态，首连记录留给终端会话
   * 注 3：握手阶段的 `hostVerifier` 在指纹不一致时返回 false，绝不带着密码去连一台
   * 未经验证的主机（那正是中间人想拿的东西）
   *
   * @param id 主机ID
   * @returns 诊断结果
   * @throws NotFoundException 主机不存在时抛出
   */
  async diagnose(id: number): Promise<RemoteDiagnose> {
    /** 主机 */
    const row = await this.row(id);
    if (row === null) {
      throw new NotFoundException('指定主机不存在！');
    }
    /** 各阶段结果 */
    const stages: RemoteDiagnoseStage[] = [];
    /** 观察到的指纹 */
    let observed = '';
    /** 风险提示 */
    const warnings: string[] = [];
    /** TCP 探测 */
    const tcp = await tcpProbe(row.host, row.port);
    stages.push({
      name: '网络可达',
      ok: tcp.reachable,
      latencyMs: tcp.latencyMs,
      detail: tcp.reachable
        ? `${row.host}:${row.port} 可连接`
        : `${row.host}:${row.port} 不可连接：${tcp.error}`,
    });
    if (!tcp.reachable) {
      return {
        ok: false,
        stages,
        fingerprint: row.fingerprint,
        currentFingerprint: '',
        uname: '',
        warnings: ['端口不可达：请检查主机是否开机、sshd 是否运行、防火墙是否放行。'],
      };
    }
    /** 连接参数 */
    const target = this.targetOf(row, (key) => {
      observed = fingerprintOf(key);
      return row.fingerprint === '' || row.fingerprint === observed;
    });
    /** 握手与认证起始时刻 */
    const started = Date.now();
    /** 已建立的连接 */
    let client: Awaited<ReturnType<RemoteSshService['open']>> | null = null;
    try {
      client = await this.sshSrv.open(target.config);
    } catch (err) {
      /** 会话错误 */
      const remoteErr =
        err instanceof RemoteError
          ? err
          : new RemoteError('UNKNOWN', String(err));
      // 注：认证失败与指纹不一致是两回事，前者握手是通的，故拆成两段分别展示
      if (remoteErr.code === 'HOST_KEY_CHANGED') {
        stages.push({
          name: '主机身份',
          ok: false,
          latencyMs: Date.now() - started,
          detail: `指纹与记录不一致：已记录 ${row.fingerprint || '（无）'}，当前 ${observed || '（未取到）'}`,
        });
      } else if (remoteErr.code === 'AUTH_FAILED') {
        stages.push({
          name: '握手',
          ok: true,
          latencyMs: Date.now() - started,
          detail: 'SSH 协议握手完成',
        });
        stages.push({
          name: '认证',
          ok: false,
          latencyMs: 0,
          detail: remoteErr.message,
        });
      } else {
        stages.push({
          name: '握手',
          ok: false,
          latencyMs: Date.now() - started,
          detail: remoteErr.message,
        });
      }
      return {
        ok: false,
        stages,
        fingerprint: row.fingerprint,
        currentFingerprint: observed,
        uname: '',
        warnings: [remoteErr.message],
      };
    }
    stages.push({
      name: '握手',
      ok: true,
      latencyMs: Date.now() - started,
      detail: 'SSH 协议握手完成',
    });
    stages.push({
      name: '认证',
      ok: true,
      latencyMs: 0,
      detail: `已用 ${row.authType === 'key' ? '私钥' : '密码'} 登录 ${row.username}`,
    });
    /** 环境信息 */
    let uname = '';
    try {
      uname = (await this.sshSrv.exec(client, UNAME_COMMAND)).trim();
      stages.push({
        name: '命令执行',
        ok: uname !== '',
        latencyMs: 0,
        detail: uname === '' ? '认证成功但命令无输出（可能被 ForceCommand 限制）' : uname,
      });
    } catch (err) {
      stages.push({
        name: '命令执行',
        ok: false,
        latencyMs: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    stages.push({
      name: '主机身份',
      ok: observed !== '' && (row.fingerprint === '' || row.fingerprint === observed),
      latencyMs: 0,
      detail:
        row.fingerprint === ''
          ? `尚未记录指纹，首次连接将信任 ${observed}`
          : row.fingerprint === observed
            ? `指纹一致：${observed}`
            : `指纹已变化：${row.fingerprint} → ${observed}`,
    });
    this.sshSrv.close(client, null);
    if (row.fingerprint === '') {
      warnings.push('该主机尚未记录公钥指纹，首次连接将按 TOFU 记录当前指纹。');
    }
    if (row.username === 'root') {
      warnings.push('当前以 root 登录，任何误操作都无法靠权限边界兜底。');
    }
    if (row.port !== 22) {
      warnings.push(`使用了非默认 SSH 端口 ${row.port}，请确认不是端口转发到别的主机。`);
    }
    return {
      ok: stages.every((stage) => stage.ok),
      stages,
      fingerprint: row.fingerprint,
      currentFingerprint: observed,
      uname,
      warnings,
    };
  }

  /**
   * 记录主机指纹（首连 TOFU 与用户显式确认后调用）
   *
   * @param id 主机ID
   * @param fingerprint 指纹
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 主机ID
   */
  async rememberFingerprint(
    id: number,
    fingerprint: string,
    userId: number = 0,
    reqId: number = 0,
  ) {
    return super.update(id, { fingerprint }, userId, reqId);
  }

  /**
   * 获取主机的连接信息
   *
   * 注：凭据在这里解密，且只在服务端内存里存在
   *
   * @param id 主机ID
   * @returns 连接信息
   * @throws NotFoundException 主机不存在时抛出
   * @throws UnprocessableEntityException 凭据解密失败时抛出
   */
  async target(id: number): Promise<RemoteTarget> {
    /** 主机 */
    const row = await this.row(id);
    if (row === null) {
      throw new NotFoundException('指定主机不存在！');
    }
    if (!row.status) {
      throw new UnprocessableEntityException('该主机已被禁用，请先启用后再连接！');
    }
    /** 本次握手观察到的主机指纹 */
    let observed = '';
    /** 连接信息 */
    const target = this.targetOf(row, (key) => {
      observed = fingerprintOf(key);
      // 注：未记录指纹时按 TOFU 放行（首连）；一旦记录过就必须一致 —— 不一致返回 false，
      // 让 ssh2 在**认证之前**中止，绝不把密码 / 私钥交给未经验证的主机
      return row.fingerprint === '' || row.fingerprint === observed;
    });
    target.observed = () => observed;
    return target;
  }

  /**
   * 取含凭据的原始记录
   *
   * @param id 主机ID
   * @returns 原始记录，不存在时为 null
   */
  private async row(id: number): Promise<RemoteEntity | null> {
    return this.remoteRepository.findOne({
      where: { id } as FindOptionsWhere<RemoteEntity>,
    });
  }

  /**
   * 组装 ssh2 连接参数
   *
   * @param row 含凭据的记录
   * @param hostVerifier 主机公钥校验
   * @returns SSH 连接参数
   * @throws UnprocessableEntityException 凭据解密失败时抛出
   */
  private targetOf(
    row: RemoteEntity,
    hostVerifier: (key: Buffer) => boolean,
  ): RemoteTarget {
    /** 是否私钥鉴权 */
    const byKey = row.authType === 'key';
    /** 连接参数 */
    const config: SshConfig = {
      host: row.host,
      port: row.port,
      username: row.username,
      hostVerifier,
    };
    if (byKey) {
      config.privateKey = this.decrypt(row.privateKey);
      /** 私钥口令 */
      const passphrase = this.decrypt(row.passphrase);
      if (passphrase !== '') {
        config.passphrase = passphrase;
      }
    } else {
      config.password = this.decrypt(row.password);
    }
    return {
      config,
      charset: row.charset || DEFAULT_CHARSET,
      fingerprint: row.fingerprint,
      // 注：占位实现，需要观察指纹的调用方（`target` / `diagnose`）会自己包一层闭包
      observed: () => '',
    };
  }

  /**
   * 建立连接、执行动作、无论成败都断开
   *
   * @param target 连接信息
   * @param run 动作
   * @returns 动作结果
   * @throws HttpException 连接失败时抛出（已按原因映射状态码）
   */
  private async withClient<T>(
    target: RemoteTarget,
    run: (client: Awaited<ReturnType<RemoteSshService['open']>>) => Promise<T>,
  ): Promise<T> {
    /** 已建立的连接 */
    let client: Awaited<ReturnType<RemoteSshService['open']>> | null = null;
    try {
      client = await this.sshSrv.open(target.config);
      return await run(client);
    } catch (err) {
      throw httpErrorOf(err);
    } finally {
      this.sshSrv.close(client, null);
    }
  }

  /**
   * 加密凭据
   *
   * @param plain 明文，注：空串原样返回
   * @returns 密文
   */
  private encrypt(plain: string): string {
    if (plain === '') {
      return '';
    }
    return encryptSecret(plain, this.settingKey());
  }

  /**
   * 解密凭据
   *
   * @param value 密文，注：不带 `enc:v1:` 前缀的值按明文使用（兼容手工 SQL 导入）
   * @returns 明文
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
        '凭据解密失败，请重新录入密码 / 私钥（SETTING_KEY 可能已被更换）！',
      );
    }
  }

  /**
   * 取加解密密钥
   *
   * @returns `SETTING_KEY` 环境变量
   * @throws InternalServerErrorException 未配置时抛出，注：不给「缺密钥就存明文」留后门
   */
  private settingKey(): string {
    /** 密钥口令 */
    const key = (process.env.SETTING_KEY ?? '').trim();
    if (key === '') {
      throw new InternalServerErrorException(
        '未配置 SETTING_KEY 环境变量，无法加解密远程主机的登录凭据！',
      );
    }
    return key;
  }

  /**
   * 实体 → 下发视图
   *
   * @param row 实体
   * @returns 视图，注：三列凭据替换成空串，另给 `hasXxx`
   */
  private view<T extends RemoteBaseEntity>(row: T): RemoteView<T> {
    // 注：用 `Object.assign` 而不是展开运算符 —— 这里刻意把实体复制成普通对象
    // （响应体不需要 TypeORM 实体的原型，且展开 class instance 会被 lint 判为可疑用法）
    return Object.assign({}, row, {
      password: '',
      privateKey: '',
      passphrase: '',
      hasPassword: (row.password ?? '') !== '',
      hasKey: (row.privateKey ?? '') !== '',
      hasPassphrase: (row.passphrase ?? '') !== '',
    }) as RemoteView<T>;
  }
}
