// 外部依赖
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  Max,
  Min,
  Matches,
} from 'class-validator';

/** 证券类型取值（落库枚举名，筛选只列可交易类型，Unknown 是异常信号不进下拉） */
export const SECURITY_TYPE_VALUES = ['Stock', 'Index', 'Bond', 'Fund'] as const;
/** 交易所取值（落库枚举名） */
export const SECURITY_MARKET_VALUES = ['Shanghai', 'Shenzhen', 'Beijing'] as const;
/** 排序档位 */
export const SECURITY_SORT_VALUES = ['CodeAsc', 'ListDateAsc', 'ListDateDesc'] as const;

/** 证券清单查询条件 */
export class SecurityQueryDto {
  /** 关键字（代码或名称 ILIKE） */
  @IsOptional()
  keyword?: string;

  /** 类型过滤 */
  @IsOptional()
  @IsIn(SECURITY_TYPE_VALUES, { message: '类型取值不合法' })
  type?: string;

  /** 交易所过滤 */
  @IsOptional()
  @IsIn(SECURITY_MARKET_VALUES, { message: '交易所取值不合法' })
  market?: string;

  /** 排序档位（默认代码升序） */
  @IsOptional()
  @IsIn(SECURITY_SORT_VALUES, { message: '排序档位不合法' })
  sort?: string;

  /** 页码（从 1 起） */
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页条数（20~200） */
  @IsOptional()
  @IsInt()
  @Min(20)
  @Max(200)
  size?: number;
}

/** 交易日历查询条件 */
export class CalendarQueryDto {
  /** 年份（4 位） */
  @Matches(/^\d{4}$/, { message: '年份必须是 4 位数字' })
  year!: string;
}

/** K 线查询条件 */
export class BarQueryDto {
  /** 证券代码（如 sh.600000） */
  @IsNotEmpty({ message: '证券代码不能为空' })
  code!: string;

  /** 起始日期（YYYY-MM-DD） */
  @IsNotEmpty({ message: '起始日期不能为空' })
  from!: string;

  /** 结束日期（YYYY-MM-DD） */
  @IsNotEmpty({ message: '结束日期不能为空' })
  to!: string;
}
