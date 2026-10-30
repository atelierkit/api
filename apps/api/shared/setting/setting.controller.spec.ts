// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SettingService } from './setting.service.js';
import { SettingController } from './setting.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 配置服务替身 */
  const settingSrv = { show: vi.fn(async (_code: string) => null as unknown) };
  return {
    controller: new SettingController(settingSrv as unknown as SettingService),
    settingSrv,
  };
}

describe('SettingController', () => {
  it('返回配置的 value 字段（不暴露 status / 更新信息）', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    settingSrv.show.mockResolvedValue({ code: 'app', value: { name: 'x' } });
    expect(await controller.get('app')).toEqual({ name: 'x' });
    expect(settingSrv.show).toHaveBeenCalledWith('app');
  });

  it('配置不存在时 404，并在文案里带上编码', async () => {
    /** 被测控制器 */
    const { controller } = controllerOf();
    await expect(controller.get('app')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.get('app')).rejects.toThrow('参数app未配置！');
  });
});
