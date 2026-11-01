// 外部依赖
import { InternalServerErrorException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// 内部依赖
import { encryptSecret } from '../common/secret.util.js';
import {
  EMAIL_DEFAULT_HOST,
  EMAIL_DEFAULT_PORT,
  hasEnvSmtp,
  parseEmailSetting,
  secretKey,
  toEmailConfig,
} from './email.config.js';

/** 测试用密钥口令 */
const KEY = 'unit-test-key';

/** 一份完整配置 */
const SETTING = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  account: 'robot@example.com',
  name: '个人量化工具',
  replyTo: 'reply@example.com',
  password: encryptSecret('auth-code', KEY),
};

describe('email.config', () => {
  beforeEach(() => {
    delete process.env.SETTING_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_ACCOUNT;
    delete process.env.SMTP_PASSWORD;
  });

  afterEach(() => {
    delete process.env.SETTING_KEY;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_ACCOUNT;
    delete process.env.SMTP_PASSWORD;
  });

  it('完整配置逐字段解析', () => {
    expect(parseEmailSetting(SETTING)).toEqual(SETTING);
  });

  it('缺授权码 / 发件人 / 主机任一即视为未配置', () => {
    expect(parseEmailSetting({ ...SETTING, password: '' })).toBeNull();
    expect(parseEmailSetting({ ...SETTING, account: '  ' })).toBeNull();
    expect(parseEmailSetting({ ...SETTING, host: undefined })).toBeNull();
  });

  it('端口越界或非整数视为未配置，不拼半残连接器', () => {
    expect(parseEmailSetting({ ...SETTING, port: 0 })).toBeNull();
    expect(parseEmailSetting({ ...SETTING, port: 65536 })).toBeNull();
    expect(parseEmailSetting({ ...SETTING, port: 46.5 })).toBeNull();
  });

  it('secure 缺省为 true，端口可兼容字符串写法', () => {
    /** 缺 secure 且端口为字符串 */
    const parsed = parseEmailSetting({ ...SETTING, secure: undefined, port: '465' });
    expect(parsed?.secure).toBe(true);
    expect(parsed?.port).toBe(465);
  });

  it('非对象或空值返回 null，而不是抛错', () => {
    expect(parseEmailSetting(null)).toBeNull();
    expect(parseEmailSetting('smtp.example.com')).toBeNull();
  });

  it('默认主机与端口只用于表单初值', () => {
    expect(EMAIL_DEFAULT_HOST).toBe('smtp.163.com');
    expect(EMAIL_DEFAULT_PORT).toBe(465);
  });

  it('运行时配置会把密文授权码解开', () => {
    /** 合法配置 */
    const setting = parseEmailSetting(SETTING)!;
    expect(toEmailConfig(setting, KEY).password).toBe('auth-code');
  });

  it('不带前缀的明文授权码原样使用（兼容手工导入）', () => {
    /** 明文配置 */
    const setting = parseEmailSetting({ ...SETTING, password: 'plain-code' })!;
    expect(toEmailConfig(setting, KEY).password).toBe('plain-code');
  });

  it('密钥被更换时解密失败，不静默用错密码发信', () => {
    /** 合法配置 */
    const setting = parseEmailSetting(SETTING)!;
    expect(() => toEmailConfig(setting, 'another-key')).toThrow('密文解密失败');
  });

  it('replyTo 为空时不写进配置，避免发出空回复地址', () => {
    /** 合法配置 */
    const setting = parseEmailSetting({ ...SETTING, replyTo: '  ' })!;
    expect('replyTo' in toEmailConfig(setting, KEY)).toBe(false);
  });

  it('未配置 SETTING_KEY 时直接抛 500，不给「缺密钥就存明文」留后门', () => {
    expect(() => secretKey()).toThrow(InternalServerErrorException);
    process.env.SETTING_KEY = ' from-env ';
    expect(secretKey()).toBe('from-env');
  });

  it('只探测环境变量里是否还有 SMTP 残留，用于迁移提示', () => {
    expect(hasEnvSmtp()).toBe(false);
    process.env.SMTP_ACCOUNT = 'robot@example.com';
    expect(hasEnvSmtp()).toBe(true);
  });
});
