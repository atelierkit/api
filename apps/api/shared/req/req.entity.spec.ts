// 外部依赖
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
// 内部依赖
import { ReqEntity } from './req.entity.js';

describe('ReqEntity', () => {
  it('请求序号与起止时间在加载时转成数字', () => {
    // 实体内部有一行 debug 日志，测试里静音
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    /** 请求日志 */
    const entity = new ReqEntity();
    entity.reqId = '1700000000001' as unknown as number;
    entity.startAt = '1700000000002' as unknown as number;
    entity.endAt = '1700000000003' as unknown as number;
    entity.reqLoad();
    expect(entity.reqId).toBe(1700000000001);
    expect(entity.startAt).toBe(1700000000002);
    expect(entity.endAt).toBe(1700000000003);
    vi.restoreAllMocks();
  });

  it('0 值保持 0', () => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    /** 请求日志 */
    const entity = new ReqEntity();
    entity.reqLoad();
    expect([entity.reqId, entity.startAt, entity.endAt]).toEqual([0, 0, 0]);
    vi.restoreAllMocks();
  });
});
