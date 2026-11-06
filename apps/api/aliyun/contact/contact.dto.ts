// 外部依赖
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** 手机号格式，注：与申请表单的校验保持一致 */
const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/**
 * 创建申请联系人DTO
 *
 * 注：这些字段最终会原样透传给 `CreateDVOrderAudit`，故与阿里云参数表同名同义
 */
export class ContactCreateDto {
  /** 备注名 */
  @IsOptional()
  @IsString()
  @MaxLength(32, { message: '备注名不能超过 32 个字符！' })
  name?: string;

  /** 申请人姓名 */
  @IsString()
  @IsNotEmpty({ message: '申请人姓名不能为空！' })
  @MaxLength(64, { message: '申请人姓名不能超过 64 个字符！' })
  username!: string;

  /** 申请人邮箱 */
  @IsEmail({}, { message: '邮箱格式不正确！' })
  @MaxLength(128, { message: '邮箱不能超过 128 个字符！' })
  email!: string;

  /** 申请人手机号 */
  @IsString()
  @Matches(MOBILE_PATTERN, { message: '手机号格式不正确！' })
  phone!: string;

  /** 省份（拼音） */
  @IsString()
  @IsNotEmpty({ message: '省份不能为空！' })
  @MaxLength(64, { message: '省份不能超过 64 个字符！' })
  province!: string;

  /** 城市（拼音） */
  @IsString()
  @IsNotEmpty({ message: '城市不能为空！' })
  @MaxLength(64, { message: '城市不能超过 64 个字符！' })
  city!: string;

  /**
   * 是否默认项
   *
   * 注：不能用 `@IsNotEmpty()` —— 它对 `false` 判空，新建一个非默认联系人会被误拒
   */
  @IsOptional()
  @IsBoolean({ message: '默认项格式不正确！' })
  isDefault?: boolean;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}

/**
 * 更新申请联系人DTO
 *
 * 注：字段全部可选，前端按需只提交改动项
 */
export class ContactUpdateDto {
  /** 备注名 */
  @IsOptional()
  @IsString()
  @MaxLength(32, { message: '备注名不能超过 32 个字符！' })
  name?: string;

  /** 申请人姓名 */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: '申请人姓名不能为空！' })
  @MaxLength(64, { message: '申请人姓名不能超过 64 个字符！' })
  username?: string;

  /** 申请人邮箱 */
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确！' })
  @MaxLength(128, { message: '邮箱不能超过 128 个字符！' })
  email?: string;

  /** 申请人手机号 */
  @IsOptional()
  @IsString()
  @Matches(MOBILE_PATTERN, { message: '手机号格式不正确！' })
  phone?: string;

  /** 省份（拼音） */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: '省份不能为空！' })
  @MaxLength(64, { message: '省份不能超过 64 个字符！' })
  province?: string;

  /** 城市（拼音） */
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: '城市不能为空！' })
  @MaxLength(64, { message: '城市不能超过 64 个字符！' })
  city?: string;

  /** 是否默认项 */
  @IsOptional()
  @IsBoolean({ message: '默认项格式不正确！' })
  isDefault?: boolean;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}
