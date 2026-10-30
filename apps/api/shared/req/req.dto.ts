// 外部依赖
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

/**
 * 请求日志查询DTO
 *
 * 注：全局 ValidationPipe 开启了 whitelist，未添加校验装饰器的字段会被剥离，
 * 因此本DTO所有字段都必须保留校验装饰器，参数无需校验时使用 @IsOptional()
 */
export class ReqIndexDto {
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

  /** 请求用户ID */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  userId?: number;

  /** 请求路径（不含 query string） */
  @IsString()
  @IsOptional()
  path?: string;

  /** 控制器名 */
  @IsString()
  @IsOptional()
  controller?: string;

  /** 方法名 */
  @IsString()
  @IsOptional()
  action?: string;

  /** 结果筛选：true 为成功（2xx），false 为异常（非 2xx），缺省为不限 */
  @IsBoolean()
  @IsOptional()
  success?: boolean;

  /** 精确状态码，用于只查看某一种状态码 */
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  status?: number;

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
