// 外部依赖
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Transporter, SendMailOptions, createTransport } from 'nodemailer';
// 内部依赖
import { SettingService } from '../setting/setting.service.js';
import { Email } from './email.interface.js';
import {
  EMAIL_SETTING_CODE,
  EmailConfig,
  parseEmailSetting,
  secretKey,
  toEmailConfig,
} from './email.config.js';

/** 连接器缓存有效期（毫秒） */
const CACHE_TTL = 60000;

/** 连接器缓存 */
interface TransportCache {
  /** 配置指纹，配置变更时据此重建连接器 */
  fingerprint: string;
  /** 过期时间（毫秒时间戳），注：兜住多实例下别处改了配置的情形 */
  expiresAt: number;
  /** 已建立的连接器 */
  transporter: Transporter;
  /** 已解密的配置 */
  config: EmailConfig;
}

/**
 * 取错误消息
 *
 * @param err 捕获到的异常
 * @returns 可读的错误消息
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 拼接发件人
 *
 * @param config 运行时配置
 * @returns `"名称" <邮箱>` 形式的发件人
 */
function fromOf(config: EmailConfig): string {
  // 注：显示名称里的双引号会破坏 RFC 5322 的 quoted-string，直接去掉
  return `"${config.name.replace(/"/g, '')}" <${config.account}>`;
}

/**
 * 邮件服务
 *
 * 注 1：配置来自系统设置（`settings.code = 'email'`），**不再读 `SMTP_*` 环境变量** ——
 * 库中未配置时直接报错，避免出现「改了 .env 却不知道没生效」的排查黑洞
 * 注 2：连接器按需建立并缓存（指纹 + 60 秒 TTL）：发信不再每次握手，配置变更后由管理端
 * 调 `invalidate()` 立即生效，其它实例最迟 TTL 到期跟进
 * 注 3：发送失败一律抛业务异常。旧的 `send()` 返回 `1/0`，而调用方（`UserService`）从不看返回值，
 * 于是「收不到验证码」被静默当成成功；这里让失败上浮，前端才能提示到用户
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /** 连接器缓存 */
  private cache?: TransportCache;

  /** 正在建立的连接器，注：并发发信时复用同一次建连，避免风暴 */
  private pending?: Promise<TransportCache>;

  /**
   * 构造函数
   *
   * @param settingSrv 配置服务
   */
  constructor(private readonly settingSrv: SettingService) {}

  /** 丢弃缓存，注：管理端保存配置后调用，使新配置立即生效 */
  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * 载入配置并建立连接器
   *
   * @returns 连接器与运行时配置
   * @throws UnprocessableEntityException 未配置 / 已停用 / 配置不完整或无法解密时抛出
   */
  private async load(): Promise<TransportCache> {
    /** 当前时间 */
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache;
    }
    if (this.pending) {
      return this.pending;
    }
    this.pending = this.connect();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  /**
   * 读取配置并建立连接器（不做缓存判断）
   *
   * @returns 连接器与运行时配置
   * @throws UnprocessableEntityException 配置不可用时抛出
   */
  private async connect(): Promise<TransportCache> {
    /** 配置记录 */
    const row = await this.settingSrv.show(EMAIL_SETTING_CODE);
    if (!row) {
      throw new UnprocessableEntityException(
        '邮件服务尚未配置，请先在「系统设置 → 邮件配置」中填写 SMTP 参数！',
      );
    }
    if (!row.status) {
      throw new UnprocessableEntityException(
        '邮件服务已停用，请先在「系统设置 → 邮件配置」中启用！',
      );
    }
    /** 解析后的配置 */
    const setting = parseEmailSetting(row.value);
    if (!setting) {
      throw new UnprocessableEntityException(
        '邮件配置不完整（主机 / 端口 / 发件邮箱 / 发件人 / 授权码缺一不可），请重新填写！',
      );
    }
    /** 运行时配置 */
    let config: EmailConfig;
    // 注：密钥缺失属部署错误，直接以 500 抛出，不要被下面的「无法解密」包成 422
    /** 加解密密钥 */
    const key = secretKey();
    try {
      config = toEmailConfig(setting, key);
    } catch (err) {
      throw new UnprocessableEntityException(
        `邮件配置无法解密（${errorText(err)}），请重新填写 SMTP 授权码！`,
      );
    }
    /** 配置指纹，注：库内 value 的任何字段变化都会触发重建 */
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(row.value))
      .digest('hex');
    // 指纹未变则只续期，不重建连接器
    if (this.cache && this.cache.fingerprint === fingerprint) {
      this.cache = { ...this.cache, expiresAt: Date.now() + CACHE_TTL };
      return this.cache;
    }
    /** 连接器 */
    const transporter = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.account, pass: config.password },
    });
    this.cache = {
      fingerprint,
      expiresAt: Date.now() + CACHE_TTL,
      transporter,
      config,
    };
    this.logger.debug(`邮件连接器已建立：${config.host}:${config.port}`);
    return this.cache;
  }

  /**
   * 发送邮件
   *
   * @param email 邮件内容（发件人由服务统一填充）
   * @throws UnprocessableEntityException 配置不可用时抛出
   * @throws InternalServerErrorException 投递失败时抛出
   */
  async send(email: Email): Promise<void> {
    /** 连接器与配置 */
    const { transporter, config } = await this.load();
    /** 待发送邮件 */
    const payload: SendMailOptions = {
      ...email,
      from: fromOf(config),
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
    };
    try {
      await transporter.sendMail(payload);
      this.logger.debug('邮件发送成功');
    } catch (err) {
      this.logger.warn(`邮件发送失败：${errorText(err)}`);
      throw new InternalServerErrorException(
        '邮件发送失败，请稍后重试或联系管理员！',
      );
    }
  }

  /**
   * 校验 SMTP 连接（管理端「发送测试邮件」前先握手）
   *
   * @throws UnprocessableEntityException 配置不可用或认证失败时抛出
   */
  async verify(): Promise<void> {
    /** 连接器 */
    const { transporter } = await this.load();
    try {
      await transporter.verify();
    } catch (err) {
      this.logger.warn(`SMTP 校验失败：${errorText(err)}`);
      throw new UnprocessableEntityException(
        `SMTP 连接校验失败：${errorText(err)}`,
      );
    }
  }
}
