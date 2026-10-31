// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 同步任务（`sync_tasks` 表，一个同步目标恒一行） */
@Entity('sync_tasks')
@Index('uq_sync_tasks_target_code', ['target', 'code'], { unique: true })
export class SyncTaskEntity {
  /** 任务 ID */
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id' })
  id!: string;

  /** 目标（Security / Calendar / BarByDate / AdjustFactor） */
  @Column({ type: 'text', name: 'target' })
  target!: string;

  /** 代码（空串 = 整份数据，不是 NULL） */
  @Column({ type: 'text', name: 'code', default: '' })
  code!: string;

  /** 是否启用 */
  @Column({ type: 'boolean', name: 'enabled', default: true })
  enabled!: boolean;

  /** 创建时间 */
  @Column({
    type: 'timestamptz',
    name: 'created_at',
    default: () => 'now()',
  })
  createdAt!: Date;
}
