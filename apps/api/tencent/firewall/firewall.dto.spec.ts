// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  CreateFirewallRulesDto,
  DescribeFirewallRulesDto,
  ModifyFirewallRulesDto,
} from './firewall.dto.js';

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

/** 一条合法规则 */
const RULE = {
  Protocol: 'TCP',
  Port: '22',
  CidrBlock: '0.0.0.0/0',
  Action: 'ACCEPT',
  FirewallRuleDescription: 'SSH',
};

describe('firewall.dto', () => {
  it('实例ID 必填，规则数组逐条校验', async () => {
    expect(await fieldsOf(CreateFirewallRulesDto, {})).toEqual(
      expect.arrayContaining(['InstanceId']),
    );
    expect(
      await fieldsOf(CreateFirewallRulesDto, {
        InstanceId: 'lhins-1',
        FirewallRules: [RULE],
      }),
    ).toEqual([]);
    expect(
      await fieldsOf(CreateFirewallRulesDto, {
        InstanceId: 'lhins-1',
        FirewallRules: [{ Port: '80' }],
      }),
    ).toEqual(['FirewallRules']);
  });

  it('处理动作只认 ACCEPT / DROP', async () => {
    expect(
      await fieldsOf(CreateFirewallRulesDto, {
        InstanceId: 'lhins-1',
        FirewallRules: [{ ...RULE, Action: 'REJECT' }],
      }),
    ).toEqual(['FirewallRules']);
  });

  it('嵌套规则里的未声明字段会被剥掉（字段名必须与腾讯云 FirewallRule 一致）', async () => {
    /** 实例 */
    const dto = plainToInstance(CreateFirewallRulesDto, {
      InstanceId: 'lhins-1',
      FirewallRules: [{ ...RULE, protocol: 'tcp' }],
    });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto.FirewallRules[0]).not.toHaveProperty('protocol');
  });

  it('防火墙版本号允许字符串数字', async () => {
    /** 实例 */
    const dto = plainToInstance(ModifyFirewallRulesDto, {
      InstanceId: 'lhins-1',
      FirewallRules: [RULE],
      FirewallVersion: '3',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.FirewallVersion).toBe(3);
  });

  it('查询入参的分页有默认值，负数偏移拒绝', async () => {
    /** 实例 */
    const dto = plainToInstance(DescribeFirewallRulesDto, { InstanceId: 'lhins-1' });
    expect(dto).toMatchObject({ Offset: 0, Limit: 20 });
    expect(
      await fieldsOf(DescribeFirewallRulesDto, { InstanceId: 'lhins-1', Offset: -1 }),
    ).toEqual(['Offset']);
  });
});
