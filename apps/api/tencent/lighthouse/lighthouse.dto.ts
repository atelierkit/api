// 外部依赖
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 查询实例列表入参 */
export class DescribeInstancesDto {
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

/** 实例ID入参，注：启停 / 重启 / 删除四个接口的参数结构一致 */
export class InstanceDto {
  /**
   * 实例ID
   *
   * 注：旧私有 DTO 给了空串默认值且只写 `@IsString()`，等于放行空 ID（腾讯云只会回一句
   * `InvalidParameter`）；这里按必填处理
   */
  @IsString()
  @IsNotEmpty()
  InstanceId!: string;
}

/** 启动实例入参 */
export class StartInstanceDto extends InstanceDto {}

/** 停止实例入参 */
export class StopInstanceDto extends InstanceDto {}

/** 重启实例入参 */
export class RebootInstanceDto extends InstanceDto {}

/** 删除实例入参 */
export class DeleteInstanceDto extends InstanceDto {}

/** 重置实例密码入参 */
export class ResetInstancePasswordDto extends InstanceDto {
  /** 新密码，注：腾讯云要求 8-32 位 */
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  Password!: string;
}

/** 创建实例入参 */
export class CreateInstanceDto {
  /** 套餐ID */
  @IsString()
  @IsNotEmpty()
  BundleId!: string;

  /** 实例名称 */
  @IsOptional()
  @IsString()
  InstanceName?: string;

  /** 可用区 */
  @IsOptional()
  @IsString()
  Zone?: string;

  /** 付费模式，如 `PREPAID` / `POSTPAID_BY_HOUR` */
  @IsOptional()
  @IsString()
  PayMode?: string;
}
