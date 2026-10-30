// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { OperateEntity } from './operate.entity.js';

describe('OperateEntity', () => {
  it('操作序号与时间在加载时转成数字', () => {
    /** 操作记录 */
    const entity = new OperateEntity();
    entity.id = '1700000000001' as unknown as number;
    entity.at = '1700000000002' as unknown as number;
    entity.operateLoad();
    expect(entity.id).toBe(1700000000001);
    expect(entity.at).toBe(1700000000002);
  });

  it('空值归零而不是 NaN', () => {
    /** 操作记录 */
    const entity = new OperateEntity();
    entity.operateLoad();
    expect([entity.id, entity.at]).toEqual([0, 0]);
  });

  it('插入时自动写入当前时间（调用方可省略 at）', () => {
    /** 操作记录 */
    const entity = new OperateEntity();
    /** 插入前 */
    const before = Date.now();
    entity.createAt();
    expect(entity.at).toBeGreaterThanOrEqual(before);
    expect(entity.at).toBeLessThanOrEqual(Date.now());
  });
});
