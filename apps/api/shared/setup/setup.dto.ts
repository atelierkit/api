// 外部依赖
import { IsOptional, IsString } from 'class-validator';
// 内部依赖
import { RegisterDto } from '../user/user.dto.js';

/**
 * 初始化管理员账号DTO
 *
 * 注：字段与注册一致（用户名 / 密码 / 可选昵称、头像、邮箱），
 * 校验规则直接复用 RegisterDto，避免两套表单规则走偏
 */
export class SetupDto extends RegisterDto {
  /**
   * 设备标识
   *
   * 注：由客户端生成并在本地持久化，初始化成功即完成登录，需与后续登录落在同一设备分组
   */
  @IsOptional()
  @IsString({ message: '设备标识格式不正确！' })
  deviceId?: string;
}
