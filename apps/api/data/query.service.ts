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

    const total = await this.barRepo.count({
      where: {
        code: query.code,
        date: { $gte: query.from, $lte: query.to } as never,
      },
    });

    // 超过上限只取最近 5000 根（按日期倒序取 5000 再正序返回）
    const truncated = total > BAR_ROW_LIMIT;
    const qb = this.barRepo
      .createQueryBuilder('b')
      .where('b.code = :code AND b.date >= :from AND b.date <= :to', {
        code: query.code,
        from: query.from,
        to: query.to,
      })
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
