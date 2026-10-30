// 外部依赖
import { InternalServerErrorException, Logger } from '@nestjs/common';
import { Transporter } from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import { EmailService } from './email.service.js';

/** 待发送邮件 */
const MAIL = {
  to: 'user@example.com',
  subject: '验证码',
  html: '<p>123456</p>',
};

describe('EmailService', () => {
  beforeEach(() => {
    // 注：不设置 SMTP_HOST，构造函数只组装配置，不会真的连接
    process.env.SMTP_USER = '个人量化工具';
    process.env.SMTP_ACCOUNT = 'robot@example.com';
    // 服务内部有 debug 日志，测试里静音
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_ACCOUNT;
    vi.restoreAllMocks();
  });

  it('发件人由服务统一拼接，调用方无需关心', async () => {
    /** 邮件服务 */
    const service = new EmailService();
    /** 发送桩 */
    const sendMail = vi.fn(async (_payload: unknown) => ({ accepted: [] }));
    service.transporter = { sendMail } as unknown as Transporter;

    expect(await service.send(MAIL)).toBe(1);
    /** 实际发送内容 */
    const payload = sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.from).toBe('"个人量化工具" <robot@example.com>');
    expect(payload.to).toBe(MAIL.to);
    expect(payload.subject).toBe(MAIL.subject);
  });

  it('发送失败只返回 0，不往上抛（不阻断验证码流程）', async () => {
    /** 邮件服务 */
    const service = new EmailService();
    service.transporter = {
      sendMail: vi.fn(async () => {
        throw new Error('SMTP 连接超时');
      }),
    } as unknown as Transporter;

    await expect(service.send(MAIL)).resolves.toBe(0);
  });

  it('缺少发件人配置时抛 500，避免发出没有 From 的邮件', async () => {
    delete process.env.SMTP_ACCOUNT;
    /** 邮件服务 */
    const service = new EmailService();
    service.transporter = {
      sendMail: vi.fn(async () => ({ accepted: [] })),
    } as unknown as Transporter;

    await expect(service.send(MAIL)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
