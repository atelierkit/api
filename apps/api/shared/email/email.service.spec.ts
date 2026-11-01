// 外部依赖
import {
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { encryptSecret } from '../common/secret.util.js';
import { SettingService } from '../setting/setting.service.js';
import { EmailService } from './email.service.js';

/** 测试用密钥口令 */
const KEY = 'unit-test-key';

/** 发送桩与建连桩，注：`vi.mock` 被提升，只能用 `vi.hoisted` 里的对象 */
const mailer = vi.hoisted(() => {
  /** 发送桩 */
  const sendMail = vi.fn(async (_payload: unknown) => ({ accepted: [] }));
  /** 握手桩 */
  const verify = vi.fn(async () => true);
  /** 建连桩 */
  const createTransport = vi.fn((_options: unknown) => ({ sendMail, verify }));
  return { sendMail, verify, createTransport };
});

vi.mock('nodemailer', () => ({ createTransport: mailer.createTransport }));

/** 待发送邮件 */
const MAIL = {
  to: 'user@example.com',
  subject: '验证码',
  html: '<p>123456</p>',
};

/**
 * 组装一条配置记录
 *
 * @param value 覆盖的配置字段
 * @param status 启用状态
 * @returns 配置记录
 */
function rowOf(
  value: Record<string, unknown> = {},
  status = true,
): { code: string; status: boolean; value: Record<string, unknown> } {
  return {
    code: 'email',
    status,
    value: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      account: 'robot@example.com',
      name: '个人量化工具',
      password: encryptSecret('auth-code', KEY),
      ...value,
    },
  };
}

/**
 * 组装被测服务
 *
 * @param row 配置记录，null 表示未配置
 * @returns 被测服务与配置服务替身
 */
function serviceOf(row: unknown = rowOf()) {
  /** 配置服务替身 */
  const settingSrv = { show: vi.fn(async (_code: string) => row) };
  /** 被测服务 */
  const service = new EmailService(settingSrv as unknown as SettingService);
  return { service, settingSrv };
}

describe('EmailService', () => {
  beforeEach(() => {
    process.env.SETTING_KEY = KEY;
    mailer.sendMail.mockClear();
    mailer.verify.mockClear();
    mailer.createTransport.mockClear();
    // 服务内部有 debug / warn 日志，测试里静音
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.SETTING_KEY;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('发件人与回复地址由服务统一填充，调用方无需关心', async () => {
    /** 被测服务 */
    const { service } = serviceOf(rowOf({ replyTo: 'reply@example.com' }));
    await service.send(MAIL);
    /** 实际发送内容 */
    const payload = mailer.sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.from).toBe('"个人量化工具" <robot@example.com>');
    expect(payload.replyTo).toBe('reply@example.com');
    expect(payload.to).toBe(MAIL.to);
    expect(payload.subject).toBe(MAIL.subject);
  });

  it('显示名称里的双引号会被去掉，避免破坏发件人格式', async () => {
    /** 被测服务 */
    const { service } = serviceOf(rowOf({ name: '个人"量化"工具' }));
    await service.send(MAIL);
    /** 实际发送内容 */
    const payload = mailer.sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.from).toBe('"个人量化工具" <robot@example.com>');
  });

  it('库里没有配置时直接报错，不回落到环境变量', async () => {
    /** 被测服务 */
    const { service } = serviceOf(null);
    process.env.SMTP_ACCOUNT = 'env@example.com';
    await expect(service.send(MAIL)).rejects.toThrow('尚未配置');
    expect(mailer.createTransport).not.toHaveBeenCalled();
    delete process.env.SMTP_ACCOUNT;
  });

  it('配置被停用时拒绝发信', async () => {
    /** 被测服务 */
    const { service } = serviceOf(rowOf({}, false));
    await expect(service.send(MAIL)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(service.send(MAIL)).rejects.toThrow('已停用');
  });

  it('配置缺字段时提示重新填写，而不是抛底层错误', async () => {
    /** 被测服务 */
    const { service } = serviceOf(rowOf({ account: '' }));
    await expect(service.send(MAIL)).rejects.toThrow('配置不完整');
  });

  it('缺少 SETTING_KEY 属部署错误，按 500 抛出', async () => {
    delete process.env.SETTING_KEY;
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(service.send(MAIL)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('密钥被更换导致无法解密时提示重填授权码', async () => {
    process.env.SETTING_KEY = 'another-key';
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(service.send(MAIL)).rejects.toThrow('无法解密');
  });

  it('投递失败抛 500，不再静默返回 0', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    mailer.sendMail.mockRejectedValueOnce(new Error('SMTP 连接超时'));
    await expect(service.send(MAIL)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('连接器在 TTL 内复用，不重复查库与握手', async () => {
    /** 被测服务与替身 */
    const { service, settingSrv } = serviceOf();
    await service.send(MAIL);
    await service.send(MAIL);
    expect(settingSrv.show).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
  });

  it('invalidate 后立即重建（管理端保存配置后即时生效）', async () => {
    /** 被测服务与替身 */
    const { service, settingSrv } = serviceOf();
    await service.send(MAIL);
    service.invalidate();
    await service.send(MAIL);
    expect(settingSrv.show).toHaveBeenCalledTimes(2);
    expect(mailer.createTransport).toHaveBeenCalledTimes(2);
  });

  it('TTL 到期后重新查库；配置没变则只续期不重建连接器', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    /** 被测服务与替身 */
    const { service, settingSrv } = serviceOf();
    await service.send(MAIL);
    // 推进到 TTL 之后
    vi.setSystemTime(new Date('2026-11-01T00:02:00Z'));
    await service.send(MAIL);
    expect(settingSrv.show).toHaveBeenCalledTimes(2);
    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
  });

  it('TTL 到期后发现配置被改（指纹变化）则重建连接器', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    /** 被测服务与替身 */
    const { service, settingSrv } = serviceOf();
    await service.send(MAIL);
    settingSrv.show.mockResolvedValue(rowOf({ host: 'smtp.qq.com' }));
    vi.setSystemTime(new Date('2026-11-01T00:02:00Z'));
    await service.send(MAIL);
    expect(mailer.createTransport).toHaveBeenCalledTimes(2);
    /** 新建连入参 */
    const options = mailer.createTransport.mock.calls[1][0] as Record<
      string,
      unknown
    >;
    expect(options.host).toBe('smtp.qq.com');
  });

  it('并发发信只建一次连接器', async () => {
    /** 被测服务与替身 */
    const { service, settingSrv } = serviceOf();
    await Promise.all([service.send(MAIL), service.send(MAIL)]);
    expect(settingSrv.show).toHaveBeenCalledTimes(1);
    expect(mailer.createTransport).toHaveBeenCalledTimes(1);
  });

  it('verify 成功即静默返回', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    await expect(service.verify()).resolves.toBeUndefined();
    expect(mailer.verify).toHaveBeenCalledTimes(1);
  });

  it('verify 失败带出原始原因，便于管理页排查', async () => {
    /** 被测服务 */
    const { service } = serviceOf();
    mailer.verify.mockRejectedValueOnce(new Error('Invalid login'));
    await expect(service.verify()).rejects.toThrow('Invalid login');
  });
});
