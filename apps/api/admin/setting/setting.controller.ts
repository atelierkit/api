// 外部依赖
import { Controller } from '@nestjs/common';
// 内部依赖
import { Allow, OptionController, SettingService } from '@shared';
import { SettingDto } from './setting.dto.js';

/**
 * 系统配置控制器（管理端）
 *
 * 注 1：增删改查全部由 `OptionController` 基类提供（`index` / `show/:key` / `create` / `update/:key`）
 * 注 2：与 `shared/setting` 的个人端 `SettingController` 区分开 —— 个人端只读单个配置的 `value` 并在
 * 路由上不带 `admin/` 前缀，本控制器才能改配置；两者类名必须不同，`ReqInterceptor` 按类名记请求日志
 */
@Controller('admin/setting')
@Allow('admin')
export class AdminSettingController extends OptionController<
  SettingService,
  SettingDto
> {
  /**
   * 构造函数
   *
   * @param settingSrv 配置服务
   */
  constructor(protected readonly settingSrv: SettingService) {
    super(settingSrv);
  }
}
