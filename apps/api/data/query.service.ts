// 外部依赖
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
// 内部依赖
import { SecurityEntity } from './entities/security.entity.js';
import { TradeCalendarEntity } from './entities/trade-calendar.entity.js';
import { BarEntity } from './entities/bar.entity.js';

/** K 线单次查询上限（客户端硬编码常量的服务端表达） */
const BAR_ROW_LIMIT = 5000;

/** 联想候选条数上限，注：12 条足够铺满下拉，再多多半是误匹配 */
const SUGGEST_LIMIT = 12;

/** 证券联想的一个候选 */
export interface SecurityOption {
  /** 规范代码（如 `sh.600000`） */
  code: string;
  /** 名称 */
  name: string;
  /** 类型（落库枚举名） */
  type: string;
  /** 交易所（落库枚举名） */
  market: string;
}

/**
 * 把用户输入转成 ILIKE 的「包含」模式
 *
 * ⚠️ 必须转义 `%` / `_` / `\`：它们绑定进 SQL 参数后仍是 LIKE 的通配符，
 * 用户敲一个 `%` 就能把全表捞出来（联想列表只有 12 条，于是那 12 条毫无意义）。
 * `\` 是 PG 的默认转义符，故 `\%` 表示字面量百分号。
 */
export function likeContains(keyword: string): string {
  return `%${escapeLike(keyword)}%`;
}

/** 把用户输入转成 ILIKE 的「前缀」模式（同上，需转义通配符） */
export function likePrefix(keyword: string): string {
  return `${escapeLike(keyword)}%`;
}

/** 转义 LIKE 通配符（`\` 自身也要转义，否则 `\%` 会变成「转义符 + 通配符」） */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 证券清单查询结果 */
export interface SecurityPageResult {
  /** 当前页数据 */
  rows: SecurityRow[];
  /** 满足过滤条件的总记录数 */
  total: number;
  /** 全市场总数（无过滤时的总数，用于「共 N 只，过滤后 M 只」展示） */
  marketTotal: number;
}

/** 证券清单一行 */
export interface SecurityRow {
  code: string;
  name: string;
  type: string;
  market: string;
  listDate: string | null;
  status: string;
  delistDate: string | null;
}

/** 交易日历查询结果 */
export interface CalendarDayRow {
  calendarDate: string;
  isOpen: boolean;
}

/** K 线查询结果 */
export interface BarPageResult {
  /** 区间内 K 线（升序） */
  rows: BarRow[];
  /** 区间内总根数 */
  total: number;
  /** 是否因超过 5000 根上限被截断（只保留最近 5000 根） */
  truncated: boolean;
}

/** K 线一行 */
export interface BarRow {
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  changePercent: string | null;
  volume: string;
  amount: string | null;
  turnoverRate: string | null;
  tradeStatus: string;
}

/**
 * 行情数据只读查询服务（浏览页三页签）
 *
 * 注：日历接口只返回存在的行，不补空行 —— 「无记录 ≠ 休市」的三态靠这个保证。
 */
@Injectable()
export class DataQueryService {
  constructor(
    @InjectRepository(SecurityEntity)
    private readonly securityRepo: Repository<SecurityEntity>,
    @InjectRepository(TradeCalendarEntity)
    private readonly calendarRepo: Repository<TradeCalendarEntity>,
    @InjectRepository(BarEntity)
    private readonly barRepo: Repository<BarEntity>,
  ) {}

  /** 证券清单（服务端分页 + 关键字/类型/交易所过滤 + 三态排序） */
  async securities(query: {
    keyword?: string;
    type?: string;
    market?: string;
    sort?: string;
    page?: number;
    size?: number;
  }): Promise<SecurityPageResult> {
    const page = query.page ?? 1;
    const size = query.size ?? 50;
    const keyword = query.keyword?.trim();

    const qb = this.securityRepo.createQueryBuilder('s');

    if (keyword) {
      qb.andWhere('(s.code ILIKE :kw OR s.name ILIKE :kw)', { kw: `%${keyword}%` });
    }
    if (query.type) {
      qb.andWhere('s.type = :type', { type: query.type });
    }
    if (query.market) {
      qb.andWhere('s.market = :market', { market: query.market });
    }

    // 排序：默认代码升序；上市日期升/降序时未填上市日期的排最后
    switch (query.sort) {
      case 'ListDateAsc':
        qb.orderBy('s.listDate', 'ASC', 'NULLS LAST').addOrderBy('s.code', 'ASC');
        break;
      case 'ListDateDesc':
        qb.orderBy('s.listDate', 'DESC', 'NULLS LAST').addOrderBy('s.code', 'ASC');
        break;
      default:
        qb.orderBy('s.code', 'ASC');
    }

    const [rows, total] = await qb
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();

    const marketTotal = await this.securityRepo.count();

    return {
      rows: rows.map((s) => ({
        code: s.code,
        name: s.name,
        type: s.type,
        market: s.market,
        listDate: s.listDate,
        status: s.status,
        delistDate: s.delistDate,
      })),
      total,
      marketTotal,
    };
  }

  /**
   * 证券联想（代码 / 六位数字 / 名称片段，最多 12 条）
   *
   * 排序不是装饰，它就是这个功能可用性的全部：候选只显示十几条，而「600」「银行」这类输入
   * 会命中成百上千条。故按「档位」分级（越像用户要找的那一只越靠前）：
   * ① 代码完全相同（代码已经粘全了）→ ② 代码或六位数字**以**查询开头（逐位输入）→
   * ③ 名称**以**查询开头 → ④ 名称**包含**（收尾档，命中最多、也最不精确）。
   * 同档内先让**在市**证券靠前（退市证券要留着 —— 查历史 K 线要用，但不该占前排），再按代码升序，
   * 于是同样的输入永远给同样的顺序。
   *
   * ⚠ 联想是「每敲一键查一次」：只取 4 列、`LIMIT 12`，且不做 `count(*)`（分页才需要总数）。
   */
  async suggest(query: { keyword?: string }): Promise<SecurityOption[]> {
    const keyword = query.keyword?.trim() ?? '';
    if (!keyword) {
      return [];
    }

    const rows = await this.securityRepo
      .createQueryBuilder('s')
      .select(['s.code', 's.name', 's.type', 's.market'])
      .where('(s.code ILIKE :kw OR s.name ILIKE :kw)', { kw: likeContains(keyword) })
      .setParameter('prefix', likePrefix(keyword))
      .setParameter('exact', keyword.toLowerCase())
      .orderBy(
        `CASE
           WHEN LOWER(s.code) = :exact THEN 0
           WHEN s.code ILIKE :prefix OR split_part(s.code, '.', 2) ILIKE :prefix THEN 1
           WHEN s.name ILIKE :prefix THEN 2
           ELSE 3
         END`,
        'ASC',
      )
      .addOrderBy(`CASE WHEN s.status = 'Listed' THEN 0 ELSE 1 END`, 'ASC')
      .addOrderBy('s.code', 'ASC')
      .limit(SUGGEST_LIMIT)
      .getMany();

    return rows.map((s) => ({
      code: s.code,
      name: s.name,
      type: s.type,
      market: s.market,
    }));
  }

  /** 交易日历（一次整年，只返回存在的行） */
  async calendar(year: string): Promise<CalendarDayRow[]> {
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const rows = await this.calendarRepo
      .createQueryBuilder('c')
      .where('c.calendarDate >= :start AND c.calendarDate <= :end', { start, end })
      .orderBy('c.calendarDate', 'ASC')
      .getMany();
    // ⚠ 不补空行：三态（开市 / 有记录休市 / 无记录=未同步）靠「只返回存在的行」保证
    return rows.map((c) => ({ calendarDate: c.calendarDate, isOpen: c.isOpen }));
  }

  /** K 线（单只证券 + 日期区间，服务端表达 5000 根上限） */
  async bars(query: { code: string; from: string; to: string }): Promise<BarPageResult> {
    if (query.from > query.to) {
      throw new BadRequestException('起始日期不能晚于结束日期。');
    }

    // 计数与取数共用同一份条件表达式：两边条件一旦漂移，total 与 rows 就会对不上
    const where = 'b.code = :code AND b.date >= :from AND b.date <= :to';
    const params = { code: query.code, from: query.from, to: query.to };

    // ⚠ 不用 find-options 传区间（`{ date: { $gte, $lte } }`）：TypeORM 只认 FindOperator，
    // 不认 mongo 风格的 $gte/$lte 键，会把整个对象当单个值绑定成 `date = $n`，
    // PG 于是抛 22007 invalid input syntax for type date
    const total = await this.barRepo.createQueryBuilder('b').where(where, params).getCount();

    // 超过上限只取最近 5000 根（按日期倒序取 5000 再正序返回）
    const truncated = total > BAR_ROW_LIMIT;
    const qb = this.barRepo
      .createQueryBuilder('b')
      .where(where, params)
      .orderBy('b.date', truncated ? 'DESC' : 'ASC');

    if (truncated) {
      qb.limit(BAR_ROW_LIMIT);
    }

    let rows = await qb.getMany();
    if (truncated) {
      rows = rows.reverse();
    }

    return {
      rows: rows.map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        changePercent: b.changePercent,
        volume: b.volume,
        amount: b.amount,
        turnoverRate: b.turnoverRate,
        tradeStatus: b.tradeStatus,
      })),
      total,
      truncated,
    };
  }
}
