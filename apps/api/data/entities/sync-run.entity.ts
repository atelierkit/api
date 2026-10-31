// 外部依赖
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 同步执行流水（`sync_runs` 表，跑一次一行；活跃行同时就是队列） */
@Entity('sync_runs')
@Index('IDX_sync_runs_state_id', ['state', 'id'])
@Index('IDX_sync_runs_task', ['taskId', 'id'])
export class SyncRunEntity {
  /** 执行 ID */
  @PrimaryGeneratedColumn({ type: 'bigint', name: 'id' })
  id!: string;

  /** 任务 ID（外键 → sync_tasks.id） */
  @Column({ type: 'bigint', name: 'task_id' })
  taskId!: string;

  /** 目标（冗余快照） */
  @Column({ type: 'text', name: 'target' })
  target!: string;

  /** 代码（冗余快照，空串 = 整份） */
  @Column({ type: 'text', name: 'code', default: '' })
  code!: string;

  /** 状态（0 Draft / 1 Queued / 2 Running / 3 Succeeded / 4 Failed / 5 Skipped / 6 Paused） */
  @Column({ type: 'smallint', name: 'state', default: 1 })
  state!: number;

  /** 触发来源（manual / auto），由服务端写死 */
  @Column({ type: 'text', name: 'source', default: 'manual' })
  source!: string;

  /** 计划日期（手工执行用空串） */
  @Column({ type: 'text', name: 'plan_date', default: '' })
  planDate!: string;

  /** 起始日期 */
  @Column({ type: 'date', name: 'from_date', nullable: true })
  fromDate!: string | null;

  /** 终止日期 */
  @Column({ type: 'date', name: 'to_date', nullable: true })
  toDate!: string | null;

  /** 已完成量（量纲随数据类型不同：条数 / 请求次数 / 天数） */
  @Column({ type: 'bigint', name: 'done', default: 0 })
  done!: string;

  /** 总量（未知时为 0） */
  @Column({ type: 'bigint', name: 'total', default: 0 })
  total!: string;

  /** 本次真写进去多少行 */
  @Column({ type: 'bigint', name: 'rows_written', default: 0 })
  rowsWritten!: string;

  /** 当前阶段文本 */
  @Column({ type: 'text', name: 'stage', default: '' })
  stage!: string;

  /** 结果消息 */
  @Column({ type: 'text', name: 'message', nullable: true })
  message!: string | null;

  /** 尝试次数（重启对账时 +1） */
  @Column({ type: 'integer', name: 'attempts', default: 0 })
  attempts!: number;

  /** 创建时间 */
  @Column({
    type: 'timestamptz',
    name: 'created_at',
    default: () => 'now()',
  })
  createdAt!: Date;

  /** 开始时间 */
  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt!: Date | null;

  /** 结束时间 */
  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;
}
