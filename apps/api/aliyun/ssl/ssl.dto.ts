// 外部依赖
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * 阿里云 CAS 入参 DTO 集合
 *
 * 注 1：全局 `ValidationPipe` 开了 `whitelist`，且本组 DTO 的字段会整体透传给阿里云 RPC 接口，
 * 因此字段名必须与官方参数表逐字一致，否则会被静默剥离，最终由阿里云侧返回
 * `MissingXxx`（这类错误只报「缺哪个参数」，不报「你多传了哪个」）
 * 注 2：手机号与域名会进签名，格式必须先在本层挡住
 */

/** 域名格式，注：允许通配符前缀（`*.example.com`），但拒绝空白与斜杠 */
const DOMAIN_PATTERN = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/** 手机号格式，注：与旧前端申请表单的校验保持一致 */
const MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 证书/订单列表查询条件 */
export class SslListDto {
  /** 当前页码，从 1 开始 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  CurrentPage?: number;

  /** 每页条数，注：上限 100 —— 订单量可达上万，放大只会更容易触发 503 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  ShowSize?: number;

  /** 模糊查询，匹配域名或资源ID */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  Keyword?: string;

  /** 资源状态，如 `PAYED` / `ISSUED` / `EXPIRED` */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  Status?: string;
}

/** 证书详情入参 */
export class SslDetailDto {
  /** 证书ID（对应列表里的 `CertificateId`） */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  CertId!: number;
}

/** 上传证书入参 */
export class SslImportDto {
  /** 证书名称，注：同一账号下不可重复 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  Name!: string;

  /** PEM 格式的证书内容 */
  @IsString()
  @IsNotEmpty()
  Cert!: string;

  /** PEM 格式的私钥内容 */
  @IsString()
  @IsNotEmpty()
  Key!: string;

  /** 资源分组 ID */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ResourceGroupId?: string;

  /** 幂等标识，最大 64 个 ASCII 字符 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ClientToken?: string;
}

/** 删除证书入参 */
export class SslDeleteDto {
  /** 证书ID */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  CertId!: number;

  /** 幂等标识 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ClientToken?: string;
}

/**
 * 提交 DV 订单审核入参（`CreateDVOrderAudit`，2018-07-13）
 *
 * 注：新版 `CreateCertificateRequest` 需要「证书资源包」，而本账号只有免费额度订单，
 * 实测恒返回 `InsufficientQuota`，故申请只能走这个 2018 版接口 —— 它也是唯一入口
 */
export class SslAuditDto {
  /** 证书实例ID（订单列表里的 `InstanceId`） */
  @IsString()
  @IsNotEmpty()
  InstanceId!: string;

  /** 申请域名，多个用半角逗号分隔 */
  @IsString()
  @IsNotEmpty()
  @Matches(DOMAIN_PATTERN, { message: '域名格式不合法' })
  Domain!: string;

  /** 域名授权验证类型 */
  @IsIn(['DNS', 'FILE'])
  DomainVerifyType!: string;

  /** 申请人姓名 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  Username!: string;

  /** 申请人手机号 */
  @IsString()
  @Matches(MOBILE_PATTERN, { message: '手机号格式不合法' })
  Mobile!: string;

  /** 申请人邮箱 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  Email!: string;

  /** 省份（建议拼音） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  Province!: string;

  /** 城市（建议拼音） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  City!: string;

  /** 请求来源 IP */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  SourceIp?: string;

  /** 语言 */
  @IsOptional()
  @IsIn(['zh', 'en'])
  Lang?: string;
}

/** 取消证书申请入参 */
export class SslCancelDto {
  /** 订单ID */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  OrderId!: number;
}

/** 申请状态查询入参 */
export class SslStateDto {
  /** 订单ID */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  OrderId!: number;
}

/** DNS 验证信息探测入参 */
export class SslVerifyDto {
  /** 订单ID */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  OrderId!: number;

  /** 申请域名，注：用于查 NS；不传则由记录名逐级上推 */
  @IsOptional()
  @IsString()
  @Matches(DOMAIN_PATTERN, { message: '域名格式不合法' })
  Domain?: string;
}

/** 部署证书到 KONG 入参 */
export class SslDeployDto {
  /** 证书ID */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  CertId!: number;

  /** KONG 站点ID */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  KongId!: number;

  /** 部署方式：0 = 新建，1 = 更新 */
  @IsIn([0, 1])
  @Type(() => Number)
  update!: number;

  /** 待更新的 KONG 证书ID（更新模式下必填） */
  @IsOptional()
  @IsString()
  id?: string;
}
