// 外部依赖
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 累计复权因子（`adjust_factors` 表，按除权除息日一行） */
@Entity('adjust_factors')
@Index('IDX_adjust_factors_date', ['operateDate', 'code'])
export class AdjustFactorEntity {
  /** 代码 */
  @PrimaryColumn({ type: 'text', name: 'code' })
  code!: string;

  /** 除权除息日 */
  @PrimaryColumn({ type: 'date', name: 'operate_date' })
  operateDate!: string;

  /** 后复权累计因子（唯一可落库的因子） */
  @Column({ type: 'numeric', name: 'back_factor', precision: 20, scale: 10 })
  backFactor!: string;

  /** 更新时间 */
  @Column({
    type: 'timestamptz',
    name: 'updated_at',
    default: () => 'now()',
  })
  updatedAt!: Date;
}
