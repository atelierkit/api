// 外部依赖
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';

/** 信号载荷（不含任何业务数值，数值一律走 HTTP 快照） */
export interface DataChangedSignal {
  /** 变化原因 */
  reason: 'enqueue' | 'progress' | 'finish' | 'pause' | 'recover';
  /** 发生时刻（Unix 毫秒） */
  at: number;
}

/**
 * 行情数据实时通道（socket.io 信号式）
 *
 * ⚠ 只发「变了」，载荷不含数据 —— 前端收到后走 HTTP 快照拉真实数值。
 * 鉴权不加：最坏结果只是实时性退化（读不到数据），前端不 join 房间、不订阅命名空间。
 */
@WebSocketGateway()
export class DataGateway {
  @WebSocketServer()
  private server?: Server;

  /** 广播一条「变了」信号 */
  broadcast(reason: DataChangedSignal['reason']): void {
    const signal: DataChangedSignal = { reason, at: Date.now() };
    this.server?.emit('data:changed', signal);
  }
}
