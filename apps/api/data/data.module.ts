// 外部依赖
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// 内部依赖
import { SharedModule } from '@shared';
import { DataGateway } from './data.gateway.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { DataQueryController } from './query.controller.js';
import { DataQueryService } from './query.service.js';
import { SecurityEntity } from './entities/security.entity.js';
import { TradeCalendarEntity } from './entities/trade-calendar.entity.js';
import { BarEntity } from './entities/bar.entity.js';
import { AdjustFactorEntity } from './entities/adjust-factor.entity.js';
import { DataCoverageEntity } from './entities/data-coverage.entity.js';
import { SyncTaskEntity } from './entities/sync-task.entity.js';
import { SyncRunEntity } from './entities/sync-run.entity.js';

/**
 * 行情数据模块（同步 + 快照）
 *
 * 注：消费段放 api 进程内（`SyncService` 的 `onApplicationBootstrap` 对账 + 串行消费），
 * ⚠ 因此 api 部署必须单实例 —— 僵尸对账在多副本下会互相抢走对方正在跑的执行。
 */
@Module({
  imports: [
    SharedModule,
    TypeOrmModule.forFeature([
      SecurityEntity,
      TradeCalendarEntity,
      BarEntity,
      AdjustFactorEntity,
      DataCoverageEntity,
      SyncTaskEntity,
      SyncRunEntity,
    ]),
  ],
  providers: [SyncService, DataGateway, DataQueryService],
  controllers: [SyncController, DataQueryController],
  exports: [SyncService, DataGateway, DataQueryService],
})
export class DataModule {}
