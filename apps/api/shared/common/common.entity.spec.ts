// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { CreateEntity, LogEntity, UpdateEntity } from './common.entity.js';

describe('common.entity', () => {
  it('CreateEntity 把 bigint 返回的字符串时间戳转成数字', () => {
    /** 创建信息 */
    const entity = new CreateEntity();
    entity.at = '1700000000000' as unknown as number;
    entity.createLoad();
    expect(entity.at).toBe(1700000000000);
    // 0 与空值保持 0，不要变成 NaN
    entity.at = 0;
    entity.createLoad();
    expect(entity.at).toBe(0);
  });

  it('UpdateEntity 同时转换时间、操作序号与请求序号', () => {
    /** 更新信息 */
    const entity = new UpdateEntity();
    entity.at = '1700000000001' as unknown as number;
    entity.operateId = '12' as unknown as number;
    entity.reqId = '34' as unknown as number;
    entity.updateLoad();
    expect(entity.at).toBe(1700000000001);
    expect(entity.operateId).toBe(12);
    expect(entity.reqId).toBe(34);
  });

  it('UpdateEntity 的 0 值保持不变', () => {
    /** 更新信息 */
    const entity = new UpdateEntity();
    entity.at = 0;
    entity.operateId = 0;
    entity.reqId = 0;
    entity.updateLoad();
    expect([entity.at, entity.operateId, entity.reqId]).toEqual([0, 0, 0]);
  });

  it('LogEntity 转换日志序号', () => {
    /** 日志信息 */
    const entity = new LogEntity();
    entity.id = '99' as unknown as number;
    entity.logLoad();
    expect(entity.id).toBe(99);
  });
});
