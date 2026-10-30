// 外部依赖
import {
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsIn,
  IsString,
  MaxLength,
} from 'class-validator';
// 内部依赖
import { TOKEN_VALIDS } from '../token/token.constant.js';
import { PASSWORD_MAX } from './user.constant.js';

/**
 * 注册信息DTO
 *
 * 注：用户名与密码的完整规则（归一化、复杂度、与用户名不同）由 UserService 统一校验，
 * 这里只做「必填 + 类型 + 长度上限」的粗筛，避免两处规则各写一份后走偏
 */
export class RegisterDto {
  /** 登录用户名 */
  @IsString({ message: '用户名格式不正确！' })
  @IsNotEmpty({ message: '用户名不能为空！' })
  username!: string;

  /** 密码 */
  @IsString({ message: '密码格式不正确！' })
  @IsNotEmpty({ message: '密码不能为空！' })
  @MaxLength(PASSWORD_MAX, { message: `密码长度不能超过${PASSWORD_MAX}位！` })
  password!: string;

  /** 昵称 */
  @IsOptional()
  @IsString({ message: '昵称格式不正确！' })
  name?: string;

  /** 头像URL */
  @IsOptional()
  @IsString({ message: '头像URL格式不正确！' })
  avatar?: string;

  /** 电子邮箱，注：可选资料，仅用于找回密码与通知 */
  @IsOptional()
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email?: string;
}

/** 登录信息DTO */
export class LoginDto {
  /** 登录用户名 */
  @IsString({ message: '用户名格式不正确！' })
  @IsNotEmpty({ message: '用户名不能为空！' })
  username!: string;

  /** 密码 */
  @IsString({ message: '密码格式不正确！' })
  @IsNotEmpty({ message: '密码不能为空！' })
  password!: string;
}

/** 用户名查重DTO */
export class CheckDto {
  /** 登录用户名 */
  @IsString({ message: '用户名格式不正确！' })
  @IsNotEmpty({ message: '用户名不能为空！' })
  username!: string;
}

/** 修改密码DTO */
export class PasswordDto {
  /** 原密码 */
  @IsString({ message: '原密码格式不正确！' })
  @IsNotEmpty({ message: '原密码不能为空！' })
  oldPassword!: string;

  /** 新密码 */
  @IsString({ message: '新密码格式不正确！' })
  @IsNotEmpty({ message: '新密码不能为空！' })
  @MaxLength(PASSWORD_MAX, { message: `密码长度不能超过${PASSWORD_MAX}位！` })
  newPassword!: string;
}

/** 重置密码-发送验证码DTO */
export class ResetCodeDto {
  /** 电子邮箱 */
  @IsNotEmpty({ message: '电子邮箱不能为空！' })
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email!: string;
}

/** 重置密码-提交校验DTO */
export class ResetDto {
  /** 电子邮箱 */
  @IsNotEmpty({ message: '电子邮箱不能为空！' })
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email!: string;

  /** 邮箱验证码 */
  @IsNotEmpty({ message: '验证码不能为空！' })
  @IsString({ message: '验证码格式不正确！' })
  code!: string;

  /** 新密码 */
  @IsString({ message: '新密码格式不正确！' })
  @IsNotEmpty({ message: '新密码不能为空！' })
  @MaxLength(PASSWORD_MAX, { message: `密码长度不能超过${PASSWORD_MAX}位！` })
  password!: string;
}

/** 用户信息修改DTO */
export class UserUpdateDto {
  /** 昵称 */
  @IsNotEmpty({ message: '昵称不能为空' })
  name!: string;

  /** 头像URL */
  @IsNotEmpty({ message: '头像URL不能为空' })
  avatar!: string;
}

/** 令牌有效期设置DTO */
export class TokenValidDto {
  /** 令牌有效期（单位：分钟），注：0 表示长期有效，取值必须在可选档位内 */
  @IsIn(TOKEN_VALIDS, { message: '令牌有效期不合法！' })
  valid!: number;
}
