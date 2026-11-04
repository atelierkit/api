// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';

/** 日志流 */
export type DockerLogStream = 'stdout' | 'stderr';

/** 单行日志 */
export interface DockerLogLine {
  /**
   * 时间戳（RFC3339Nano 原串）
   *
   * 注：`timestamps=false` 或该行没有时间戳前缀时为空串；原样下发而不在后端格式化，
   * 前端要按本地时区显示、又要能拿它做 `since` 去重，两者都需要原始精度
   */
  ts: string;
  /** 所属流，注：TTY 模式无法区分，恒为 `stdout` */
  stream: DockerLogStream;
  /** 正文，注：不含行尾换行与 `\r` */
  text: string;
  /** 本行因超过单行上限被截断 */
  truncated?: boolean;
  /** 流结束时残留的半行（下一帧本该续上，但流已断） */
  incomplete?: boolean;
}

/** 单行上限（字节），注：无换行的巨型输出（base64 大 JSON）不能整行进内存 */
export const DOCKER_LOG_MAX_LINE = 16 * 1024;

/** 单个流的行缓冲上限（字节），注：超过即强制切行并进入丢弃模式 */
export const DOCKER_LOG_MAX_PENDING = DOCKER_LOG_MAX_LINE;

/** 单帧上限（字节），注：超过说明帧头已错位（中间层改写了流），直接报错而不是无限等 */
export const DOCKER_LOG_MAX_FRAME = 16 * 1024 * 1024;

/** 日志行的缓冲上限（行数） */
export const DOCKER_LOG_MAX_LINES = 5000;

/** 日志行的缓冲上限（字节），注：与单连接内存预算对齐 */
export const DOCKER_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 首屏默认行数 */
export const DOCKER_LOG_TAIL_DEFAULT = 500;

/** `tail` 允许的最大值，注：daemon 接受 `all`，但那等于把日志文件整份读进 api 内存 */
export const DOCKER_LOG_TAIL_MAX = 5000;

/**
 * `tail` 归一
 *
 * 注 1：`0` 是**合法值** —— 跟随新日志时 `tail=0` 表示「不要历史」，只接之后产生的行；
 * 快照场景传 0 会得到空内容，这是调用方自己的选择
 * 注 2：负数、非数字一律退回缺省值，而不是钳到 0 —— 前端传坏了不该表现成「没有日志」
 *
 * @param value 前端提交的值
 * @param fallback 缺省值
 * @returns 0 ~ 5000 的整数
 */
export function tailOf(
  value: unknown,
  fallback: number = DOCKER_LOG_TAIL_DEFAULT,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  /** 解析后的数值 */
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(DOCKER_LOG_TAIL_MAX, parsed);
}

/**
 * 时间戳前缀
 *
 * 注 1：daemon 的格式是 RFC3339Nano（`2026-11-04T01:12:01.338912Z`），**小数位数不固定**，
 * 故不能写死 9 位
 * 注 2：个别实现会带 `+00:00` 偏移，一并接受
 * 注 3：正文可能为空，故用 `\s` 之后允许任意内容
 */
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\s([\s\S]*)$/;

/** 换行符的字节值 */
const LF = 0x0a;

/** 回车符 */
const CR = 0x0d;

/**
 * 帧头的流类型 → 日志流
 *
 * 注：0 是 stdin，`logs` 接口不会返回它；这里按 stdout 处理只是为了「遇到就用、不要炸」
 */
const STREAM_OF: Record<number, DockerLogStream> = {
  0: 'stdout',
  1: 'stdout',
  2: 'stderr',
};

/**
 * 容器日志解析器
 *
 * 注 1：**必须有状态**。Docker 的日志流有两处会跨 chunk 被切断：
 *   ① 非 TTY 模式下是 `[1 字节流类型][3 字节填充][4 字节大端长度][正文]` 的循环帧，
 *      一个帧可能只到了前几字节；
 *   ② 帧的正文**通常不以换行结尾**（daemon 按自己的缓冲切块），一行也可能被切成两段。
 * 故这里是「帧层缓冲 + 每个流一条行层缓冲」两层，一次性 `demux(buf)` 在真实流量下必然错位。
 * 注 2：行层缓冲用 `Buffer` 而不是字符串 —— 一个汉字可能跨两个 chunk，逐 chunk `toString()`
 * 会把它拆成两个替换字符（与 `remote` 模块的 `TextDecoder(stream:true)` 是同一类问题）。
 * 注 3：超长行不能「整块丢弃」也不能「无限累积」：切到上限就吐一行 `truncated`，
 * 随后进入丢弃模式直到遇见下一个换行，否则剩余部分会被当成新行的开头。
 */
export class DockerLogParser {
  /** 帧层缓冲，注：TTY 模式下恒为空 */
  private frame: Buffer = Buffer.alloc(0);

  /** 每个流的行层缓冲 */
  private readonly pending: Record<DockerLogStream, Buffer> = {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };

  /** 每个流是否处于「超长行丢弃」模式 */
  private readonly discarding: Record<DockerLogStream, boolean> = {
    stdout: false,
    stderr: false,
  };

  /**
   * 构造函数
   *
   * @param tty 容器是否为 TTY 模式，注：`Config.Tty`，为真时无帧头、无法区分 stdout/stderr
   * @param timestamps 行首是否带时间戳，注：请求里带了 `timestamps=1` 才为真
   */
  constructor(
    private readonly tty: boolean,
    private readonly timestamps: boolean,
  ) {}

  /**
   * 喂入一个响应分片
   *
   * @param chunk 分片
   * @returns 本次能完整解析出的行，注：半行留在缓冲里等下一片
   * @throws HttpException 帧头损坏时抛出（说明流被中间层改写，继续读只会得到乱码）
   */
  feed(chunk: Buffer): DockerLogLine[] {
    if (chunk.length === 0) {
      return [];
    }
    // TTY 模式是裸文本，没有帧头可解
    if (this.tty) {
      return this.split('stdout', chunk);
    }
    this.frame =
      this.frame.length === 0 ? chunk : Buffer.concat([this.frame, chunk]);
    /** 本次解析出的行 */
    const lines: DockerLogLine[] = [];
    while (this.frame.length >= 8) {
      /** 流类型 */
      const type = this.frame[0];
      /** 正文长度 */
      const length = this.frame.readUInt32BE(4);
      if (STREAM_OF[type] === undefined) {
        throw new HttpException(
          `容器日志流的帧头不正确（流类型 ${type}），可能是中间代理改写了响应！`,
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (length > DOCKER_LOG_MAX_FRAME) {
        throw new HttpException(
          `容器日志流的帧长度异常（${length} 字节），可能是中间代理改写了响应！`,
          HttpStatus.BAD_GATEWAY,
        );
      }
      // 注：帧还没到齐，留在缓冲里等下一片 —— 不猜、不补零
      if (this.frame.length < 8 + length) {
        break;
      }
      /** 帧正文 */
      const payload = this.frame.subarray(8, 8 + length);
      this.frame = this.frame.subarray(8 + length);
      lines.push(...this.split(STREAM_OF[type], payload));
    }
    return lines;
  }

  /**
   * 结束流
   *
   * 注：把行层残留作为 `incomplete` 吐出（宁可显示半行，也不要静默丢掉用户最后看到的内容）；
   * 不完整的帧（流在帧中间断掉）直接丢弃并计入 `dropped`，它们本来就不构成一行
   *
   * @returns 残留行与被丢弃的帧字节数
   */
  flush(): { lines: DockerLogLine[]; dropped: number } {
    /** 残留行 */
    const lines: DockerLogLine[] = [];
    for (const stream of ['stdout', 'stderr'] as const) {
      /** 行层残留 */
      const rest = this.pending[stream];
      this.pending[stream] = Buffer.alloc(0);
      /** 是否处于丢弃模式 */
      const discarding = this.discarding[stream];
      this.discarding[stream] = false;
      // 注：丢弃模式下的残留是超长行的尾部，不是半行，不能吐给前端
      if (rest.length > 0 && !discarding) {
        lines.push({ ...this.lineOf(rest, stream), incomplete: true });
      }
    }
    /** 被丢弃的帧字节数 */
    const dropped = this.tty ? 0 : this.frame.length;
    this.frame = Buffer.alloc(0);
    return { lines, dropped };
  }

  /**
   * 按换行切分一个流的字节
   *
   * @param stream 所属流
   * @param payload 字节
   * @returns 完整行
   */
  private split(stream: DockerLogStream, payload: Buffer): DockerLogLine[] {
    /** 待处理字节 */
    let rest = payload;
    if (this.discarding[stream]) {
      /** 换行位置 */
      const end = rest.indexOf(LF);
      if (end === -1) {
        return [];
      }
      // 超长行的尾部在这里结束，其后才是新行
      rest = rest.subarray(end + 1);
      this.discarding[stream] = false;
    }
    /** 拼接后的字节，注：缓冲为空时直接用本片，避免一次无谓拷贝 */
    const buffer =
      this.pending[stream].length === 0
        ? rest
        : Buffer.concat([this.pending[stream], rest]);
    /** 完整行 */
    const lines: DockerLogLine[] = [];
    /** 下一行的起点 */
    let start = 0;
    for (;;) {
      /** 换行位置 */
      const end = buffer.indexOf(LF, start);
      if (end === -1) {
        break;
      }
      lines.push(this.lineOf(buffer.subarray(start, end), stream));
      start = end + 1;
    }
    /** 剩余字节 */
    const tail = buffer.subarray(start);
    if (tail.length > DOCKER_LOG_MAX_PENDING) {
      // 注：一行超过上限且还没见到换行 —— 切一段吐出去，其余进丢弃模式
      /** 截断行 */
      const cut = this.lineOf(tail.subarray(0, DOCKER_LOG_MAX_LINE), stream);
      lines.push({ ...cut, truncated: true });
      this.pending[stream] = Buffer.alloc(0);
      this.discarding[stream] = true;
      return lines;
    }
    // 注：subarray 是视图，若不拷贝而原 buffer 又被复用会读到脏数据；
    // 这里上游每片都是新 Buffer，且我们只保留尾部，故直接持有视图是安全的
    this.pending[stream] = tail;
    return lines;
  }

  /**
   * 字节 → 日志行
   *
   * @param raw 一行的字节（不含换行）
   * @param stream 所属流
   * @returns 日志行
   */
  private lineOf(raw: Buffer, stream: DockerLogStream): DockerLogLine {
    /** 行尾回车，注：Windows 容器会带 `\r\n` */
    const body = raw.length > 0 && raw[raw.length - 1] === CR ? raw.subarray(0, -1) : raw;
    /** 正文 */
    let text = body.toString('utf8');
    /** 时间戳 */
    let ts = '';
    if (this.timestamps) {
      /** 匹配结果 */
      const matched = TIMESTAMP_PATTERN.exec(text);
      if (matched !== null) {
        ts = matched[1];
        text = matched[2];
      }
    }
    return { ts, stream, text };
  }
}

/**
 * 日志行环形缓冲
 *
 * 注 1：同时受行数与字节数两个上限约束，先到者为准 —— 只限行数挡不住「1000 行 × 1 MB」，
 * 只限字节数又会让每秒数千行的服务把 `drain()` 的单帧撑爆
 * 注 2：`truncated` 一旦置真就不再复位：前端据此提示「输出过快，已丢弃早期数据」，
 * 中途复位会让提示一闪而过
 */
export class DockerLogRing {
  /** 行清单 */
  private lines: DockerLogLine[] = [];

  /** 当前字节数，注：按 UTF-16 长度估算，用于预算控制而非精确计费 */
  private bytes = 0;

  /** 是否发生过丢弃 */
  private dropped = false;

  /**
   * 构造函数
   *
   * @param maxLines 行数上限
   * @param maxBytes 字节上限
   */
  constructor(
    private readonly maxLines: number = DOCKER_LOG_MAX_LINES,
    private readonly maxBytes: number = DOCKER_LOG_MAX_BYTES,
  ) {}

  /**
   * 追加若干行
   *
   * @param lines 日志行
   */
  push(lines: readonly DockerLogLine[]): void {
    for (const line of lines) {
      this.lines.push(line);
      this.bytes += line.text.length + line.ts.length;
    }
    while (
      this.lines.length > this.maxLines ||
      (this.bytes > this.maxBytes && this.lines.length > 1)
    ) {
      /** 被丢弃的行 */
      const droppedLine = this.lines.shift();
      if (droppedLine === undefined) {
        break;
      }
      this.bytes -= droppedLine.text.length + droppedLine.ts.length;
      this.dropped = true;
    }
  }

  /**
   * 取出并清空
   *
   * @returns 当前缓冲的行
   */
  drain(): DockerLogLine[] {
    /** 当前内容 */
    const lines = this.lines;
    this.lines = [];
    this.bytes = 0;
    return lines;
  }

  /**
   * 当前内容（不清空）
   *
   * @returns 当前缓冲的行
   */
  toArray(): DockerLogLine[] {
    return this.lines;
  }

  /**
   * 是否发生过丢弃
   *
   * @returns 发生过为 true
   */
  get truncated(): boolean {
    return this.dropped;
  }

  /**
   * 当前行数
   *
   * @returns 行数
   */
  get size(): number {
    return this.lines.length;
  }
}
