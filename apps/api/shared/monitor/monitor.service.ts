// 外部依赖
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

/** 连接池异常统计窗口（毫秒） */
const ERROR_WINDOW = 600000;
/** 掉线事件归并窗口（毫秒） */
const BURST_WINDOW = 30000;
/** 归并窗口内连续异常的告警阈值（次数） */
const BURST_LIMIT = 3;
/** 数据库探活间隔（毫秒） */
const HEARTBEAT_INTERVAL = 60000;

/** 连接池连接（仅声明本服务用到的最小结构） */
interface PoolClientLike {
  /** 服务端后端进程ID */
  processID?: number;
}

/** 连接池（仅声明本服务用到的最小结构，避免引入未安装的 pg 类型声明） */
interface PoolLike {
  /** 连接总数 */
  totalCount: number;
  /** 空闲连接数 */
  idleCount: number;
  /** 等待连接的请求数 */
  waitingCount: number;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'connect' | 'remove',
    listener: (client: PoolClientLike) => void,
  ): unknown;
}

/** 数据库连接监控服务
 *
 * 连接层故障在默认配置下不会留下任何日志：TypeORM 自带的连接池错误回调以 warn 级别输出，
 * 而本项目 logging 仅开启 error，会被日志级别过滤掉。本服务直接挂载连接池事件，
 * 补齐「连接建立」「连接异常」「异常后连接移除」三类日志，并额外做定时探活，
 * 以便故障复现时判断断开的时间点、影响范围以及是否已自愈。
 */
@Injectable()
export class DbMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbMonitorService.name);
  /** 连接池，注：TypeORM 未对外暴露连接池，仅用于只读监控 */
  private pool?: PoolLike;
  /** 连接池异常时间点，用于抖动统计 */
  private readonly errorAts: number[] = [];
  /** 最近一次连接池异常时间 */
  private lastErrorAt = 0;
  /** 最近一次突发告警时间，用于告警节流 */
  private lastBurstAt = 0;
  /** 是否需要记录重连日志 */
  private needRecoverLog = false;
  /** 探活定时器 */
  private timer?: NodeJS.Timeout;
  /** 探活连续失败次数 */
  private failTimes = 0;
  /** 是否已停止，注：模块销毁后不再探活 */
  private stopped = false;

  /**
   * 构造函数
   *
   * @param dataSource 数据源
   */
  constructor(private readonly dataSource: DataSource) {}

  /** 挂载连接池事件监听，并启动数据库探活 */
  onModuleInit(): void {
    try {
      /** 数据源驱动 */
      const driver = this.dataSource.driver as unknown as {
        master?: PoolLike;
      };
      /** 连接池 */
      const pool = driver.master;
      this.pool = pool;
      if (!pool) {
        this.logger.warn('未获取到数据库连接池，连接层监控未启用！');
        return;
      }
      pool.on('error', (error) => this.onPoolError(error));
      pool.on('connect', (client) => this.onConnect(client));
      pool.on('remove', (client) => this.onRemove(client));
      this.logger.log('数据库连接池监控已启用');
      this.startHeartbeat();
    } catch (error) {
      this.logger.error('数据库连接池监控启用失败：', error);
    }
  }

  /** 模块销毁时停止探活 */
  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 连接池异常处理
   *
   * 注：连接被对端关闭时，空闲连接也会立刻触发该回调，因此日志时间即断开时间
   *
   * @param error 连接池异常
   */
  private onPoolError(error: Error): void {
    /** 异常时间 */
    const at = Date.now();
    this.lastErrorAt = at;
    this.errorAts.push(at);
    // 只保留统计窗口内的异常时间点
    while (this.errorAts.length && this.errorAts[0] < at - ERROR_WINDOW) {
      this.errorAts.shift();
    }
    /** 归并窗口内异常次数 */
    const burst = this.errorAts.filter(
      (item) => item > at - BURST_WINDOW,
    ).length;
    this.logger.error(
      `数据库连接异常：${error.message}；连接池${this.describePool()}；` +
        `近30秒 ${burst} 次、近10分钟 ${this.errorAts.length} 次`,
    );
    // 突发告警按归并窗口节流，避免持续掉线时重复刷屏
    if (burst >= BURST_LIMIT && at - this.lastBurstAt > BURST_WINDOW) {
      this.lastBurstAt = at;
      this.logger.error(
        `数据库连接在30秒内连续异常 ${burst} 次，疑似对端整体重启或网络链路中断，` +
          `请核对数据库实例重启记录与网络状况！`,
      );
    }
    this.needRecoverLog = true;
  }

  /**
   * 连接建立处理
   *
   * @param client 新建立的连接
   */
  private onConnect(client: PoolClientLike): void {
    if (this.needRecoverLog) {
      this.needRecoverLog = false;
      this.logger.warn(
        `数据库连接异常后已重新建立连接：后端PID=${client?.processID ?? '-'}；` +
          `连接池${this.describePool()}`,
      );
      return;
    }
    this.logger.debug(
      `数据库连接已建立：后端PID=${client?.processID ?? '-'}；` +
        `连接池${this.describePool()}`,
    );
  }

  /**
   * 连接移除处理
   *
   * 注：空闲回收属于正常现象，仅在连接池刚发生异常时记录，避免日志噪音
   *
   * @param client 被移除的连接
   */
  private onRemove(client: PoolClientLike): void {
    if (Date.now() - this.lastErrorAt > BURST_WINDOW) {
      return;
    }
    this.logger.debug(
      `数据库连接已移除：后端PID=${client?.processID ?? '-'}；` +
        `连接池${this.describePool()}`,
    );
  }

  /** 启动数据库探活 */
  private startHeartbeat(): void {
    this.timer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * 数据库探活
   *
   * 注：探活独立于业务请求，用于给出连接可用性的时间线，便于圈定断开的时间窗口
   */
  private async heartbeat(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.dataSource.query('SELECT 1');
      if (this.failTimes) {
        this.logger.log(
          `数据库探活已恢复正常，此前连续失败 ${this.failTimes} 次`,
        );
        this.failTimes = 0;
      }
    } catch (error) {
      this.failTimes += 1;
      this.logger.error(
        `数据库探活失败（连续第 ${this.failTimes} 次）：` +
          `${(error as Error).message}；连接池${this.describePool()}`,
      );
    }
  }

  /**
   * 组装连接池状态
   *
   * @returns 连接池状态文案
   */
  private describePool(): string {
    if (!this.pool) {
      return '（不可读）';
    }
    return (
      `（total=${this.pool.totalCount} idle=${this.pool.idleCount}` +
      ` waiting=${this.pool.waitingCount}）`
    );
  }
}
