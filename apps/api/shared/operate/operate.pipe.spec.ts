// 外部依赖
import { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { OperatePipe } from './operate.pipe.js';

/** 参数元数据（管道不使用，仅占位） */
const METADATA = { type: 'param' } as ArgumentMetadata;

describe('OperatePipe', () => {
  it('数字与数字字符串转换为数字', () => {
    /** 管道 */
    const pipe = new OperatePipe();
    expect(pipe.transform(7, METADATA)).toBe(7);
    expect(pipe.transform('7', METADATA)).toBe(7);
    expect(pipe.transform(-3, METADATA)).toBe(-3);
  });

  it('无法转换的输入返回 -1', () => {
    /** 管道 */
    const pipe = new OperatePipe();
    expect(pipe.transform('abc', METADATA)).toBe(-1);
    expect(pipe.transform(undefined, METADATA)).toBe(-1);
    expect(pipe.transform(null, METADATA)).toBe(-1);
    expect(pipe.transform('', METADATA)).toBe(-1);
  });

  it('注：沿用 Number(value) || -1 的旧语义，0 与 "0" 同样落到 -1', () => {
    /** 管道 */
    const pipe = new OperatePipe();
    // 迁移自旧实现，登录等接口没有「操作序号 0」的业务含义，故 0 与非法值同档
    expect(pipe.transform(0, METADATA)).toBe(-1);
    expect(pipe.transform('0', METADATA)).toBe(-1);
  });
});
