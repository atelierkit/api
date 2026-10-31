// 外部依赖
import { Module } from '@nestjs/common';
// 内部依赖
import { CloudModule } from '../cloud/cloud.module.js';
import { ApiService } from './api/api.service.js';
import { CdnController } from './cdn/cdn.controller.js';
import { DnsController } from './dns/dns.controller.js';
import { DomainController } from './domain/domain.controller.js';
import { FirewallController } from './firewall/firewall.controller.js';
import { LighthouseController } from './lighthouse/lighthouse.controller.js';
import { SslController } from './ssl/ssl.controller.js';

/**
 * 腾讯云模块
 *
 * 注 1：自旧私有项目 `marbleqi/api` 的 `src/tencent` 迁入，接口前缀统一为 `tencent/`，
 * 全部用 `@Allow('admin')` 声明所需角色（鉴权由全局 `TokenGuard` 完成）
 * 注 2：依赖 `CloudModule` 的两个服务 —— `KeyService` 取访问密钥（Secret 只在服务端用）、
 * `KongService` / `ObjectService` 用于把 SSL 证书部署到 KONG 站点
 * 注 3：不引入 `@nestjs/axios`，HTTP 请求用运行时自带的 `fetch`（见 `api/api.request.ts`）
 */
@Module({
  imports: [CloudModule],
  controllers: [
    SslController,
    DnsController,
    DomainController,
    CdnController,
    FirewallController,
    LighthouseController,
  ],
  providers: [ApiService],
  exports: [ApiService],
})
export class TencentModule {}
