// 外部依赖
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 日 K 线（`bars` 表，原始、不复权） */
@Entity('bars')
@Index('IDX_bars_date_code', ['date', 'code'])
export class BarEntity {
  /** 代码 */
  @PrimaryColumn({ type: 'text', name: 'code' })
  code!: string;

  /** 日期 */
  @PrimaryColumn({ type: 'date', name: 'date' })
  date!: string;

  /** 开盘价 */
  @Column({ type: 'numeric', name: 'open', precision: 20, scale: 6, nullable: true })
  open!: string | null;

  /** 最高价 */
  @Column({ type: 'numeric', name: 'high', precision: 20, scale: 6, nullable: true })
  high!: string | null;

  /** 最低价 */
  @Column({ type: 'numeric', name: 'low', precision: 20, scale: 6, nullable: true })
  low!: string | null;

  /** 收盘价 */
  @Column({ type: 'numeric', name: 'close', precision: 20, scale: 6, nullable: true })
  close!: string | null;

  /** 前收盘价 */
  @Column({ type: 'numeric', name: 'pre_close', precision: 20, scale: 6, nullable: true })
  preClose!: string | null;

  /** 成交量（股） */
  @Column({ type: 'bigint', name: 'volume', default: 0 })
  volume!: string;

  /** 成交金额（元） */
  @Column({ type: 'numeric', name: 'amount', precision: 20, scale: 6, nullable: true })
  amount!: string | null;

  /** 换手率（%） */
  @Column({ type: 'numeric', name: 'turnover_rate', precision: 20, scale: 6, nullable: true })
  turnoverRate!: string | null;

  /** 涨跌幅（%） */
  @Column({ type: 'numeric', name: 'change_percent', precision: 20, scale: 6, nullable: true })
  changePercent!: string | null;

  /** 市盈率（TTM）—— 空串落 NULL */
  @Column({ type: 'numeric', name: 'pe_ttm', precision: 20, scale: 6, nullable: true })
  peTtm!: string | null;

  /** 市净率（MRQ） */
  @Column({ type: 'numeric', name: 'pb_mrq', precision: 20, scale: 6, nullable: true })
  pbMrq!: string | null;

  /** 市销率（TTM） */
  @Column({ type: 'numeric', name: 'ps_ttm', precision: 20, scale: 6, nullable: true })
  psTtm!: string | null;

  /** 市现率（TTM） */
  @Column({ type: 'numeric', name: 'pcf_ncf_ttm', precision: 20, scale: 6, nullable: true })
  pcfNcfTtm!: string | null;

  /** 交易状态（存枚举名：Normal / Suspended / Unknown） */
  @Column({ type: 'text', name: 'trade_status', default: 'Unknown' })
  tradeStatus!: string;

  /** 是否 ST */
  @Column({ type: 'boolean', name: 'is_st', default: false })
  isSt!: boolean;

  /** 更新时间 */
  @Column({
    type: 'timestamptz',
    name: 'updated_at',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
