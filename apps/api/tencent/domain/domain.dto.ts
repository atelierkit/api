// 外部依赖
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** 域名列表入参，注：`Offset` 从 0 开始（腾讯云口径） */
export class DomainListDto {
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

/** 修改域名备注入参 */
export class DomainRemarkDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;

  /**
   * 备注内容
   *
   * 注：允许空串 —— 腾讯云约定「删除备注请提交空内容」，用 `@IsNotEmpty` 会把清空操作挡在 400
   */
  @IsOptional()
  @IsString()
  Remark?: string;
}

/** 域名详情入参 */
export class DomainDetailDto {
  /** 域名 */
  @IsString()
  @IsNotEmpty()
  Domain!: string;
}
