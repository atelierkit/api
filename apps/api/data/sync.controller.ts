// 外部依赖
import { Body, Controller, Get, Post } from '@nestjs/common';
// 内部依赖
import { Allow } from '@shared';
import { SyncActionDto } from './sync.dto.js';
import { SyncService } from './sync.service.js';

/**
 * 行情数据同步控制器
 *
 * 写操作（start / pause）要求 admin；快照只读，登录即可。
 */
@Controller('data/sync')
export class SyncController {
  /**
   * 构造函数
   *
   * @param syncSrv 同步服务
   */
  constructor(private readonly syncSrv: SyncService) {}

  /** 发起同步（从台账断点续） */
  @Post('start')
  @Allow('admin')
  async start(@Body() value: SyncActionDto) {
    return this.syncSrv.start(value.target);
  }

  /** 暂停该目标所有 Running 的执行 */
  @Post('pause')
  @Allow('admin')
  async pause(@Body() value: SyncActionDto) {
    return this.syncSrv.pause(value.target);
  }

  /** 快照：四卡汇总 + 当前进度 + 队列计数 */
  @Get('snapshot')
  async snapshot() {
    return this.syncSrv.snapshot();
  }
}
