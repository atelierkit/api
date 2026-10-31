// 外部依赖
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** 数据覆盖度（同步台账，`data_coverage` 表）—— 每 `(scope, dataset, parameters)` 一行 */
@Entity('data_coverage')
export class DataCoverageEntity {
  /** 作用域 */
  @PrimaryColumn({ type: 'text', name: 'scope' })
  scope!: string;

  /** 数据集 */
  @PrimaryColumn({ type: 'text', name: 'dataset' })
  dataset!: string;

  /** 参数指纹（整份数据用空串） */
  @PrimaryColumn({ type: 'text', name: 'parameters', default: '' })
  parameters!: string;

  /** 已处理到的最后日期 */
  @Column({ type: 'date', name: 'last_date', nullable: true })
  lastDate!: string | null;

  /** 累计记录数（只用于展示与对账） */
  @Column({ type: 'bigint', name: 'record_count', default: 0 })
  recordCount!: string;

  /** 更新时间 */
  @Column({
    type: 'timestamptz',
    name: 'updated_at',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
