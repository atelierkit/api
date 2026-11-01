// 外部依赖
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * 邮件配置保存DTO
 *
 * 注 1：字段是**平铺**的，不用 `{code, value, status}` 那套通用结构 —— 本接口只服务 `email` 这一个编码，
 * 平铺后每个字段都能挂校验，前端也不必自己拼 `value`
 * 注 2：`password` 留空表示「保持原授权码不变」；详情接口下发的是占位符 `***`，原样回传同样视为不变
 */
export class EmailSaveDto {
  /** SMTP 主机 */
  @IsString({ message: 'SMTP 主机必须是字符串' })
  @IsNotEmpty({ message: 'SMTP 主机不能为空' })
  host!: string;

  /** SMTP 端口 */
  @IsInt({ message: 'SMTP 端口必须是整数' })
  @Min(1, { message: 'SMTP 端口不能小于 1' })
  @Max(65535, { message: 'SMTP 端口不能大于 65535' })
  port!: number;

  /** 是否使用 SSL 直连（465 为 true，587 为 false） */
  @IsBoolean({ message: 'SSL 开关必须是布尔值' })
  secure!: boolean;

  /** 发件邮箱地址 */
  @IsEmail({}, { message: '发件邮箱格式不正确' })
  account!: string;

  /** 发件人显示名称 */
  @IsString({ message: '发件人名称必须是字符串' })
  @IsNotEmpty({ message: '发件人名称不能为空' })
  name!: string;

  /** 回复地址，注：留空表示不单独设置，故只在有值时校验格式 */
  @ValidateIf((value: EmailSaveDto) => !!value.replyTo)
  @IsEmail({}, { message: '回复地址格式不正确' })
  replyTo?: string;

  /** SMTP 授权码，注：留空或回传占位符表示保持原值 */
  @IsOptional()
  @IsString({ message: 'SMTP 授权码必须是字符串' })
  password?: string;

  /** 启用状态，缺省为启用 */
  @IsOptional()
  @IsBoolean({ message: '状态必须是布尔值' })
  status?: boolean;
}

/** 测试邮件DTO */
export class EmailTestDto {
  /** 收件邮箱 */
  @IsEmail({}, { message: '收件邮箱格式不正确' })
  to!: string;
}
