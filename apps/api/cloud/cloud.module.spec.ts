// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { CloudModule } from './cloud.module.js';
import { KeyController } from './key/key.controller.js';
import { KeyService } from './key/key.service.js';
import { KongController } from './kong/kong.controller.js';
import { KongService } from './kong/kong.service.js';
import { KongObjectController } from './kong/object/object.controller.js';
import { ObjectService } from './kong/object/object.service.js';

describe('CloudModule', () => {
  it('密钥 / 站点 / 站点对象三套控制器与服务都在模块里注册（少登记一个就是整块接口 404）', () => {
    expect(Reflect.getMetadata('controllers', CloudModule)).toEqual([
      KeyController,
      KongController,
      KongObjectController,
    ]);
    expect(Reflect.getMetadata('providers', CloudModule)).toEqual([
      KeyService,
      KongService,
      ObjectService,
    ]);
  });

  it('三个服务对外导出（后续按云厂商拆模块时可直接复用）', () => {
    expect(Reflect.getMetadata('exports', CloudModule)).toEqual([
      KeyService,
      KongService,
      ObjectService,
    ]);
  });
});
