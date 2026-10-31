// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { CloudModule } from '../cloud/cloud.module.js';
import { ApiService } from './api/api.service.js';
import { CdnController } from './cdn/cdn.controller.js';
import { DnsController } from './dns/dns.controller.js';
import { DomainController } from './domain/domain.controller.js';
import { FirewallController } from './firewall/firewall.controller.js';
import { LighthouseController } from './lighthouse/lighthouse.controller.js';
import { SslController } from './ssl/ssl.controller.js';
import { TencentModule } from './tencent.module.js';

describe('TencentModule', () => {
  it('六个控制器都在模块里注册（少登记一个就是整块接口 404）', () => {
    expect(Reflect.getMetadata('controllers', TencentModule)).toEqual([
      SslController,
      DnsController,
      DomainController,
      CdnController,
      FirewallController,
      LighthouseController,
    ]);
  });

  it('依赖云服务模块拿密钥与 KONG 站点/对象服务', () => {
    expect(Reflect.getMetadata('imports', TencentModule)).toEqual([CloudModule]);
  });

  it('接口服务对外导出', () => {
    expect(Reflect.getMetadata('providers', TencentModule)).toEqual([ApiService]);
    expect(Reflect.getMetadata('exports', TencentModule)).toEqual([ApiService]);
  });
});
