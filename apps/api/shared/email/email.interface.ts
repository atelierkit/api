/** 邮件（注：发件人由邮件服务统一填充，不对外提供） */
export interface Email {
  /** 收件人邮箱 */
  to: string;

  /** 邮件主题 */
  subject: string;

  /** HTML内容 */
  html: string;
}
