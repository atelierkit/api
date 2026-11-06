// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ContactService } from './contact.service.js';
import { ContactController } from './contact.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与服务替身
 */
function controllerOf() {
  /** 联系人服务替身 */
  const contactSrv = {
    index: vi.fn(async (..._args: unknown[]) => []),
    show: vi.fn(async (..._args: unknown[]) => null),
    count: vi.fn(async () => 0),
    log: vi.fn(async (..._args: unknown[]) => []),
    create: vi.fn(async (..._args: unknown[]) => 1),
    update: vi.fn(async (..._args: unknown[]) => 1),
  };
  return {
    controller: new ContactController(
      contactSrv as unknown as ContactService,
    ),
    contactSrv,
  };
}

describe('ContactController', () => {
  it('整个控制器由 admin 角色独占', () => {
    expect(Reflect.getMetadata('role', ContactController)).toEqual(['admin']);
  });

  it('控制器前缀为 aliyun/contact', () => {
    expect(Reflect.getMetadata('path', ContactController)).toBe(
      'aliyun/contact',
    );
  });

  it('CRUD 由基类提供，参数原样转交', async () => {
    /** 被测控制器与替身 */
    const { controller, contactSrv } = controllerOf();

    await controller.index(0);
    expect(contactSrv.index).toHaveBeenCalledWith(0);

    await controller.create(
      {
        username: 'u',
        email: 'e@x.com',
        phone: '13600000000',
        province: 'zhejiang',
        city: 'hangzhou',
      },
      1,
      2,
    );
    expect(contactSrv.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'u' }),
      1,
      2,
    );

    await controller.update(3, { city: 'ningbo' }, 1, 2);
    expect(contactSrv.update).toHaveBeenCalledWith(3, { city: 'ningbo' }, 1, 2);
  });

  it('详情取不到时抛 404（基类行为）', async () => {
    /** 被测控制器 */
    const { controller } = controllerOf();
    await expect(controller.show(9)).rejects.toThrow('当前对象不存在');
  });
});
