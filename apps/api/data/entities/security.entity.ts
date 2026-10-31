// 外部依赖
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 证券基础信息（`securities` 表） */
@Entity('securities')
export class SecurityEntity {
  /** 代码（如 `sh.600000`），直接作主键 */
  @PrimaryColumn({ type: 'text', name: 'code' })
  code!: string;

  /** 名称 */
  @Column({ type: 'text', name: 'name' })
  name!: string;

  /** 类型（存枚举名：Stock / Index / Bond / Fund） */
  @Column({ type: 'text', name: 'type' })
  type!: string;

  /** 交易所（存枚举名：SH / SZ / BJ） */
  @Column({ type: 'text', name: 'market' })
  market!: string;

  /** 上市日期 */
  @Column({ type: 'date', name: 'list_date', nullable: true })
  listDate!: string | null;

  /** 退市日期 */
  @Column({ type: 'date', name: 'delist_date', nullable: true })
  delistDate!: string | null;

  /** 状态（存枚举名：Listed / Delisted） */
  @Column({ type: 'text', name: 'status' })
  status!: string;

  /** 更新时间 */
  @Column({
    type: 'timestamptz',
    name: 'updated_at',
    default: () => 'now()',
  })
  updatedAt!: Date;
}

/** 证券表按「交易所 + 类型」的索引 */
@Index('ix_securities_market_type', ['market', 'type'])
export class SecurityIndex {}
