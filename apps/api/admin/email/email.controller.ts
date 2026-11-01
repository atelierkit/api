// 外部依赖
import { Body, Controller, Get, Post, UnprocessableEntityException } from '@nestjs/common';
// 内部依赖
import {
  Allow,
  EMAIL_DEFAULT_HOST,
  EMAIL_DEFAULT_PORT,
  EMAIL_PASSWORD_MASK,
  EMAIL_SETTING_CODE,
  EmailService,
  ReqId,
  SettingService,
  UserId,
  encryptSecret,
  hasEnvSmtp,
  isSecret,
  parseEmailSetting,
  secretKey,
} from '@shared';
import { EmailSaveDto, EmailTestDto } from './email.dto.js';

/**
 * 邮件配置详情（下发结构）
 *
 * 注：授权码不下发，只回占位符与 `hasPassword` 标记；前端「留空即不改」的依据就是这两者
 */
export interface EmailSettingView {
  /** 配置来源，`db` 表示库中已有记录，`none` 表示尚未配置 */
  source: 'db' | 'none';
  /** 启用状态 */
  status: boolean;
  /** 配置值（授权码已脱敏） */
  value: {
    /** SMTP 主机 */
    host: string;
    /** SMTP 端口 */
    port: number;
    /** 是否使用 SSL 直连 */
    secure: boolean;
    /** 发件邮箱 */
    account: string;
    /** 发件人名称 */
    name: string;
    /** 回复地址 */
    replyTo: string;
    /** 授权码占位符，未配置时为空串 */
    password: string;
  };
  /** 是否已设置授权码 */
  hasPassword: boolean;
  /** `.env` 里是否还留着 SMTP 参数，注：仅作迁移提示，运行时不读它们 */
  envDetected: boolean;
  /** 更新信息 */
  update?: unknown;
}

/**
 * 取字符串字段
 *
 * @param value 原始值
 * @returns 字符串本身，非字符串时为空串
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 邮件配置控制器（管理端）
 *
 * 注 1：接口前缀 `admin/email` 与通用配置 `admin/setting` 分开 —— 授权码要脱敏、保存时要加密，
 * 通用 `AdminSettingController` 的整对象读写满足不了，且不宜为单个编码去覆盖父类路由
 * 注 2：投递库仍是 `settings` 表（`code = 'email'`），与备案配置共用一套变更日志与操作序号
 */
@Controller('admin/email')
@Allow('admin')
export class AdminEmailController {
  /**
   * 构造函数
   *
   * @param settingSrv 配置服务
   * @param emailSrv 邮件服务
   */
  constructor(
    private readonly settingSrv: SettingService,
    private readonly emailSrv: EmailService,
  ) {}

  /**
   * 获取邮件配置（授权码脱敏）
   *
   * @returns 配置详情，未配置时给出表单初值
   */
  @Get()
  async show(): Promise<EmailSettingView> {
    /** 配置记录 */
    const row = await this.settingSrv.show(EMAIL_SETTING_CODE);
    /** 库内配置值 */
    const raw = (row?.value ?? {}) as Record<string, unknown>;
    /** 授权码占位符，注：只要有值就回占位符，配置其它字段不完整也照样提示「已设置」 */
    const hasPassword = !!textOf(raw.password);
    return {
      source: row ? 'db' : 'none',
      status: row?.status ?? true,
      value: {
        host: textOf(raw.host) || EMAIL_DEFAULT_HOST,
        port: Number(raw.port) || EMAIL_DEFAULT_PORT,
        secure: raw.secure === undefined ? true : raw.secure === true,
        account: textOf(raw.account),
        name: textOf(raw.name),
        replyTo: textOf(raw.replyTo),
        password: hasPassword ? EMAIL_PASSWORD_MASK : '',
      },
      hasPassword,
      envDetected: hasEnvSmtp(),
      update: row?.update,
    };
  }

  /**
   * 保存邮件配置（无记录则创建）
   *
   * @param value 配置信息
   * @param userId 操作用户ID
   * @param reqId 请求日志ID
   * @returns 配置编码
   */
  @Post()
  async save(
    @Body() value: EmailSaveDto,
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    /** 原配置记录 */
    const row = await this.settingSrv.show(EMAIL_SETTING_CODE);
    /** 原配置（仅用于取回原授权码） */
    const setting = row ? parseEmailSetting(row.value) : null;
    /** 提交的授权码 */
    const incoming = value.password?.trim() ?? '';
    /** 是否给了新授权码，注：占位符等于没改 */
    const changed = !!incoming && incoming !== EMAIL_PASSWORD_MASK;
    /** 待落库的授权码 */
    let password = '';
    if (changed) {
      password = encryptSecret(incoming, secretKey());
    } else if (setting) {
      // 未改动：沿用原值；若历史数据是明文（手工导入），顺手转成密文
      password = isSecret(setting.password)
        ? setting.password
        : encryptSecret(setting.password, secretKey());
    }
    if (!password) {
      throw new UnprocessableEntityException(
        '请填写 SMTP 授权码（不是邮箱登录密码）！',
      );
    }
    /** 待保存的配置 */
    const payload = {
      code: EMAIL_SETTING_CODE,
      status: value.status ?? true,
      value: {
        host: value.host.trim(),
        port: value.port,
        secure: value.secure,
        account: value.account.trim(),
        name: value.name.trim(),
        replyTo: value.replyTo?.trim() ?? '',
        password,
      },
    };
    /** 保存结果 */
    const result = row
      ? await this.settingSrv.update(EMAIL_SETTING_CODE, payload, userId, reqId)
      : await this.settingSrv.create(payload, userId, reqId);
    // 让本实例立即用新配置发信，其它实例最迟 TTL 到期跟进
    this.emailSrv.invalidate();
    return result;
  }

  /**
   * 发送测试邮件
   *
   * @param value 收件邮箱
   * @returns 是否成功与耗时（毫秒）
   */
  @Post('test')
  async test(@Body() value: EmailTestDto) {
    /** 开始时间 */
    const start = Date.now();
    // 先握手再发信：认证失败能定位到「连接/登录」这一步，而不是笼统的发送失败
    await this.emailSrv.verify();
    await this.emailSrv.send({
      to: value.to.trim(),
      subject: '个人量化工具的测试邮件',
      html: `<p>这是一封来自「系统设置 → 邮件配置」的测试邮件。</p><p>收到即表示当前 SMTP 配置可用。</p>`,
    });
    return { ok: true, latencyMs: Date.now() - start };
  }
}
