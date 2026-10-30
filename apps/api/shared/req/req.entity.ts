// 外部依赖
import { Logger } from '@nestjs/common';
import { Entity, Column, PrimaryColumn, Index, AfterLoad } from 'typeorm';

/** 请求日志表 */
@Entity('req_logs')
export class ReqEntity {
  /** 请求ID */
  @PrimaryColumn({ type: 'bigint', name: 'req_id', comment: '请求ID' })
  reqId!: number;

  /** 请求用户ID */
  @Column({ type: 'int', name: 'user_id', default: 0, comment: '请求用户ID' })
  @Index('idx_req_logs_user_id')
  userId!: number;

  /** 请求路径 */
  @Column({ type: 'text', name: 'url', comment: '请求路径' })
  url!: string;

  /** 控制器名 */
  @Column({ type: 'text', name: 'controller', comment: '控制器' })
  controller!: string;

  /** 方法名 */
  @Column({ type: 'text', name: 'action', comment: '方法名' })
  action!: string;

  /** 响应状态码 */
  @Column({ type: 'int', name: 'status', default: 200, comment: '响应状态码' })
  @Index('idx_req_logs_status')
  status!: number;

  /** 客户端IP */
  @Column({ type: 'inet', name: 'client_ip', comment: '客户端IP' })
  clientIp!: string;

  /** 服务器IP */
  @Column({ type: 'inet', name: 'server_ip', comment: '服务器IP' })
  serverIp!: string;

  /** 请求到达时间 */
  @Column({
    type: 'bigint',
    name: 'start_at',
    default: 0,
    comment: '请求到达时间',
  })
  @Index('idx_req_logs_start_at')
  startAt!: number;

  /** 响应完成时间 */
  @Column({
    type: 'bigint',
    name: 'end_at',
    default: 0,
    comment: '响应完成时间',
  })
  endAt!: number;

  /** 对长整型数据进行数据转换 */
  @AfterLoad()
  reqLoad() {
    const logger = new Logger(ReqEntity.name);
    logger.debug('触发日志load操作');
    this.reqId = this.reqId ? Number(this.reqId) : 0;
    this.startAt = this.startAt ? Number(this.startAt) : 0;
    this.endAt = this.endAt ? Number(this.endAt) : 0;
  }
}
