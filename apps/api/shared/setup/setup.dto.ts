// 内部依赖
import { RegisterDto } from '../user/user.dto.js';

/**
 * 初始化管理员账号DTO
 *
 * 注：字段与注册一致（用户名 / 密码 / 可选昵称、头像、邮箱），
 * 校验规则直接复用 RegisterDto，避免两套表单规则走偏
 */
export class SetupDto extends RegisterDto {}
