// 外部依赖
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  MaxLength,
} from 'class-validator';

/** 创建 KONG 网关站点DTO */
export class KongCreateDto {
  /** 实例名称 */
  @IsNotEmpty({ message: '实例名称不能为空！' })
  @MaxLength(50, { message: '实例名称不能超过 50 个字符！' })
  name!: string;

  /** 实例说明 */
  @IsNotEmpty({ message: '实例说明不能为空！' })
  @MaxLength(200, { message: '实例说明不能超过 200 个字符！' })
  description!: string;

  /** Admin API 地址 */
  @IsNotEmpty({ message: '接口地址不能为空！' })
  @MaxLength(200, { message: '接口地址不能超过 200 个字符！' })
  url!: string;

  /**
   * 启用状态
   *
   * 注：不能用 `@IsNotEmpty()` —— 它对 `false` 判空，新建一个禁用站点会被误拒
   */
  @IsBoolean({ message: '状态格式不正确！' })
  status!: boolean;
}

/** 更新 KONG 网关站点DTO，注：字段全部可选，前端按需只提交改动项 */
export class KongUpdateDto {
  /** 实例名称 */
  @IsOptional()
  @IsNotEmpty({ message: '实例名称不能为空！' })
  @MaxLength(50, { message: '实例名称不能超过 50 个字符！' })
  name?: string;

  /** 实例说明 */
  @IsOptional()
  @IsNotEmpty({ message: '实例说明不能为空！' })
  @MaxLength(200, { message: '实例说明不能超过 200 个字符！' })
  description?: string;

  /** Admin API 地址 */
  @IsOptional()
  @IsNotEmpty({ message: '接口地址不能为空！' })
  @MaxLength(200, { message: '接口地址不能超过 200 个字符！' })
  url?: string;

  /** 启用状态 */
  @IsOptional()
  @IsBoolean({ message: '状态格式不正确！' })
  status?: boolean;
}
