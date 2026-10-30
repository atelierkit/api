// 外部依赖
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Transporter, SendMailOptions, createTransport } from 'nodemailer';
// 内部依赖
import { Email } from './email.interface.js';

/** 邮件服务 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  /** 邮件发送器 */
  transporter: Transporter;

  /** 构造函数 */
  constructor() {
    this.transporter = createTransport({
      host: process.env.SMTP_HOST || 'smtp.163.com', // 如果是 126 邮箱，则用 smtp.126.com
      port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 465, // SSL 加密端口
      secure: true, // true for 465, false for other ports (如 587 则为 false)
      auth: {
        user: process.env.SMTP_ACCOUNT || 'your-email@163.com', // 你的网易邮箱地址
        pass: process.env.SMTP_PASSWORD || 'your-smtp-authorization-code', // 上面生成的【授权码】，不是邮箱密码！
      },
    });
  }

  /**
   * 默认发件人（仅服务内部使用）
   *
   * @returns 标准格式的发件人字符串
   * @throws InternalServerErrorException 未配置发件人环境变量时抛出
   */
  private get from(): string {
    if (!process.env.SMTP_USER || !process.env.SMTP_ACCOUNT) {
      throw new InternalServerErrorException(
        '未配置邮件发件人，请检查环境变量 SMTP_USER 与 SMTP_ACCOUNT！',
      );
    }
    return `"${process.env.SMTP_USER}" <${process.env.SMTP_ACCOUNT}>`;
  }

  /**
   * 发送邮件
   *
   * @param email 邮件内容
   * @returns 发送结果，1表示成功，0表示失败
   */
  async send(email: Email): Promise<number> {
    this.logger.debug('邮箱服务器准备完成');
    /** 待发送邮件，注：发件人由邮件服务统一填充 */
    const payload: SendMailOptions = { ...email, from: this.from };
    try {
      await this.transporter.sendMail(payload);
      this.logger.debug('邮件发送成功');
      return 1;
    } catch {
      this.logger.debug('邮件发送失败');
      return 0;
    }
  }
}
