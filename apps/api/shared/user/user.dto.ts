// 外部依赖
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsIn,
  IsString,
  MaxLength,
  ValidateIf,
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

  /**
   * 设备标识
   *
   * 注 1：由客户端生成并在本地持久化，同一设备重复登录只保留一个令牌，不同设备互不影响
   * 注 2：不做格式强校验 —— 这个值只用于会话归组，格式非法时归入统一分组即可，不该阻断登录
   */
  @IsOptional()
  @IsString({ message: '设备标识格式不正确！' })
  deviceId?: string;
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

/** 更换邮箱-发送验证码DTO */
export class EmailCodeDto {
  /** 新邮箱，注：验证码发到这里；改绑成功前原邮箱仍然有效 */
  @IsNotEmpty({ message: '电子邮箱不能为空！' })
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email!: string;
}

/** 更换邮箱-确认DTO */
export class EmailConfirmDto {
  /** 新邮箱，注：必须与发送验证码时提交的邮箱一致，否则验证码不认 */
  @IsNotEmpty({ message: '电子邮箱不能为空！' })
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email!: string;

  /** 邮箱验证码 */
  @IsNotEmpty({ message: '验证码不能为空！' })
  @IsString({ message: '验证码格式不正确！' })
  code!: string;
}

/** 用户信息修改DTO */
export class UserUpdateDto {
  /** 昵称 */
  @IsNotEmpty({ message: '昵称不能为空' })
  name!: string;

  /**
   * 头像
   *
   * 注：**可选** —— 不设头像的用户，页头回退到名字首字符，不该因此连昵称都改不了；
   * 空串表示清空。值可以是存储 key（新上传）、`/static/...`（历史数据）或外链，服务端只 trim
   */
  @IsOptional()
  @IsString({ message: '头像格式不正确！' })
  avatar?: string;
}

/** 令牌有效期设置DTO */
export class TokenValidDto {
  /** 令牌有效期（单位：分钟），注：0 表示长期有效，取值必须在可选档位内 */
  @IsIn(TOKEN_VALIDS, { message: '令牌有效期不合法！' })
  valid!: number;
}

/**
 * 管理端-用户创建DTO
 *
 * 注：与 `UserUpdateDto`（登录用户改自己的资料）区分，此处是管理员建号，
 * 因此必须带登录凭据；用户名与密码的完整规则由 UserService 统一校验
 */
export class UserManageCreateDto {
  /** 登录用户名 */
  @IsString({ message: '用户名格式不正确！' })
  @IsNotEmpty({ message: '用户名不能为空！' })
  username!: string;

  /** 登录密码（明文提交，服务端负责校验与哈希后入库） */
  @IsString({ message: '密码格式不正确！' })
  @IsNotEmpty({ message: '密码不能为空！' })
  @MaxLength(PASSWORD_MAX, { message: `密码长度不能超过${PASSWORD_MAX}位！` })
  password!: string;

  /** 昵称，注：缺省时取用户名 */
  @IsOptional()
  @IsString({ message: '昵称格式不正确！' })
  name?: string;

  /** 头像URL */
  @IsOptional()
  @IsString({ message: '头像URL格式不正确！' })
  avatar?: string;

  /** 电子邮箱，注：可选资料，空串视为未填写（否则撞 users.email 的唯一索引） */
  @ValidateIf((_value: UserManageCreateDto, email?: string) => !!email)
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email?: string;

  /** 启用状态，true表示启用，false表示禁用，注：缺省为启用 */
  @IsOptional()
  @IsBoolean({ message: '启用状态格式不正确！' })
  status?: boolean;

  /** 用户授权角色，注：缺省为空（不含任何管理权限） */
  @IsOptional()
  @IsArray({ message: '授权角色格式不正确！' })
  @IsString({ each: true, message: '授权角色格式不正确！' })
  roles?: string[];
}

/**
 * 管理端-用户信息修改DTO
 *
 * 注：只改资料与权限，不含改密 —— 改密走用户自己的 `/user/password`
 * 或 `/passport/reset`（邮箱验证码），避免管理员接口顺手重置他人密码
 */
export class UserManageUpdateDto {
  /** 昵称 */
  @IsOptional()
  @IsString({ message: '昵称格式不正确！' })
  name?: string;

  /** 头像URL */
  @IsOptional()
  @IsString({ message: '头像URL格式不正确！' })
  avatar?: string;

  /** 电子邮箱，注：可选资料，空串表示清空（落库为 NULL） */
  @ValidateIf((_value: UserManageUpdateDto, email?: string) => !!email)
  @IsEmail({}, { message: '电子邮箱格式不正确！' })
  email?: string;

  /** 启用状态，true表示启用，false表示禁用 */
  @IsOptional()
  @IsBoolean({ message: '启用状态格式不正确！' })
  status?: boolean;

  /** 用户授权角色 */
  @IsOptional()
  @IsArray({ message: '授权角色格式不正确！' })
  @IsString({ each: true, message: '授权角色格式不正确！' })
  roles?: string[];
}
