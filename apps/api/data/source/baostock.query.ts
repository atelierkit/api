// 内部依赖
import {
  FIELD_INDEX,
  MESSAGE_TYPE,
  RECORD_INDEX,
} from './baostock.schema.js';

/** 一次查询的完整描述 */
export interface BaostockQuery {
  /** 消息类型编号 */
  messageType: string;
  /** 消息体字段（按协议顺序） */
  bodyFields: string[];
  /** 记录 JSON 在响应体中的位置 */
  recordIndex: number;
  /** 列名列表在响应体中的位置 */
  fieldIndex: number;
}

/**
 * 四个业务接口的请求构造
 *
 * 匿名用户 `userId` 恒为 `anonymous`。
 */
export const BaostockQueries = {
  /** 登录请求：`login` / 用户 / 密码 / 验证码 */
  login(userId = 'anonymous', password = '123456'): BaostockQuery {
    return {
      messageType: MESSAGE_TYPE.LOGIN_REQUEST,
      bodyFields: ['login', userId, password, '0'],
      recordIndex: -1,
      fieldIndex: -1,
    };
  },

  /** 登出请求：`logout` / 用户 / 时间戳（`yyyyMMddHHmmss`） */
  logout(userId = 'anonymous', now: Date = new Date()): BaostockQuery {
    const timestamp = now
      .toISOString()
      .replace(/[-T:.Z]/g, '')
      .slice(0, 14);
    return {
      messageType: MESSAGE_TYPE.LOGOUT_REQUEST,
      bodyFields: ['logout', userId, timestamp],
      recordIndex: -1,
      fieldIndex: -1,
    };
  },

  /**
   * 交易日历查询（`33`/`34`，分页 500/页）
   *
   * 消息体 6 个字段：方法名 / 用户 / 页码 / 每页 / 起始日期 / 终止日期。
   * 响应回显前 4 个，故记录落在第 6 位、列名落在第 9 位。
   */
  tradeDates(
    userId: string,
    index: number,
    size: number,
    startDate: string,
    endDate: string,
  ): BaostockQuery {
    return {
      messageType: MESSAGE_TYPE.TRADE_DATES_REQUEST,
      bodyFields: [
        'query_trade_dates',
        userId,
        `${index}`,
        `${size}`,
        startDate,
        endDate,
      ],
      recordIndex: RECORD_INDEX.DEFAULT,
      fieldIndex: FIELD_INDEX.DEFAULT,
    };
  },

  /**
   * 证券基础信息查询（`45`/`46`，分页 500/页）
   *
   * 消息体 6 个字段：方法名 / 用户 / 页码 / 每页 / 代码 / 其它。
   * 响应回显前 4 个，故记录落在第 6 位、列名落在第 9 位。
   */
  stockBasic(
    userId: string,
    index: number,
    size: number,
    code: string,
  ): BaostockQuery {
    return {
      messageType: MESSAGE_TYPE.STOCK_BASIC_REQUEST,
      bodyFields: [
        'query_stock_basic',
        userId,
        `${index}`,
        `${size}`,
        code,
        '',
      ],
      recordIndex: RECORD_INDEX.DEFAULT,
      fieldIndex: FIELD_INDEX.DEFAULT,
    };
  },

  /**
   * A 股日 K（按交易日，`98`/`99`）
   *
   * 消息体仅 3 个字段：方法名 / 用户 / 日期；**不接受 fields 参数**（18 列固定）。
   * 响应回显前 2 个，故记录落在第 4 位、列名落在第 5 位。
   */
  aStockDaily(userId: string, date: string): BaostockQuery {
    return {
      messageType: MESSAGE_TYPE.A_STOCK_DAILY_REQUEST,
      bodyFields: ['query_daily_history_k_AStock', userId, date],
      recordIndex: RECORD_INDEX.BY_DATE,
      fieldIndex: FIELD_INDEX.BY_DATE,
    };
  },

  /**
   * 复权因子（按交易日，`9C`/`9D`）
   *
   * 消息体仅 3 个字段：方法名 / 用户 / 日期。响应回显前 2 个，记录落在第 4 位、列名落在第 5 位。
   */
  adjustFactor(userId: string, date: string): BaostockQuery {
    return {
      messageType: MESSAGE_TYPE.ADJUST_FACTOR_REQUEST,
      bodyFields: ['query_daily_adjust_factor', userId, date],
      recordIndex: RECORD_INDEX.BY_DATE,
      fieldIndex: FIELD_INDEX.BY_DATE,
    };
  },
};
