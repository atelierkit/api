// 外部依赖
import { Controller } from '@nestjs/common';
// 内部依赖
import {
  Allow,
  CommonController,
  UserManageCreateDto,
  UserManageUpdateDto,
  UserService,
} from '@shared';

/**
 * 管理用户控制器
 *
 * 注：类名与 `shared/user/user.controller.ts` 的 `UserController` 刻意区分 ——
 * 请求日志按类名记录（`reqs.controller`），同名会让管理端与个人端的请求无法区分
 */
@Controller('auth/user')
@Allow('admin')
export class AuthUserController extends CommonController<
  UserService,
  UserManageCreateDto,
  UserManageUpdateDto
> {
  /**
   * 构造函数
   *
   * @param userSrv 用户服务
   */
  constructor(protected readonly userSrv: UserService) {
    super(userSrv);
  }
}
