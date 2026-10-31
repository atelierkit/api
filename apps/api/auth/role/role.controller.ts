// 外部依赖
import { Controller, Post, Body } from '@nestjs/common';
// 内部依赖
import { Allow, OptionController, ReqId, RoleService, UserId } from '@shared';
import { RoleSortDto, RoleUpdateDto } from './role.dto.js';

/**
 * 管理角色控制器
 *
 * 注：角色的增删改查与变更日志全部由 `OptionController` 基类提供，此处只额外补一个排序接口
 */
@Controller('auth/role')
@Allow('admin')
export class RoleController extends OptionController<
  RoleService,
  RoleUpdateDto
> {
  /**
   * 构造函数
   *
   * @param roleSrv 角色服务
   */
  constructor(protected readonly roleSrv: RoleService) {
    super(roleSrv);
  }

  /**
   * 更新排序
   *
   * @param values 提交消息体
   * @param userId 用户ID
   * @param reqId 请求ID
   * @returns 对象主键值
   */
  @Post('sort')
  async sort(
    @Body() values: RoleSortDto[],
    @UserId() userId: number,
    @ReqId() reqId: number,
  ) {
    return this.roleSrv.sort(values, userId, reqId);
  }
}
