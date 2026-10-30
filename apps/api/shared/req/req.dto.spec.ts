// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { ReqIndexDto } from './req.dto.js';

/**
 * 校验入参
 *
 * @param value 原始入参（模拟 query 的字符串形态）
 * @returns DTO 实例与出错的字段名清单
 */
async function check(value: Record<string, unknown>) {
  /** DTO 实例 */
  const dto = plainToInstance(ReqIndexDto, value);
  /** 校验结果 */
  const errors = await validate(dto, { whitelist: true });
  return { dto, fields: errors.map((error) => error.property) };
}

describe('ReqIndexDto', () => {
  it('全部字段可选，空查询通过校验', async () => {
    expect((await check({})).fields).toHaveLength(0);
  });

  it('字符串数字字段被转成数字', async () => {
    /** 校验结果 */
    const { dto, fields } = await check({
      status: '404',
      pi: '3',
      userId: '0',
    });
    expect(fields).toHaveLength(0);
    expect(dto.status).toBe(404);
    expect(dto.pi).toBe(3);
    expect(dto.userId).toBe(0);
  });

  it('success 只接受真正的布尔值（注入 true/false 字面量后不走 HTTP）', async () => {
    expect((await check({ success: true })).fields).toHaveLength(0);
    expect((await check({ success: false })).fields).toHaveLength(0);
    // 注：没有 @Type(() => Boolean)，字符串 'true' 不会被隐式转换，按非法值拦截
    expect((await check({ success: 'true' })).fields).toContain('success');
  });

  it('文本筛选字段必须是字符串', async () => {
    expect((await check({ path: '/user/index' })).fields).toHaveLength(0);
    expect((await check({ path: ['a', 'b'] })).fields).toContain('path');
  });

  it('未声明的查询参数被白名单剥掉', async () => {
    /** 校验结果 */
    const { dto } = await check({ action: 'index', inject: 'x' });
    expect((dto as unknown as Record<string, unknown>).inject).toBeUndefined();
    expect(dto.action).toBe('index');
  });
});
