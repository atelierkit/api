// 外部依赖
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';

/**
 * 操作日志查询DTO
 *
 * 注：全局 ValidationPipe 开启了 whitelist，未添加校验装饰器的字段会被剥离，
 * 因此本DTO所有字段都必须保留校验装饰器，参数无需校验时使用 @IsOptional()
 */
export class OperateIndexDto {
  /** 起始时间（毫秒时间戳），缺省为截止时间前 24 小时 */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  start?: number;

  /** 截止时间（毫秒时间戳），缺省为当前时间 */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  end?: number;

  /** 操作用户ID */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  userId?: number;

  /** 操作对象 */
  @IsString()
  @IsOptional()
  name?: string;

  /** 操作类型 */
  @IsString()
  @IsOptional()
  operate?: string;

  /** 页码，默认 1 */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  pi?: number;

  /** 每页条数，默认 20，上限 100 */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  ps?: number;
}
