// 外部依赖
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 交易日历（`trade_calendar` 表）—— 只存「日期 + 是否开市」两列 */
@Entity('trade_calendar')
export class TradeCalendarEntity {
  /** 日历日期 */
  @PrimaryColumn({ type: 'date', name: 'calendar_date' })
  calendarDate!: string;

  /** 是否开市 */
  @Column({ type: 'boolean', name: 'is_open' })
  isOpen!: boolean;

  /** 更新时间 */
  @Column({
    type: 'timestamptz',
    name: 'updated_at',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
