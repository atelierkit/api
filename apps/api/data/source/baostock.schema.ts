// 外部依赖
// 内部依赖

/**
 * baostock 裸 TCP 协议的常量与列名
 *
 * 本文件是协议的「唯一事实来源」：端口、版本号、消息类型编号、记录位 / 列名位、错误码、列名
 * 都只在这里写一次。数值全部来自 almanac 桌面端（`BaostockProtocol` / `BaostockFields`）与
 * 旧私有 `marbleqi/api`（`BAOSTOCK_CONST`）两处相互印证过的真机抓包结论。
 */

/** 服务端主机名 */
export const SERVER_HOST = 'public-api.baostock.com';

/** 服务端端口 */
export const SERVER_PORT = 10030;

/**
 * 客户端版本号
 *
 * ⚠ 服务端有版本白名单：不符时它明确回一个错误码，而不是静默不回包。
 * 取值必须与参照实现保持一致（`00.9.20`），不要随手升级。
 */
export const CLIENT_VERSION = '00.9.20';

/** 字段分隔符 */
export const MESSAGE_SPLIT = '\x01';

/** 消息头长度（`{版本}\x01{类型}\x01{10 位长度}` = 21 字符） */
export const MESSAGE_HEADER_LENGTH = 21;

/** 响应结束标记 —— 收到它即认为一条消息已完整（13 字节） */
export const MESSAGE_END_MARK = '<![CDATA[]]>\n';

/** 读取响应的缓冲区大小 */
export const READ_BUFFER_SIZE = 16 * 1024;

/** 消息类型编号（仅登记本项目用到的，避免留下无人验证的「猜测常量」） */
export const MESSAGE_TYPE = {
  /** 登录请求 / 响应 */
  LOGIN_REQUEST: '00',
  LOGIN_RESPONSE: '01',
  /** 登出请求 / 响应 */
  LOGOUT_REQUEST: '02',
  LOGOUT_RESPONSE: '03',
  /** 交易日历查询请求 / 响应 */
  TRADE_DATES_REQUEST: '33',
  TRADE_DATES_RESPONSE: '34',
  /** 证券基础信息查询请求 / 响应 */
  STOCK_BASIC_REQUEST: '45',
  STOCK_BASIC_RESPONSE: '46',
  /** A 股日 K（按交易日）请求 / 响应（响应体 zlib 压缩；记录位 4 / 列名位 5） */
  A_STOCK_DAILY_REQUEST: '98',
  A_STOCK_DAILY_RESPONSE: '99',
  /** 复权因子（按交易日）请求 / 响应（响应体 zlib 压缩；记录位 4 / 列名位 5） */
  ADJUST_FACTOR_REQUEST: '9C',
  ADJUST_FACTOR_RESPONSE: '9D',
} as const;

/**
 * 仅这些「响应」消息类型的消息体是 zlib 压缩的
 *
 * ⚠ 压缩与否由响应的消息类型决定，不是由请求类型推断。漏登记的后果不是报错，而是把 zlib
 * 密文当 UTF-8 拆出「乱码字段」—— 因此按名单判断，绝不按「数据量大小」猜。
 */
export const COMPRESSED_RESPONSE_TYPES: ReadonlySet<string> = new Set([
  MESSAGE_TYPE.A_STOCK_DAILY_RESPONSE,
  MESSAGE_TYPE.ADJUST_FACTOR_RESPONSE,
]);

/** 错误码 */
export const ERROR_CODE = {
  SUCCESS: '0',
  /** 用户未登录（连接空闲过久被服务端断开后再请求会收到它） */
  NO_LOGIN: '10001001',
} as const;

/**
 * 记录位置 / 列名位置的逐查询常量
 *
 * 规律是「记录位置 = 2 + 请求回显字段数」：
 * - 「按证券」类（交易日历 33/34、证券基础 45/46）：记录在第 6 位、列名在第 9 位；
 * - 「按交易日」类（A 股日 K 98/99、复权因子 9C/9D）：记录在第 4 位、列名在第 5 位。
 *   用 6 去解析它们只会得到空记录且不报错。
 */
export const RECORD_INDEX = {
  /** 「按证券」类接口（缺省值） */
  DEFAULT: 6,
  /** 「按交易日」类接口 */
  BY_DATE: 4,
} as const;

export const FIELD_INDEX = {
  /** 「按证券」类接口 */
  DEFAULT: 9,
  /** 「按交易日」类接口 */
  BY_DATE: 5,
} as const;

/**
 * 各接口返回的字段名（数据源原始拼写）
 *
 * 这些名字是照抄数据源的（大小写混排、`ipoDate` 这类驼峰），刻意不做任何规范化 —— 一旦与
 * 数据源不一致，取值只会静默拿到空串，然后被当成「数据源没提供这个字段」。因此集中在这里，
 * 且每处引用都走常量而不是字面量。
 */
export const FIELD = {
  SECURITY: {
    /** 代码（如 `sh.600000`） */
    CODE: 'code',
    /** 名称 */
    NAME: 'code_name',
    /** 上市日期 */
    LIST_DATE: 'ipoDate',
    /** 退市日期 */
    DELIST_DATE: 'outDate',
    /** 类型（1=股票 2=指数 4=可转债 5=ETF/基金） */
    TYPE: 'type',
    /** 状态（1=上市 0=退市） */
    STATUS: 'status',
  },
  CALENDAR: {
    /** 日历日期 */
    DATE: 'calendar_date',
    /** 是否交易日（1=是） */
    IS_OPEN: 'is_trading_day',
  },
  BAR: {
    DATE: 'date',
    CODE: 'code',
    OPEN: 'open',
    HIGH: 'high',
    LOW: 'low',
    CLOSE: 'close',
    PRE_CLOSE: 'preclose',
    VOLUME: 'volume',
    AMOUNT: 'amount',
    ADJUST_FLAG: 'adjustflag',
    TURNOVER_RATE: 'turn',
    TRADE_STATUS: 'tradestatus',
    CHANGE_PERCENT: 'pctChg',
    IS_ST: 'isST',
    /** 市盈率（TTM）——「按交易日」接口额外带回的估值列；空串表示无值，必须落 NULL */
    PE_TTM: 'peTTM',
    /** 市净率（MRQ）—— 同上 */
    PB_MRQ: 'pbMRQ',
    /** 市销率（TTM）—— 同上 */
    PS_TTM: 'psTTM',
    /** 市现率（TTM）—— 同上 */
    PCF_NCF_TTM: 'pcfNcfTTM',
  },
  ADJUST_FACTOR: {
    /** 证券代码 */
    CODE: 'code',
    /** 除权除息日（实测恒等于请求日） */
    OPERATE_DATE: 'dividOperateDate',
    /** 前复权因子 —— 不可落库（随最新事件整体改写），读入即丢 */
    FORE_FACTOR: 'foreAdjustFactor',
    /** 后复权累计因子 —— 唯一可落库的因子 */
    BACK_FACTOR: 'backAdjustFactor',
    /** 数据源自身的第三列 —— 不可落库（口径不一致），读入即丢 */
    SINGLE_FACTOR: 'adjustFactor',
  },
} as const;

/** 证券类型取值 */
export const SECURITY_TYPE = {
  STOCK: 1,
  INDEX: 2,
  BOND: 4,
  FUND: 5,
} as const;

/** 证券状态取值 */
export const SECURITY_STATUS = {
  LISTED: 1,
  DELISTED: 0,
} as const;

/** 交易状态取值：正常 */
export const TRADE_STATUS_NORMAL = 1;
