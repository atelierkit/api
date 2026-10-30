// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { OperateIndexDto } from './operate.dto.js';

/**
 * 校验入参
 *
 * @param value 原始入参（模拟 query 的字符串形态）
 * @returns DTO 实例与出错的字段名清单
 */
async function check(value: Record<string, unknown>) {
  /** DTO 实例 */
  const dto = plainToInstance(OperateIndexDto, value);
  /** 校验结果 */
  const errors = await validate(dto, { whitelist: true });
  return { dto, fields: errors.map((error) => error.property) };
}

describe('OperateIndexDto', () => {
  it('全部字段可选，空查询通过校验', async () => {
    expect((await check({})).fields).toHaveLength(0);
  });

  it('query 里的字符串数字被 @Type 转成数字后再校验', async () => {
    /** 校验结果 */
    const { dto, fields } = await check({ pi: '2', ps: '50', userId: '0' });
    expect(fields).toHaveLength(0);
    // userId 为 0 表示系统操作，必须保留为数字 0 而不是被当空值丢掉
    expect(dto.pi).toBe(2);
    expect(dto.ps).toBe(50);
    expect(dto.userId).toBe(0);
  });

  it('无法转成数字的入参被拦截', async () => {
    expect((await check({ ps: 'abc' })).fields).toContain('ps');
  });

  it('时间戳必须是整数（小数会被拦截）', async () => {
    expect((await check({ start: '1672531200000' })).fields).toHaveLength(0);
    expect((await check({ start: '1.5' })).fields).toContain('start');
  });

  it('未声明的查询参数被白名单剥掉', async () => {
    /** 校验结果 */
    const { dto } = await check({ name: 'user', inject: 'x' });
    expect((dto as unknown as Record<string, unknown>).inject).toBeUndefined();
    expect(dto.name).toBe('user');
  });
});
