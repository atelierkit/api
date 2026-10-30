// 外部依赖
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import {
  CommonEntity,
  CommonEntityLog,
  CommonService,
} from './common.service.js';
import { CommonController } from './common.controller.js';

/** 被控制器使用的服务类型 */
type TestService = CommonService<CommonEntity, CommonEntityLog>;

/** 通用控制器的测试实现（抽象类不能直接实例化） */
class TestCommonController extends CommonController<
  TestService,
  Partial<CommonEntity>,
  Partial<CommonEntity>
> {
  /**
   * 构造函数
   *
   * @param commonSrv 对象服务替身
   */
  constructor(commonSrv: TestService) {
    super(commonSrv);
  }
}

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 对象服务替身 */
  const commonSrv = {
    index: vi.fn(async (_operateId: number) => [] as unknown[]),
    count: vi.fn(async () => 2),
    show: vi.fn(async (_id: number) => null as unknown),
    log: vi.fn(async (_id: number) => [] as unknown[]),
    create: vi.fn(async (..._args: unknown[]) => 9),
    update: vi.fn(async (..._args: unknown[]) => 1),
  };
  return {
    controller: new TestCommonController(commonSrv as unknown as TestService),
    commonSrv,
  };
}

describe('CommonController', () => {
  it('index / count / log 直接转发服务', async () => {
    /** 被测控制器与替身 */
    const { controller, commonSrv } = controllerOf();
    await controller.index(5);
    expect(commonSrv.index).toHaveBeenCalledWith(5);
    expect(await controller.count()).toBe(2);
    await controller.log(3);
    expect(commonSrv.log).toHaveBeenCalledWith(3);
  });

  it('show 命中时返回详情，未命中时转成 404（服务层返回 null 而不是抛错）', async () => {
    /** 被测控制器与替身 */
    const { controller, commonSrv } = controllerOf();
    await expect(controller.show(3)).rejects.toBeInstanceOf(NotFoundException);

    commonSrv.show.mockResolvedValue({ id: 3, code: 'x' });
    expect(await controller.show(3)).toEqual({ id: 3, code: 'x' });
  });

  it('create / update 透传当前用户与请求ID', async () => {
    /** 被测控制器与替身 */
    const { controller, commonSrv } = controllerOf();
    expect(await controller.create({ code: 'a' }, 7, 88)).toBe(9);
    expect(commonSrv.create).toHaveBeenCalledWith({ code: 'a' }, 7, 88);

    expect(await controller.update(3, { code: 'b' }, 7, 88)).toBe(1);
    expect(commonSrv.update).toHaveBeenCalledWith(3, { code: 'b' }, 7, 88);
  });
});
