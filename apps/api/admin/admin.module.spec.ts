// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { AdminModule } from './admin.module.js';
import { AdminOperateController } from './operate/operate.controller.js';
import { AdminReqController } from './req/req.controller.js';
import { AdminSettingController } from './setting/setting.controller.js';

describe('AdminModule', () => {
  it('注册了配置 / 操作日志 / 请求日志三个控制器', () => {
    // 注：控制器漏注册时接口是 404，本地起服务点页面才发现，故在这里钉住
    expect(Reflect.getMetadata('controllers', AdminModule)).toEqual([
      AdminSettingController,
      AdminOperateController,
      AdminReqController,
    ]);
  });
});
