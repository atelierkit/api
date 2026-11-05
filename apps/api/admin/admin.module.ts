// 外部依赖
import { Module } from '@nestjs/common';
// 内部依赖
import { SharedModule } from '@shared';
import { AdminEmailController } from './email/email.controller.js';
import { AdminOperateController } from './operate/operate.controller.js';
import { AdminReqController } from './req/req.controller.js';
import { AdminSettingController } from './setting/setting.controller.js';

/**
 * 管理员模块
 *
 * 注 1：只含管理端自用的四块（系统配置 / 邮件配置 / 操作日志 / 请求日志）；
 * 访问密钥与各站点（KONG / Docker / Kubernetes / 远程连接）的管理属于 `cloud` 模块（接口前缀 `cloud/`）
 * 注 2：接口一律 `@Allow('admin')`，鉴权由全局 `TokenGuard` 完成；四块都读 `SharedModule`
 * 导出的服务，故本模块不需要自己的 provider 与 TypeORM 存储
 * 注 3：邮件配置单列 `AdminEmailController` —— 授权码要脱敏与加密，通用 `admin/setting` 的整对象读写满足不了
 */
@Module({
  imports: [SharedModule],
  controllers: [
    AdminSettingController,
    AdminEmailController,
    AdminOperateController,
    AdminReqController,
  ],
})
export class AdminModule {}
