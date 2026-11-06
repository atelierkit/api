// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { SharedModule } from '@shared';
import { CloudModule } from '../cloud/cloud.module.js';
import { AliyunModule } from './aliyun.module.js';
import { ApiService } from './api/api.service.js';
import { ContactController } from './contact/contact.controller.js';
import { ContactService } from './contact/contact.service.js';
import { SslController } from './ssl/ssl.controller.js';
import { SslService } from './ssl/ssl.service.js';

describe('AliyunModule', () => {
  it('两个控制器都在模块里注册（少登记一个就是整块接口 404）', () => {
    expect(Reflect.getMetadata('controllers', AliyunModule)).toEqual([
      SslController,
      ContactController,
    ]);
  });

  it('依赖云服务模块拿密钥与 KONG 站点/对象服务', () => {
    /** 模块依赖 */
    const imports = Reflect.getMetadata('imports', AliyunModule) as unknown[];
    expect(imports).toContain(CloudModule);
    expect(imports).toContain(SharedModule);
  });

  it('服务对外导出（供后续被别的模块复用）', () => {
    expect(Reflect.getMetadata('providers', AliyunModule)).toEqual([
      ApiService,
      SslService,
      ContactService,
    ]);
    expect(Reflect.getMetadata('exports', AliyunModule)).toEqual([
      ApiService,
      SslService,
      ContactService,
    ]);
  });
});
