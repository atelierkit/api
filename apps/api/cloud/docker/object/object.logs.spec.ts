// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  DOCKER_LOG_MAX_LINE,
  DOCKER_LOG_MAX_PENDING,
  DOCKER_LOG_MAX_FRAME,
  DockerLogParser,
  DockerLogRing,
} from './object.logs.js';

/**
 * 组一个日志帧
 *
 * 注：字节结构取自真实 daemon 的响应（非 TTY 模式）：
 * `[1 字节流类型][3 字节填充][4 字节大端长度][正文]`。
 * 这个结构必须与真机一致 —— 替身里自己发明一种形状，会把生产的错吸收掉。
 *
 * @param text 正文
 * @param stream 流类型，1=stdout 2=stderr
 * @returns 帧字节
 */
function frame(text: string, stream: 1 | 2 = 1): Buffer {
  /** 正文 */
  const payload = Buffer.from(text, 'utf8');
  /** 帧头 */
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

/**
 * 组装解析器
 *
 * @param tty 是否 TTY
 * @param timestamps 是否带时间戳
 * @returns 解析器
 */
function parserOf(tty = false, timestamps = false): DockerLogParser {
  return new DockerLogParser(tty, timestamps);
}

describe('DockerLogParser · 帧层', () => {
  it('单帧单行', () => {
    /** 解析器 */
    const parser = parserOf();
    expect(parser.feed(frame('hello\n'))).toEqual([
      { ts: '', stream: 'stdout', text: 'hello' },
    ]);
  });

  it('一个分片里粘着多个帧，按顺序全部吐出', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 分片 */
    const chunk = Buffer.concat([frame('a\n'), frame('b\n', 2), frame('c\n')]);
    expect(parser.feed(chunk).map((line) => `${line.stream}:${line.text}`)).toEqual([
      'stdout:a',
      'stderr:b',
      'stdout:c',
    ]);
  });

  it('帧被切成两片时不吐出半行，下一片续上后还原', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 完整帧 */
    const whole = frame('split me\n');
    expect(parser.feed(whole.subarray(0, 5))).toEqual([]);
    expect(parser.feed(whole.subarray(5))).toEqual([
      { ts: '', stream: 'stdout', text: 'split me' },
    ]);
  });

  it('帧头到了但正文没到齐，等下一片（不猜、不补零）', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 帧头声明 11 字节（含行尾换行），先只给 3 字节 */
    const head = Buffer.alloc(8);
    head[0] = 1;
    head.writeUInt32BE(11, 4);
    expect(parser.feed(Buffer.concat([head, Buffer.from('abc')]))).toEqual([]);
    expect(parser.feed(Buffer.from('defghij\n'))).toEqual([
      { ts: '', stream: 'stdout', text: 'abcdefghij' },
    ]);
  });

  it('一帧里含多行，逐行吐出', () => {
    /** 解析器 */
    const parser = parserOf();
    expect(parser.feed(frame('l1\nl2\nl3\n')).map((line) => line.text)).toEqual([
      'l1',
      'l2',
      'l3',
    ]);
  });

  it('帧正文不以换行结尾时留半行，下一个帧续上', () => {
    /** 解析器 */
    const parser = parserOf();
    expect(parser.feed(frame('partial'))).toEqual([]);
    expect(parser.feed(frame(' line\n')).map((line) => line.text)).toEqual([
      'partial line',
    ]);
  });

  it('同一个流与不同流的半行互不串味（每个流各一条行缓冲）', () => {
    /** 解析器 */
    const parser = parserOf();
    expect(parser.feed(Buffer.concat([frame('out-', 1), frame('err-\n', 2)]))).toEqual([
      { ts: '', stream: 'stderr', text: 'err-' },
    ]);
    expect(parser.feed(frame('done\n', 1))).toEqual([
      { ts: '', stream: 'stdout', text: 'out-done' },
    ]);
  });

  it('中文跨分片不被拆坏', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 一帧，正文里每字 3 字节 */
    const whole = frame('启动完成\n');
    // 注：切在第一个汉字中间，逐 chunk toString 的写法会在这里变成替换字符
    expect(parser.feed(whole.subarray(0, 10))).toEqual([]);
    expect(parser.feed(whole.subarray(10)).map((line) => line.text)).toEqual([
      '启动完成',
    ]);
  });

  it('空正文的帧与空行都保留（真实日志里空行有意义）', () => {
    /** 解析器 */
    const parser = parserOf();
    expect(parser.feed(Buffer.concat([frame('\n'), frame('')]))).toEqual([
      { ts: '', stream: 'stdout', text: '' },
    ]);
  });

  it('CRLF 去掉行尾回车（Windows 容器）', () => {
    /** 解析器 */
    const parser = parserOf();
    expect(parser.feed(frame('done\r\n')).map((line) => line.text)).toEqual(['done']);
  });

  it('流类型非法时按流损坏报 502，不继续吐乱码', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 流类型 3 不存在 */
    const bad = Buffer.alloc(8);
    bad[0] = 3;
    bad.writeUInt32BE(1, 4);
    /** 抛出的异常 */
    const err = (() => {
      try {
        parser.feed(Buffer.concat([bad, Buffer.from('x')]));
      } catch (error) {
        return error;
      }
    })();
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('帧头不正确');
  });

  it('帧长度超过上限时按流损坏报 502，不无限等内存', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 帧头声明一个荒谬的长度 */
    const bad = Buffer.alloc(8);
    bad[0] = 1;
    bad.writeUInt32BE(DOCKER_LOG_MAX_FRAME + 1, 4);
    /** 抛出的异常 */
    const err = (() => {
      try {
        parser.feed(bad);
      } catch (error) {
        return error;
      }
    })();
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect((err as HttpException).message).toContain('帧长度异常');
  });
});

describe('DockerLogParser · 超长行', () => {
  it('超过单行上限先吐一行 truncated，其后恢复正常解析', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 超长单行，注：没有换行 */
    const long = 'x'.repeat(DOCKER_LOG_MAX_LINE + 5000);
    /** 第一次喂入 */
    const first = parser.feed(Buffer.concat([frame(long)]));
    expect(first).toHaveLength(1);
    expect(first[0].truncated).toBe(true);
    expect(first[0].text.length).toBe(DOCKER_LOG_MAX_LINE);
    // 注：剩余 5000 字节此时还在丢弃模式里，换行之后才是新行
    expect(parser.feed(frame('\nnext\n')).map((line) => line.text)).toEqual(['next']);
  });

  it('丢弃模式跨帧延续：换行没来之前不吐新行', () => {
    /** 解析器 */
    const parser = parserOf();
    parser.feed(frame('y'.repeat(DOCKER_LOG_MAX_PENDING + 1)));
    expect(parser.feed(frame('tail-without-newline'))).toEqual([]);
    expect(parser.feed(frame('\nok\n')).map((line) => line.text)).toEqual(['ok']);
  });
});

describe('DockerLogParser · 时间戳', () => {
  it('小数位数不固定（9 位 / 6 位都能切）', () => {
    /** 解析器 */
    const parser = parserOf(false, true);
    expect(
      parser.feed(
        frame(
          '2026-11-04T01:12:01.338912345Z nine\n2026-11-04T01:12:01.338912Z six\n',
        ),
      ),
    ).toEqual([
      { ts: '2026-11-04T01:12:01.338912345Z', stream: 'stdout', text: 'nine' },
      { ts: '2026-11-04T01:12:01.338912Z', stream: 'stdout', text: 'six' },
    ]);
  });

  it('带时区偏移也认', () => {
    /** 解析器 */
    const parser = parserOf(false, true);
    expect(parser.feed(frame('2026-11-04T09:12:01.5+08:00 hi\n'))[0].ts).toBe(
      '2026-11-04T09:12:01.5+08:00',
    );
  });

  it('没有时间戳前缀时原样当正文，不丢内容', () => {
    /** 解析器 */
    const parser = parserOf(false, true);
    expect(parser.feed(frame('plain text\n'))).toEqual([
      { ts: '', stream: 'stdout', text: 'plain text' },
    ]);
  });

  it('不请求时间戳时即使有前缀也不切（正文里的日期不该被吃掉）', () => {
    /** 解析器 */
    const parser = parserOf(false, false);
    expect(parser.feed(frame('2026-11-04T01:12:01.3Z keep\n'))[0].text).toBe(
      '2026-11-04T01:12:01.3Z keep',
    );
  });
});

describe('DockerLogParser · TTY 模式', () => {
  it('没有帧头，直接按行切，流恒为 stdout', () => {
    /** 解析器 */
    const parser = parserOf(true);
    expect(parser.feed(Buffer.from('a\nb\n'))).toEqual([
      { ts: '', stream: 'stdout', text: 'a' },
      { ts: '', stream: 'stdout', text: 'b' },
    ]);
  });

  it('TTY 下的半行同样留到下一片', () => {
    /** 解析器 */
    const parser = parserOf(true);
    expect(parser.feed(Buffer.from('par'))).toEqual([]);
    expect(parser.feed(Buffer.from('tial\n'))[0].text).toBe('partial');
  });
});

describe('DockerLogParser · flush', () => {
  it('残留半行以 incomplete 吐出，不静默丢弃', () => {
    /** 解析器 */
    const parser = parserOf();
    parser.feed(frame('last line without newline'));
    expect(parser.flush()).toEqual({
      lines: [
        { ts: '', stream: 'stdout', text: 'last line without newline', incomplete: true },
      ],
      dropped: 0,
    });
  });

  it('不完整的帧计入 dropped，不当成一行', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 只有半个帧头 */
    parser.feed(Buffer.from([1, 0, 0, 0]));
    expect(parser.flush()).toEqual({ lines: [], dropped: 4 });
  });

  it('丢弃模式下的残留不吐出（那是超长行的尾巴，不是半行）', () => {
    /** 解析器 */
    const parser = parserOf();
    /** 首次喂入就吐出截断行 */
    const first = parser.feed(frame('z'.repeat(DOCKER_LOG_MAX_PENDING + 1)));
    expect(first.map((line) => line.truncated)).toEqual([true]);
    parser.feed(frame('still-dropping'));
    // 注：流结束时仍在丢弃模式，残留是超长行的尾巴 —— 既不是完整的行，也不该标成 incomplete
    expect(parser.flush()).toEqual({ lines: [], dropped: 0 });
  });

  it('TTY 模式没有帧可丢', () => {
    /** 解析器 */
    const parser = parserOf(true);
    expect(parser.flush()).toEqual({ lines: [], dropped: 0 });
  });
});

describe('DockerLogRing', () => {
  /**
   * 造一行
   *
   * @param text 正文
   * @returns 日志行
   */
  const lineOf = (text: string) => ({ ts: '', stream: 'stdout' as const, text });

  it('超过行数上限时丢最旧的并标记 truncated', () => {
    /** 环形缓冲 */
    const ring = new DockerLogRing(3, 1024);
    ring.push([lineOf('1'), lineOf('2'), lineOf('3'), lineOf('4'), lineOf('5')]);
    expect(ring.size).toBe(3);
    expect(ring.toArray().map((line) => line.text)).toEqual(['3', '4', '5']);
    expect(ring.truncated).toBe(true);
  });

  it('字节上限生效：只限行数挡不住「少数几行但每行巨大」', () => {
    /** 环形缓冲 */
    const ring = new DockerLogRing(100, 10);
    ring.push([lineOf('aaaaa'), lineOf('bbbbb'), lineOf('ccccc')]);
    expect(ring.size).toBe(2);
    expect(ring.truncated).toBe(true);
  });

  it('drain 取出并清空，size 归零但 truncated 不复位', () => {
    /** 环形缓冲 */
    const ring = new DockerLogRing(2, 1024);
    ring.push([lineOf('a'), lineOf('b'), lineOf('c')]);
    expect(ring.drain().map((line) => line.text)).toEqual(['b', 'c']);
    expect(ring.size).toBe(0);
    expect(ring.truncated).toBe(true);
  });

  it('未发生丢弃时 truncated 为假', () => {
    /** 环形缓冲 */
    const ring = new DockerLogRing(10, 1024);
    ring.push([lineOf('a')]);
    expect(ring.truncated).toBe(false);
  });
});
