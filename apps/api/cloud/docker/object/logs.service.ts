// 外部依赖
import { Injectable, Logger } from '@nestjs/common';
// 内部依赖
import { DockerService } from '../docker.service.js';
import {
  DOCKER_TIMEOUT,
  dockerRequest,
  dockerStream,
  type DockerStreamHandle,
  type DockerTarget,
} from '../docker.request.js';
import {
  DOCKER_LOG_MAX_BYTES,
  DOCKER_LOG_TAIL_DEFAULT,
  DockerLogParser,
  DockerLogRing,
  tailOf,
  type DockerLogLine,
} from './object.logs.js';

/** TTY 探测结果的缓存时长（毫秒），注：容器的 `Tty` 在创建后不会变，缓存只为少一次 inspect */
export const DOCKER_TTY_TTL = 5 * 60 * 1000;

/** TTY 缓存条目上限，注：容器会被反复创建销毁，不设上限会慢慢涨 */
const DOCKER_TTY_CACHE_MAX = 200;

/** 日志查询参数 */
export interface DockerLogQuery {
  /** 拉取的历史行数，注：跟随场景传 0 表示只要新行 */
  tail?: number;
  /** 起始时刻（RFC3339 或 Unix 秒），缺省表示不限 */
  since?: string;
  /** 行首是否带时间戳，缺省 true —— 前端要靠它做去重 */
  timestamps?: boolean;
}

/** 日志快照 */
export interface DockerLogSnapshot {
  /** 日志行，注：命中上限时丢弃的是**最旧**的行 */
  lines: DockerLogLine[];
  /** 容器是否为 TTY 模式，注：为真时无法区分 stdout/stderr */
  tty: boolean;
  /** 是否因行数 / 字节上限发生过丢弃 */
  truncated: boolean;
}

/** 已建立的日志流 */
export interface DockerLogStream {
  /** 是否 TTY 模式 */
  tty: boolean;
  /** 流句柄，注：调用方必须消费或 `abort()`，否则连接会挂到静默超时 */
  handle: DockerStreamHandle;
  /** 解析器，注：由调用方按分片喂入 */
  parser: DockerLogParser;
}

/**
 * 拼日志接口的路径
 *
 * 注：`stdout` / `stderr` 固定都开，前端按流过滤 —— 做成 DTO 字段会让「只看 stderr」
 * 这种纯展示需求产生 4 种组合，而收益只是省一点带宽
 *
 * @param id 容器ID
 * @param query 查询参数
 * @param follow 是否持续跟随
 * @returns 接口路径
 */
export function logsPathOf(
  id: string,
  query: DockerLogQuery = {},
  follow = false,
): string {
  /** 查询片段 */
  const parts = [
    'stdout=1',
    'stderr=1',
    `tail=${tailOf(query.tail, follow ? 0 : DOCKER_LOG_TAIL_DEFAULT)}`,
    `timestamps=${query.timestamps === false ? 0 : 1}`,
  ];
  if (query.since) {
    parts.push(`since=${encodeURIComponent(query.since)}`);
  }
  if (follow) {
    parts.push('follow=1');
  }
  return `/containers/${encodeURIComponent(id)}/logs?${parts.join('&')}`;
}

/**
 * 容器日志服务
 *
 * 注 1：快照与跟随**共用 `dockerStream`** —— 非 TTY 模式的日志是带 8 字节帧头的二进制，
 * 用 `dockerRequest`（按 utf8 解码 + JSON 解析）取回来，帧头的长度字段已经损坏，
 * 再去 demux 必然错位
 * 注 2：先 inspect 一次拿 `Config.Tty` 再请求日志 —— TTY 模式没有帧头，用错解析器会把
 * 帧头字节当成正文显示
 */
@Injectable()
export class DockerLogsService {
  private readonly logger = new Logger(DockerLogsService.name);

  /** TTY 探测缓存 */
  private readonly ttyCache = new Map<string, { tty: boolean; at: number }>();

  /**
   * 构造函数
   *
   * @param dockerSrv 宿主机服务，注：用它把宿主机ID换成连接参数（不存在时抛 404）
   */
  constructor(private readonly dockerSrv: DockerService) {}

  /**
   * 取一段日志快照
   *
   * @param dockerId 宿主机ID
   * @param id 容器ID
   * @param query 查询参数
   * @returns 快照，注：行数 / 字节超限时只保留最新的部分
   */
  async snapshot(
    dockerId: number,
    id: string,
    query: DockerLogQuery = {},
  ): Promise<DockerLogSnapshot> {
    /** 目标行数，注：快照的缺省是 500 而不是 0 */
    const tail = tailOf(query.tail, DOCKER_LOG_TAIL_DEFAULT);
    /** 日志流 */
    const stream = await this.open(dockerId, id, { ...query, tail });
    /** 环形缓冲，注：先按 tail 限行，再按字节兜底 */
    const ring = new DockerLogRing(tail, DOCKER_LOG_MAX_BYTES);
    /** 是否正常读完 */
    let completed = false;
    try {
      for await (const batch of this.batches(stream)) {
        ring.push(batch);
      }
      completed = true;
    } finally {
      // 注：中途抛错（解析到坏帧、宿主机断开）必须显式中止，否则 daemon 侧会挂着这条请求
      if (!completed) {
        stream.handle.abort();
      }
    }
    return {
      lines: ring.toArray(),
      tty: stream.tty,
      truncated: ring.truncated,
    };
  }

  /**
   * 打开跟随流
   *
   * @param dockerId 宿主机ID
   * @param id 容器ID
   * @param query 查询参数
   * @returns 已建立的流，注：调用方负责消费与释放
   */
  async open(
    dockerId: number,
    id: string,
    query: DockerLogQuery = {},
  ): Promise<DockerLogStream> {
    /** 连接参数 */
    const target = await this.dockerSrv.target(dockerId);
    /** 是否 TTY */
    const tty = await this.ttyOf(target, id);
    /** 流句柄 */
    const handle = await dockerStream(target, logsPathOf(id, query, true), {
      // 注：首字节沿用默认 15 秒（容器不存在 / 宿主机不可达要尽快失败），静默超时用长值
      timeout: DOCKER_TIMEOUT,
    });
    return {
      tty,
      handle,
      parser: new DockerLogParser(tty, query.timestamps !== false),
    };
  }

  /**
   * 把字节流解析成一批批日志行
   *
   * 注：快照与网关共用本方法 —— 两处各写一遍 `for await` 迟早会在「flush 怎么处理」上分叉
   *
   * @param stream 日志流
   * @returns 日志行批次，注：空批次不产出
   */
  async *batches(stream: DockerLogStream): AsyncGenerator<DockerLogLine[]> {
    try {
      for await (const chunk of stream.handle.chunks) {
        /** 本片解析出的行 */
        const lines = stream.parser.feed(chunk);
        if (lines.length > 0) {
          yield lines;
        }
      }
    } catch (err) {
      // 注：解析到坏帧时，先把已经解出的半行交给调用方，再抛 —— 否则用户看到的是
      // 「突然一片空白」，而真正的原因（中间层改写了流）被埋在异常里
      yield* this.flushOf(stream);
      throw err;
    }
    yield* this.flushOf(stream);
  }

  /**
   * 取出解析器的残留
   *
   * 注：只调用一次 —— 第二次拿到的一定是空数组（`flush()` 会清空缓冲）
   *
   * @param stream 日志流
   * @returns 残留行批次
   */
  private *flushOf(stream: DockerLogStream): Generator<DockerLogLine[]> {
    /** 收尾结果 */
    const tail = stream.parser.flush();
    if (tail.dropped > 0) {
      this.logger.warn(
        `容器日志流在帧中间断开，丢弃 ${tail.dropped} 字节不完整帧`,
      );
    }
    if (tail.lines.length > 0) {
      yield tail.lines;
    }
  }

  /**
   * 探测容器是否为 TTY 模式
   *
   * 注：`GET /containers/{id}/json` 的 `Config.Tty` 是决定「要不要解帧头」的唯一依据，
   * 猜错会让界面显示一堆以 `\u0001` 开头的乱码行
   *
   * @param target 连接参数
   * @param id 容器ID
   * @returns 是 TTY 时为 true
   */
  private async ttyOf(target: DockerTarget, id: string): Promise<boolean> {
    /** 缓存键 */
    const key = `${target.host}:${target.port}/${id}`;
    /** 缓存条目 */
    const cached = this.ttyCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < DOCKER_TTY_TTL) {
      return cached.tty;
    }
    /** 容器详情 */
    const body = await dockerRequest<{ Config?: { Tty?: boolean } }>(
      target,
      `/containers/${encodeURIComponent(id)}/json`,
    );
    /** 是否 TTY */
    const tty = body?.Config?.Tty === true;
    if (this.ttyCache.size >= DOCKER_TTY_CACHE_MAX) {
      this.ttyCache.clear();
    }
    this.ttyCache.set(key, { tty, at: Date.now() });
    return tty;
  }
}
