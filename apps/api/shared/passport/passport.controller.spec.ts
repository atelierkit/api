// 外部依赖
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { SettingService } from '../setting/setting.service.js';
import { SetupService } from '../setup/setup.service.js';
import { UserService } from '../user/user.service.js';
import { PassportController } from './passport.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 用户服务替身 */
  const userSrv = {
    login: vi.fn(async (..._args: unknown[]) => ({ code: 'T' })),
    check: vi.fn(async (_username: string, _ip: string) => ({ exists: false })),
    sendResetCode: vi.fn(async (_email: string, _ip: string) => ({ code: 0 })),
    reset: vi.fn(async (..._args: unknown[]) => ({ code: 0 })),
    register: vi.fn(async (..._args: unknown[]) => 1),
    activate: vi.fn(async (..._args: unknown[]) => ({ code: 0 })),
  };
  /** 初始化服务替身 */
  const setupSrv = {
    ready: vi.fn(async () => false),
    setup: vi.fn(async (..._args: unknown[]) => ({ code: 'T' })),
  };
  /** 配置服务替身 */
  const settingSrv = { show: vi.fn(async (_code: string) => null as unknown) };
  return {
    controller: new PassportController(
      userSrv as unknown as UserService,
      setupSrv as unknown as SetupService,
      settingSrv as unknown as SettingService,
    ),
    userSrv,
    setupSrv,
    settingSrv,
  };
}

describe('PassportController', () => {
  it('应用与备案配置缺省时返回内置默认值（创建管理员页面要能渲染页头）', async () => {
    /** 被测控制器与替身 */
    const { controller, settingSrv } = controllerOf();
    expect(await controller.app()).toHaveProperty('name');
    expect(await controller.icp()).toHaveProperty('icp');

    settingSrv.show.mockResolvedValue({ code: 'app', value: { name: '自定' } });
    expect(await controller.app()).toEqual({ name: '自定' });
  });

  it('init 只返回布尔值', async () => {
    /** 被测控制器与替身 */
    const { controller, setupSrv } = controllerOf();
    expect(await controller.init()).toEqual({ initialized: false });
    setupSrv.ready.mockResolvedValue(true);
    expect(await controller.init()).toEqual({ initialized: true });
  });

  it('setup 的直连对端地址取自 socket，不用可伪造的转发头', async () => {
    /** 被测控制器与替身 */
    const { controller, setupSrv } = controllerOf();
    /** 初始化入参 */
    const value = { username: 'admin', password: 'abc12345' };
    await controller.setup(
      value,
      'token',
      {
        socket: { remoteAddress: '10.0.0.5' },
      } as never,
      '1.2.3.4',
      88,
    );
    expect(setupSrv.setup).toHaveBeenCalledWith(
      value,
      'token',
      '10.0.0.5',
      '1.2.3.4',
      88,
    );

    // 无 socket 信息时退化为空串，由服务端的来源校验兜底
    await controller.setup(value, '', {} as never, '', 0);
    expect(setupSrv.setup).toHaveBeenLastCalledWith(value, '', '', '', 0);
  });

  it('login / check / reset / register 透传客户端IP与请求ID', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    await controller.login(
      { username: 'admin', password: 'abc12345' },
      '1.2.3.4',
      88,
    );
    expect(userSrv.login).toHaveBeenCalledWith(
      { username: 'admin', password: 'abc12345' },
      88,
      '1.2.3.4',
    );

    await controller.check({ username: 'admin' }, '1.2.3.4');
    expect(userSrv.check).toHaveBeenCalledWith('admin', '1.2.3.4');

    await controller.resetCode({ email: 'a@b.com' }, '1.2.3.4');
    expect(userSrv.sendResetCode).toHaveBeenCalledWith('a@b.com', '1.2.3.4');

    await controller.reset(
      { email: 'a@b.com', code: '123456', password: 'abc12345' },
      88,
    );
    expect(userSrv.reset).toHaveBeenCalledWith(
      { email: 'a@b.com', code: '123456', password: 'abc12345' },
      88,
    );

    await controller.register(
      { username: 'admin', password: 'abc12345' },
      88,
      '1.2.3.4',
    );
    expect(userSrv.register).toHaveBeenCalledWith(
      { username: 'admin', password: 'abc12345' },
      88,
      '1.2.3.4',
    );
  });

  it('activate 缺激活码时 400，不查缓存', async () => {
    /** 被测控制器与替身 */
    const { controller, userSrv } = controllerOf();
    // 注：该分支是同步抛错（没走 async），所以用 toThrow 而不是 rejects
    expect(() => controller.activate('', 0)).toThrow(BadRequestException);
    expect(userSrv.activate).not.toHaveBeenCalled();

    await controller.activate('CODE', 88);
    expect(userSrv.activate).toHaveBeenCalledWith('CODE', 88);
  });
});
