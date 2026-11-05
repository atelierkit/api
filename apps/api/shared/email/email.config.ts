// 外部依赖
import { InternalServerErrorException } from '@nestjs/common';
// 内部依赖
import { decryptSecret, isSecret } from '../common/secret.util.js';

/** 邮件配置在系统设置里的编码（主键） */
export const EMAIL_SETTING_CODE = 'email';

/** 密码占位符，注：详情接口下发它代表「已配置、但不下发明文」 */
export const EMAIL_PASSWORD_MASK = '***';

/** 默认 SMTP 主机，注：仅用于表单初值，运行时不回落到环境变量 */
export const EMAIL_DEFAULT_HOST = 'smtp.163.com';

/** 默认 SMTP 端口（SSL 加密端口） */
export const EMAIL_DEFAULT_PORT = 465;

/** 邮件配置（`settings.value` 的库内结构，`password` 为密文） */
export interface EmailSetting {
  /** SMTP 主机 */
  host: string;
  /** SMTP 端口 */
  port: number;
  /** 是否使用 SSL 直连（465 为 true，587 为 false） */
  secure: boolean;
  /** 发件邮箱地址 */
  account: string;
  /** 发件人显示名称 */
  name: string;
  /** 回复地址，缺省表示不单独设置 */
  replyTo?: string;
  /** SMTP 授权码（库内为密文，不是邮箱登录密码） */
  password: string;
}

/** 运行时可用的邮件配置（`password` 已解密） */
export interface EmailConfig {
  /** SMTP 主机 */
  host: string;
  /** SMTP 端口 */
  port: number;
  /** 是否使用 SSL 直连 */
  secure: boolean;
  /** 发件邮箱地址 */
  account: string;
  /** 发件人显示名称 */
  name: string;
  /** 回复地址 */
  replyTo?: string;
  /** SMTP 授权码明文 */
  password: string;
}

/**
 * 取字符串字段并去空白
 *
 * @param value 原始值
 * @returns 去空白后的字符串，非字符串时为 null
 */
function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * 解析库内配置
 *
 * 注 1：`value` 是 json 列，历史数据/手工 SQL 写入都可能缺字段，故逐字段校验而不是直接断言类型
 * 注 2：`host` / `account` / `name` / `password` 缺一即视为「未配置」，`port` 越界同样视为缺失 ——
 * 拼一个半残的连接器只会让发信在运行时抛更难懂的错误
 *
 * @param value `settings.value`
 * @returns 合法配置；缺字段或取值非法时为 null
 */
export function parseEmailSetting(value: unknown): EmailSetting | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  /** 待解析的配置对象 */
  const raw = value as Record<string, unknown>;
  /** SMTP 主机 */
  const host = textOf(raw.host);
  /** 发件邮箱 */
  const account = textOf(raw.account);
  /** 发件人名称 */
  const name = textOf(raw.name);
  /** SMTP 授权码 */
  const password = textOf(raw.password);
  /** SMTP 端口，注：兼容手工写成字符串的旧数据 */
  const port = Number(raw.port ?? EMAIL_DEFAULT_PORT);
  if (
    !host ||
    !account ||
    !name ||
    !password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return null;
  }
  /** 回复地址 */
  const replyTo = textOf(raw.replyTo);
  return {
    host,
    port,
    secure: raw.secure === undefined ? true : raw.secure === true,
    account,
    name,
    ...(replyTo ? { replyTo } : {}),
    password,
  };
}

/**
 * 取加解密密钥
 *
 * @returns `SETTING_KEY` 环境变量
 * @throws InternalServerErrorException 未配置时抛出，注：不给「缺密钥就存明文」留后门
 */
export function secretKey(): string {
  /** 密钥口令 */
  const key = textOf(process.env.SETTING_KEY);
  if (!key) {
    throw new InternalServerErrorException(
      '未配置 SETTING_KEY 环境变量，无法加解密邮件授权码！',
    );
  }
  return key;
}

/**
 * 库内配置 → 运行时配置（解密授权码）
 *
 * 注：不带 `enc:v1:` 前缀的值按明文使用 —— 兼容手工 SQL 一次性导入的历史数据，
 * 在管理页保存一次后即转为密文；解密失败（密钥被更换）会抛错，不会静默用错密码发信
 *
 * @param setting 库内配置
 * @param key 加解密密钥
 * @returns 运行时可用的配置
 * @throws Error 密文解密失败时抛出
 */
export function toEmailConfig(setting: EmailSetting, key: string): EmailConfig {
  return {
    host: setting.host,
    port: setting.port,
    secure: setting.secure,
    account: setting.account,
    name: setting.name,
    ...(setting.replyTo ? { replyTo: setting.replyTo } : {}),
    password: isSecret(setting.password)
      ? decryptSecret(setting.password, key)
      : setting.password,
  };
}

/**
 * 环境变量里是否还留着 SMTP 参数
 *
 * 注：只用于管理页提示「邮件配置在系统设置里维护，`SMTP_*` 已不生效，可删除」，
 * 运行时**不**从环境变量取值（也绝不下发其中的授权码）
 *
 * @returns 存在任一 SMTP 变量时为 true
 */
export function hasEnvSmtp(): boolean {
  return [process.env.SMTP_HOST, process.env.SMTP_ACCOUNT, process.env.SMTP_PASSWORD]
    .some((item) => !!textOf(item));
}
