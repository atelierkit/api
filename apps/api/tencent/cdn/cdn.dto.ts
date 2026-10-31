// 外部依赖
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** CDN 域名列表入参 */
export class CdnListDto {
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

  /** 域名过滤，注：支持模糊匹配 */
  @IsOptional()
  @IsString()
  Domain?: string;
}

/** CDN 域名操作入参（启停 / 删除） */
export class CdnOperateDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;
}

/**
 * 修改 CDN 域名配置入参（含备注）
 *
 * 注：`Remark` 允许空串 —— 旧的私有 DTO 用 `@IsNotEmpty`，注释却写着「删除备注请提交空内容」，
 * 两者互相矛盾（清空备注必然 400 校验失败）
 */
export class CdnRemarkDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;

  /** 备注 */
  @IsString()
  Remark!: string;
}
