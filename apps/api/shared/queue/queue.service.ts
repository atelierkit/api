// 外部依赖
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Subject, from, of, concatMap, catchError } from 'rxjs';

/** 队列任务类型 */
type QueueTask = () => Promise<unknown>;

/**
 * 异步队列服务
 * 用于批量处理异步任务，避免阻塞主流程
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  /** 任务流 */
  private readonly taskSubject = new Subject<QueueTask>();
  /** 是否正在关闭 */
  private isShuttingDown = false;

  constructor() {
    // 串行处理：按顺序逐个执行任务，保证同一时间只有一个任务在执行
    this.taskSubject
      .pipe(
        concatMap((task) =>
          from(task()).pipe(
            catchError((err) => {
              this.logger.error('队列任务执行失败:', err);
              return of(undefined);
            }),
          ),
        ),
      )
      .subscribe({
        next: () => {
          // 单个任务执行完成（成功或已被 catch）
        },
        error: (err) => {
          this.logger.error('队列处理异常:', err);
        },
        complete: () => {
          this.logger.log('任务流已完成');
        },
      });
  }

  /**
   * 添加任务到队列
   *
   * @param task 异步任务
   */
  addTask(task: QueueTask): void {
    if (this.isShuttingDown) {
      this.logger.warn('队列正在关闭，拒绝添加新任务');
      return;
    }
    this.taskSubject.next(task);
  }

  /**
   * 模块销毁时等待所有任务完成
   */
  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('QueueService 开始优雅关闭...');
    // 等待3秒让剩余任务执行完成
    await new Promise((resolve) => setTimeout(resolve, 3000));
    this.taskSubject.complete();
    this.logger.log('✅ QueueService 清理完成');
  }
}
