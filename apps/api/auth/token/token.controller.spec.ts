// 外部依赖
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { TokenService } from '../../shared/token/token.service.js';
import { TokenController } from './token.controller.js';

/**
 * 组装被测控制器
 *
 * @returns 被测控制器与替身
 */
function controllerOf() {
  /** 令牌服务替身 */
  const tokenSrv = {
    index: vi.fn(async () => [{ id: '1' }] as unknown[]),
    count: vi.fn(async () => 1),
    destroy: vi.fn(async (_token: string) => 1),
  };
  return {
    controller: new TokenController(tokenSrv as unknown as TokenService),
    tokenSrv,
  };
}

describe('TokenController', () => {
  it('整个控制器由 admin 角色独占（令牌可作废任意会话，不能放开给普通用户）', () => {
    expect(Reflect.getMetadata('role', TokenController)).toEqual(['admin']);
  });

  it('清单与数量直接转发给令牌服务', async () => {
    /** 被测控制器与替身 */
    const { controller, tokenSrv } = controllerOf();
    expect(await controller.index()).toEqual([{ id: '1' }]);
    expect(await controller.count()).toBe(1);
    expect(tokenSrv.index).toHaveBeenCalledTimes(1);
    expect(tokenSrv.count).toHaveBeenCalledTimes(1);
  });

  it('作废令牌时原样传递令牌键', async () => {
    /** 被测控制器与替身 */
    const { controller, tokenSrv } = controllerOf();
    expect(await controller.destroy('1:abc')).toBe(1);
    expect(tokenSrv.destroy).toHaveBeenCalledWith('1:abc');
  });
});
