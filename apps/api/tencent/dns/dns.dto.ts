// 外部依赖
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** 记录状态，注：与腾讯云 `Status` 取值一致 */
export const DNS_STATUS = ['ENABLE', 'DISABLE'];

/**
 * 解析记录列表入参
 *
 * 注：`Offset` 从 0 开始（腾讯云口径）
 */
export class DnsListDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;

  /** 偏移量 */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  Offset?: number;

  /** 每页数量 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  Limit?: number;

  /** 主机头，注：传了只返回该主机头的记录 */
  @IsOptional()
  @IsString()
  SubDomain?: string;

  /** 记录类型，如 `A` */
  @IsOptional()
  @IsString()
  RecordType?: string;

  /** 关键字，注：支持搜主机头与记录值 */
  @IsOptional()
  @IsString()
  Keyword?: string;
}

/**
 * 创建解析记录入参
 *
 * 注 1：字段名与腾讯云 `CreateRecord` **逐字一致**。旧私有项目的 DTO 写的是 `Type` / `Name`
 * （腾讯云里没有这两个参数），配合 `whitelist` 会把前端提交的 `RecordType` / `SubDomain` 剥掉，
 * 建记录必然报 `MissingParameter` —— 这里按官方参数表重写
 * 注 2：`RecordLine` 在腾讯云是必填（如「默认」）
 */
export class DnsCreateDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;

  /** 记录类型，如 `A` / `CNAME` / `MX` */
  @IsString()
  @IsNotEmpty()
  RecordType!: string;

  /** 记录线路，如「默认」 */
  @IsString()
  @IsNotEmpty()
  RecordLine!: string;

  /** 记录值 */
  @IsString()
  @IsNotEmpty()
  Value!: string;

  /** 主机记录，缺省为 `@` */
  @IsOptional()
  @IsString()
  SubDomain?: string;

  /** 线路ID，注：与 `RecordLine` 同传时以它为准 */
  @IsOptional()
  @IsString()
  RecordLineId?: string;

  /** MX 优先级 */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  MX?: number;

  /** TTL（秒） */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  TTL?: number;

  /** 权重，0-100 */
  @IsOptional()
  @IsInt()
  Weight?: number;

  /** 记录状态 */
  @IsOptional()
  @IsIn(DNS_STATUS)
  Status?: string;

  /** 备注 */
  @IsOptional()
  @IsString()
  Remark?: string;
}

/**
 * 修改解析记录入参
 *
 * 注：字段名与腾讯云 `ModifyRecord` 逐字一致 —— 旧 DTO 漏了 `RecordLine` / `Status`，
 * 改线路与启停状态会被 `whitelist` 剥掉，看起来「保存成功」其实没改
 */
export class DnsModifyDto extends DnsCreateDto {
  /** 记录ID */
  @IsInt()
  @Type(() => Number)
  RecordId!: number;
}

/** 删除解析记录入参 */
export class DnsDeleteDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;

  /** 记录ID */
  @IsInt()
  @Type(() => Number)
  RecordId!: number;
}

/**
 * 单条解析记录入参
 *
 * 注：走 `DescribeRecord`（按 `Domain` + `RecordId` 取 `RecordInfo`），
 * 不是 `DescribeRecordList` —— 后者既不认 `RecordId`、也不返回 `RecordInfo`
 */
export class DnsRecordDetailDto extends DnsDeleteDto {}

/** 记录类型查询入参 */
export class DnsTypeDto {
  /** 域名等级，如 `D_FREE`，缺省由腾讯云判定 */
  @IsOptional()
  @IsString()
  DomainGrade?: string;
}

/** 记录线路查询入参 */
export class DnsLineDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;

  /** 域名等级，缺省由腾讯云判定 */
  @IsOptional()
  @IsString()
  DomainGrade?: string;
}
