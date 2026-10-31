// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  CreateInstanceDto,
  DescribeInstancesDto,
  ResetInstancePasswordDto,
  StartInstanceDto,
} from './lighthouse.dto.js';

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

describe('lighthouse.dto', () => {
  it('实例列表入参有默认分页', async () => {
    /** 实例 */
    const dto = plainToInstance(DescribeInstancesDto, {});
    expect(dto).toMatchObject({ Offset: 0, Limit: 20 });
    expect(await fieldsOf(DescribeInstancesDto, { Limit: 0 })).toEqual(['Limit']);
  });

  it('实例ID 必填（空串不会被放行到腾讯云）', async () => {
    expect(await fieldsOf(StartInstanceDto, {})).toEqual(['InstanceId']);
    expect(await fieldsOf(StartInstanceDto, { InstanceId: '' })).toEqual([
      'InstanceId',
    ]);
    expect(await fieldsOf(StartInstanceDto, { InstanceId: 'lhins-1' })).toEqual([]);
  });

  it('新密码要求 8-32 位', async () => {
    expect(
      await fieldsOf(ResetInstancePasswordDto, {
        InstanceId: 'lhins-1',
        Password: 'short',
      }),
    ).toEqual(['Password']);
    expect(
      await fieldsOf(ResetInstancePasswordDto, {
        InstanceId: 'lhins-1',
        Password: 'Passw0rd!',
      }),
    ).toEqual([]);
    expect(
      await fieldsOf(ResetInstancePasswordDto, {
        InstanceId: 'lhins-1',
        Password: 'x'.repeat(33),
      }),
    ).toEqual(['Password']);
  });

  it('创建实例必须给套餐ID', async () => {
    expect(await fieldsOf(CreateInstanceDto, {})).toEqual(['BundleId']);
    expect(
      await fieldsOf(CreateInstanceDto, {
        BundleId: 'bundle-1',
        InstanceName: 'home',
        Zone: 'ap-guangzhou-2',
        PayMode: 'PREPAID',
      }),
    ).toEqual([]);
  });
});
