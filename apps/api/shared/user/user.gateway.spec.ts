// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { UserGateway } from './user.gateway.js';

describe('UserGateway', () => {
  it('订阅 message 事件后返回固定问候语（占位实现，未接业务）', () => {
    /** 网关 */
    const gateway = new UserGateway();
    expect(gateway.handleMessage({ id: 'socket-1' }, { msg: 'hi' })).toBe(
      'Hello world!',
    );
  });
});
