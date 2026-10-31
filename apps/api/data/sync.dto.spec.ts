// 外部依赖
import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
// 内部依赖
import { SyncActionDto } from './sync.dto.js';

describe('SyncActionDto', () => {
  it('合法的目标通过校验', async () => {
    const dto = Object.assign(new SyncActionDto(), { target: 'BarByDate' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('非法的目标被拒', async () => {
    const dto = Object.assign(new SyncActionDto(), { target: 'Bar' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('缺目标被拒', async () => {
    const dto = new SyncActionDto();
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
