// 外部依赖
import { Module } from '@nestjs/common';
// 内部依赖
import { SharedModule } from '@shared';
import { AdminOperateController } from './operate/operate.controller.js';
import { AdminReqController } from './req/req.controller.js';
import { AdminSettingController } from './setting/setting.controller.js';

/**
 * 管理员模块
 *
 * 注 1：自旧私有项目 `marbleqi/api` 的 `src/admin` 迁入，只保留管理端自用的三块
 * （系统配置 / 操作日志 / 请求日志）；旧项目的 `admin/key`、`admin/kong`、`admin/kong/object`
 * 已并入 `cloud` 模块（接口前缀 `cloud/`），别在这里补回来
 * 注 2：接口一律 `@Allow('admin')`，鉴权由全局 `TokenGuard` 完成；三块都读 `SharedModule`
 * 导出的服务，故本模块不需要自己的 provider 与 TypeORM 存储
 */
@Module({
  imports: [SharedModule],
  controllers: [
    AdminSettingController,
    AdminOperateController,
    AdminReqController,
  ],
})
export class AdminModule {}
