// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import {
  OptionEntity,
  OptionEntityLog,
  OptionService,
} from './option.service.js';
import { OptionController } from './option.controller.js';

/** 被控制器使用的服务类型 */
type TestService = OptionService<OptionEntity, OptionEntityLog>;

/** 配置控制器的测试实现（抽象类不能直接实例化） */
class TestOptionController extends OptionController<
  TestService,
  Partial<OptionEntity>
> {
  /**
   * 构造函数
   *
   * @param optionSrv 配置对象服务替身
   */
  constructor(optionSrv: TestService) {
    super(optionSrv);
  }
}

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 配置对象服务替身 */
  const optionSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    show: vi.fn(async (_key: string) => null as unknown),
    log: vi.fn(async (_key: string) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => ({ code: 'a' })),
    update: vi.fn(async (..._args: unknown[]) => ({ code: 'b' })),
  };
  return {
    controller: new TestOptionController(optionSrv as unknown as TestService),
    optionSrv,
  };
}

describe('OptionController', () => {
  it('index / log 直接转发服务', async () => {
    /** 被测控制器与替身 */
    const { controller, optionSrv } = controllerOf();
    await controller.index(5);
    expect(optionSrv.index).toHaveBeenCalledWith(5);
    await controller.log('app');
    expect(optionSrv.log).toHaveBeenCalledWith('app');
  });

  it('show 未命中时转成 404', async () => {
    /** 被测控制器与替身 */
    const { controller, optionSrv } = controllerOf();
    await expect(controller.show('app')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    optionSrv.show.mockResolvedValue({ code: 'app', value: 1 });
    expect(await controller.show('app')).toEqual({ code: 'app', value: 1 });
  });

  it('create / update 透传主键、当前用户与请求ID', async () => {
    /** 被测控制器与替身 */
    const { controller, optionSrv } = controllerOf();
    expect(await controller.create({ code: 'a' }, 7, 88)).toEqual({
      code: 'a',
    });
    expect(optionSrv.create).toHaveBeenCalledWith({ code: 'a' }, 7, 88);

    expect(await controller.update('a', { code: 'b' }, 7, 88)).toEqual({
      code: 'b',
    });
    expect(optionSrv.update).toHaveBeenCalledWith('a', { code: 'b' }, 7, 88);
  });
});
