// 外部依赖
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * 证书列表入参
 *
 * 注：`Offset` 从 0 开始（腾讯云口径），与前端表格的页码差 1
 */
export class SslListDto {
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
}

/** 证书ID入参 */
export class SslDetailDto {
  /** 证书ID */
  @IsString()
  @IsNotEmpty()
  CertificateId!: string;
}

/** 证书操作入参（吊销 / 删除） */
export class SslOperateDto {
  /** 证书ID */
  @IsString()
  @IsNotEmpty()
  CertificateId!: string;
}

/** 修改证书备注入参 */
export class SslAliasDto {
  /** 证书ID */
  @IsString()
  @IsNotEmpty()
  CertificateId!: string;

  /**
   * 备注名称
   *
   * 注：允许空串 —— 清空备注是合法操作，不能用 `@IsNotEmpty` 挡掉
   */
  @IsString()
  Alias!: string;
}

/**
 * 申请证书入参
 *
 * 注 1：字段名与腾讯云 `ApplyCertificate` 逐字一致，全局 `ValidationPipe({whitelist:true})`
 * 会把未声明的字段剥掉，改名就等于让腾讯云报 `MissingParameter`
 * 注 2：`PackageType` 在腾讯云是整数（目前免费证书只有 83）
 */
export class SslApplyDto {
  /** 证书绑定的域名 */
  @IsString()
  @IsNotEmpty()
  DomainName!: string;

  /**
   * 域名验证方式
   *
   * `DNS_AUTO` = 自动添加 DNS 验证（域名需托管在云解析且同账号）、`DNS` = 手动 DNS 验证、`FILE` = 文件验证
   */
  @IsIn(['DNS_AUTO', 'DNS', 'FILE'])
  DvAuthMethod!: string;

  /** 证书类型，缺省为免费证书 83 */
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  PackageType?: number;

  /** 原证书ID，传入时建立续期关系（原证书需未过期且剩余有效期不足 30 天） */
  @IsOptional()
  @IsString()
  OldCertificateId?: string;
}

/** 部署证书到 KONG 入参 */
export class SslDeployDto {
  /** 证书ID */
  @IsString()
  @IsNotEmpty()
  CertificateId!: string;

  /** 证书域名列表，注：直接作为 KONG 证书对象的 `snis` */
  @IsArray()
  @IsString({ each: true })
  domain!: string[];

  /** KONG 站点ID */
  @IsInt()
  @Type(() => Number)
  KongId!: number;

  /** 部署方式：0 = 新建，1 = 更新 */
  @IsIn([0, 1])
  @Type(() => Number)
  update!: number;

  /** 待更新的 KONG 证书ID（更新模式下必填，缺省由控制器判错） */
  @IsOptional()
  @IsString()
  id?: string;
}
