// 外部依赖
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** 防火墙规则的处理动作 */
export const FIREWALL_ACTIONS = ['ACCEPT', 'DROP'];

/**
 * 防火墙规则
 *
 * 注：字段名与腾讯云 `FirewallRule` 结构逐字一致，整对象透传给
 * `CreateFirewallRules` / `DeleteFirewallRules` / `ModifyFirewallRules` 的 `FirewallRules` 参数
 */
export class TencentFirewallRule {
  /** 协议，`TCP` / `UDP` / `ICMP` / `ICMPv6` / `ALL` */
  @IsString()
  @IsNotEmpty()
  Protocol!: string;

  /** 端口，支持单个端口(80)、离散端口(22,3389)、端口范围(80-443)、ALL */
  @IsOptional()
  @IsString()
  Port?: string;

  /** 来源 IPv4 地址或 CIDR 段，缺省 0.0.0.0/0 */
  @IsOptional()
  @IsString()
  CidrBlock?: string;

  /** 来源 IPv6 地址或 CIDR 段，缺省 ::/0 */
  @IsOptional()
  @IsString()
  Ipv6CidrBlock?: string;

  /** 处理动作 */
  @IsOptional()
  @IsIn(FIREWALL_ACTIONS)
  Action?: string;

  /** 备注，长度不超过 64 个字符 */
  @IsOptional()
  @IsString()
  FirewallRuleDescription?: string;
}

/** 规则数组的公共部分，注：增 / 删 / 改三个接口的参数结构完全一样 */
export class FirewallRulesDto {
  /** 实例ID，如 `lhins-aglzynfg` */
  @IsString()
  @IsNotEmpty()
  InstanceId!: string;

  /** 规则数组 */
  @ValidateNested({ each: true })
  @Type(() => TencentFirewallRule)
  FirewallRules: TencentFirewallRule[] = [];

  /** 防火墙版本号，注：不传则不校验规则冲突 */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  FirewallVersion?: number;
}

/** 创建防火墙规则入参 */
export class CreateFirewallRulesDto extends FirewallRulesDto {}

/** 删除防火墙规则入参 */
export class DeleteFirewallRulesDto extends FirewallRulesDto {}

/** 修改防火墙规则入参 */
export class ModifyFirewallRulesDto extends FirewallRulesDto {}

/** 查询防火墙规则入参 */
export class DescribeFirewallRulesDto {
  /** 实例ID */
  @IsString()
  @IsNotEmpty()
  InstanceId!: string;

  /** 偏移量 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  Offset: number = 0;

  /** 每页数量 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  Limit: number = 20;
}
