// 外部依赖
import { Module } from '@nestjs/common';
// 内部依赖
import { SharedModule } from '@shared';
import { RoleController } from './role/role.controller.js';
import { TokenController } from './token/token.controller.js';
import { AuthUserController } from './user/user.controller.js';

/**
 * 访问控制模块
 *
 * 注：本模块只有管理端接口（角色 / 用户 / 令牌），全部由 `@Allow('admin')` 声明所需角色，
 * 鉴权本身由全局 `TokenGuard` 完成；旧私有项目里的分类（category）与产品（product）不迁移
 */
@Module({
  imports: [SharedModule],
  controllers: [RoleController, AuthUserController, TokenController],
})
export class AuthModule {}
