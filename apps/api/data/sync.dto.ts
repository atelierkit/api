// 外部依赖
import { IsIn } from 'class-validator';
// 内部依赖
import { SYNC_TARGET, type SyncTarget } from './sync/sync.types.js';

/** 同步目标取值清单（DTO 校验用） */
export const SYNC_TARGETS: SyncTarget[] = [
  SYNC_TARGET.SECURITY,
  SYNC_TARGET.CALENDAR,
  SYNC_TARGET.BAR_BY_DATE,
  SYNC_TARGET.ADJUST_FACTOR,
];

/** 发起/暂停同步的入参 */
export class SyncActionDto {
  /** 目标（只支持四个已实现的同步器） */
  @IsIn(SYNC_TARGETS, { message: '目标只能是 Security / Calendar / BarByDate / AdjustFactor' })
  target!: SyncTarget;
}
