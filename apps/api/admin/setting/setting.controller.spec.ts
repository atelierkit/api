// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SettingService } from '@shared';
import { SettingDto } from './setting.dto.js';
import { AdminSettingController } from './setting.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 配置服务替身 */
  const settingSrv = {
    show: vi.fn(async (_key: string) => null as unknown),
    update: vi.fn(async (..._args: unknown[]) => ({ code: 'app' })),
  };
  return {
    controller: new AdminSettingController(
      settingSrv as unknown as SettingService,
    ),
    settingSrv,
  };
}

/**
 * 校验一份配置提交内容
 *
 * @param value 待校验内容
 * @returns 校验错误清单
 */
function errorsOf(value: Record<string, unknown>) {
  return validate(plainToInstance(SettingDto, value));
}

describe('AdminSettingController', () => {
  it('接口前缀是 admin/setting，且要求 admin 角色', () => {
    // 注：前缀与角色都是失败即静默的配置（写错就变成「谁都能改系统配置」），必须钉住
    expect(Reflect.getMetadata('path', AdminSettingController)).toBe(
      'admin/setting',
    );
    expect(Reflect.getMetadata('role', AdminSettingController)).toEqual([
      'admin',
    ]);
  });

  it('show 走配置服务，未命中时转成 404', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    await expect(controller.show('app')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    settingSrv.show.mockResolvedValue({ code: 'app', value: { name: 'x' } });
    expect(await controller.show('app')).toEqual({
      code: 'app',
      value: { name: 'x' },
    });
  });

  it('update 透传主键、当前用户与请求ID', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    /** 提交内容 */
    const value = { code: 'app', value: { name: 'x' }, status: true };
    expect(await controller.update('app', value, 7, 88)).toEqual({
      code: 'app',
    });
    expect(settingSrv.update).toHaveBeenCalledWith('app', value, 7, 88);
  });
});

describe('SettingDto', () => {
  it('提供编码、状态与配置值齐全时通过校验', async () => {
    expect(await errorsOf({ code: 'icp', status: false, value: { icp: '1' } }))
      .toEqual([]);
  });

  it('编码为空时给出中文提示', async () => {
    /** 校验错误清单 */
    const errors = await errorsOf({ status: true });
    expect(errors[0].property).toBe('code');
    expect(Object.values(errors[0].constraints ?? {})).toContain(
      '配置编码不能为空',
    );
  });

  it('状态与配置值不做校验，缺省也能通过', async () => {
    // 注：这两个字段用 @Allow() 声明，只为躲开全局 whitelist 的字段剥离，
    // 一旦被误改成 @IsNotEmpty，status=false 与空配置都会被判空而 400
    expect(await errorsOf({ code: 'app' })).toEqual([]);
  });
});
