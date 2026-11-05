// 外部依赖
import 'reflect-metadata';
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { SecurityQueryDto } from './data/query.dto.js';
import { VALIDATION_PIPE_OPTIONS } from './validation.options.js';

/** 造一份 `@Query()` 的校验元数据 */
const QUERY_META: ArgumentMetadata = { type: 'query', metatype: SecurityQueryDto };

/** 用全局配置构造管道 */
function pipe(): ValidationPipe {
  return new ValidationPipe(VALIDATION_PIPE_OPTIONS);
}

describe('全局校验管道', () => {
  it('whitelist 与 transform 都开启', () => {
    expect(VALIDATION_PIPE_OPTIONS.whitelist).toBe(true);
    // 回归：曾只有 whitelist —— @Query() 全是字符串，@IsInt() 只认 number，
    // 于是「带 page/size 的请求恒 400（page must be an integer number）」
    expect(VALIDATION_PIPE_OPTIONS.transform).toBe(true);
  });

  it('不开隐式转换（Boolean(\'false\') === true 会把开关字段静默改成开启）', () => {
    expect(VALIDATION_PIPE_OPTIONS.transformOptions?.enableImplicitConversion).toBeFalsy();
  });

  it('证券清单的 page/size 以查询串提交时被转成数字', async () => {
    const out = (await pipe().transform(
      { keyword: '平安', page: '2', size: '100', sort: 'CodeAsc' },
      QUERY_META,
    )) as SecurityQueryDto;

    expect(out.page).toBe(2);
    expect(out.size).toBe(100);
    expect(out.keyword).toBe('平安');
  });

  it('page= 空串当作未填（不是 0，否则会撞 @Min(1)）', async () => {
    const out = (await pipe().transform({ page: '', size: '' }, QUERY_META)) as SecurityQueryDto;

    expect(out.page).toBeUndefined();
    expect(out.size).toBeUndefined();
  });

  it('page 为非数字文本仍被拦成 400', async () => {
    await expect(pipe().transform({ page: 'abc' }, QUERY_META)).rejects.toThrow();
  });
});
