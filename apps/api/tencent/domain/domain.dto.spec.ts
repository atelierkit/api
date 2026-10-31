// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { DomainDetailDto, DomainListDto, DomainRemarkDto } from './domain.dto.js';

/**
 * 校验入参
 *
 * @param cls DTO 类型
 * @param value 原始入参
 * @returns 出错的字段名清单
 */
async function fieldsOf(
  cls: new () => object,
  value: Record<string, unknown>,
): Promise<string[]> {
  /** DTO 实例 */
  const dto = plainToInstance(cls, value);
  /** 校验结果 */
  const errors = await validate(dto, { whitelist: true });
  return errors.map((error) => error.property);
}

describe('domain.dto', () => {
  it('备注允许空串 —— 腾讯云约定「删除备注请提交空内容」', async () => {
    expect(await fieldsOf(DomainRemarkDto, { Domain: 'example.com', Remark: '' })).toEqual(
      [],
    );
    expect(await fieldsOf(DomainRemarkDto, { Domain: 'example.com' })).toEqual([]);
  });

  it('域名必填且不能为空串', async () => {
    expect(await fieldsOf(DomainRemarkDto, {})).toEqual(['Domain']);
    expect(await fieldsOf(DomainDetailDto, { Domain: '' })).toEqual(['Domain']);
  });

  it('列表入参全可选，字符串数字转数字', async () => {
    expect(await fieldsOf(DomainListDto, {})).toEqual([]);
    /** 实例 */
    const dto = plainToInstance(DomainListDto, { Offset: '10', Limit: '5' });
    expect(dto).toEqual({ Offset: 10, Limit: 5 });
  });
});
