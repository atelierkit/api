// 外部依赖
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
} from 'class-validator';

/** 证券类型取值（落库枚举名，筛选只列可交易类型，Unknown 是异常信号不进下拉） */
export const SECURITY_TYPE_VALUES = ['Stock', 'Index', 'Bond', 'Fund'] as const;
/** 交易所取值（落库枚举名） */
export const SECURITY_MARKET_VALUES = ['Shanghai', 'Shenzhen', 'Beijing'] as const;
/** 排序档位 */
export const SECURITY_SORT_VALUES = ['CodeAsc', 'ListDateAsc', 'ListDateDesc'] as const;

/**
 * 查询串里的数字文本 → number
 *
 * ⚠️ `@Query()` 给到的所有值都是**字符串**（`page=1` → `'1'`），而 class-validator 的 `@IsInt()`
 * 只认 number。全局管道已开 `transform: true`（见 `apps/api/validation.options.ts`），
 * 这里再显式转一次，好处是空串（`page=`）当作「未填」而不是 `Number('') === 0` 去撞 `@Min(1)`。
 * 非数字文本会变成 `NaN`，仍由 `@IsInt()` 拦成 400。
 */
function toNumberOrUndefined({ value }: TransformFnParams): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return typeof value === 'number' ? value : Number(value);
}

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
  @Transform(toNumberOrUndefined)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页条数（20~200） */
  @IsOptional()
  @Transform(toNumberOrUndefined)
  @IsInt()
  @Min(20)
  @Max(200)
  size?: number;
}

/** 证券联想查询条件 */
export class SecuritySuggestQueryDto {
  /**
   * 关键字（代码 / 六位数字 / 名称片段）
   *
   * 长度上限定在 32：联想是每敲一键查一次，超长输入没有匹配意义，也不该把整段文本送进 ILIKE。
   */
  @IsOptional()
  @IsString()
  @MaxLength(32, { message: '关键字不能超过 32 个字符' })
  keyword?: string;
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
  // 日期字符串会直接作为 date 参数下发，格式不合法只会在 PG 侧抛 22007（落成 500），故前置拦截
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '起始日期格式必须为 YYYY-MM-DD' })
  from!: string;

  /** 结束日期（YYYY-MM-DD） */
  @IsNotEmpty({ message: '结束日期不能为空' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '结束日期格式必须为 YYYY-MM-DD' })
  to!: string;
}
