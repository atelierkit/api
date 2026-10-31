// 外部依赖
import { Controller, Get, Query } from '@nestjs/common';
// 内部依赖
import { BarQueryDto, CalendarQueryDto, SecurityQueryDto } from './query.dto.js';
import { DataQueryService } from './query.service.js';

/**
 * 行情数据只读查询控制器（浏览页三页签）
 *
 * 注：全部登录即可访问（不加 @Allow('admin')），浏览页是纯只读页面。
 */
@Controller('data')
export class DataQueryController {
  /**
   * 构造函数
   *
   * @param querySrv 查询服务
   */
  constructor(private readonly querySrv: DataQueryService) {}

  /** 证券清单（服务端分页 + 过滤 + 排序） */
  @Get('security')
  security(@Query() value: SecurityQueryDto) {
    return this.querySrv.securities(value);
  }

  /** 交易日历（一次整年，只返回存在的行） */
  @Get('calendar')
  calendar(@Query() value: CalendarQueryDto) {
    return this.querySrv.calendar(value.year);
  }

  /** K 线（单只证券 + 日期区间） */
  @Get('bar')
  bar(@Query() value: BarQueryDto) {
    return this.querySrv.bars(value);
  }
}
