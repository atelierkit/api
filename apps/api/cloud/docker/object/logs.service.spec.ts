// 外部依赖
import { HttpException } from '@nestjs/common';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import type { DockerService } from '../docker.service.js';
import { dockerTargetOf } from '../docker.request.js';
import { DockerLogsService, logsPathOf } from './logs.service.js';

/**
 * 组一个日志帧
 *
 * 注：结构与真实 daemon 一致（`[1 字节流类型][3 字节填充][4 字节大端长度][正文]`），
 * 替身自己发明形状会把生产的错吸收掉
 *
 * @param text 正文
 * @param stream 流类型
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

/** 假 daemon 的行为 */
interface Daemon {
  /** 容器是否 TTY */
  tty: boolean;
  /** 日志响应体 */
  body: Buffer;
  /** 容器是否存在 */
  exists: boolean;
}

/** 假 daemon */
let server: Server;
/** 假 daemon 端口 */
let port = 0;
/** 当前行为 */
let daemon: Daemon;
/** 收到的请求路径 */
let paths: string[];
/** inspect 被调用的次数 */
let inspectCount = 0;

/**
 * 组装被测服务
 *
 * @returns 被测服务
 */
function serviceOf(): DockerLogsService {
  /** 宿主机服务替身，注：只替身 target，其余链路（请求、解析）都走真实实现 */
  const dockerSrv = {
    target: vi.fn(async (_id: number) =>
      dockerTargetOf(`tcp://127.0.0.1:${port}`, false, { verify: true }, '1.47'),
    ),
  };
  return new DockerLogsService(dockerSrv as unknown as DockerService);
}

beforeEach(async () => {
  daemon = {
    tty: false,
    body: frame('line1\n'),
    exists: true,
  };
  paths = [];
  inspectCount = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    /** 请求路径 */
    const path = req.url ?? '';
    paths.push(path);
    if (path.includes('/json')) {
      inspectCount += 1;
      if (!daemon.exists) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"No such container: abc"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Config: { Tty: daemon.tty } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(daemon.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('logsPathOf', () => {
  it('快照缺省拉 500 行，跟随缺省只接新行（tail=0）', () => {
    expect(logsPathOf('abc')).toBe(
      '/containers/abc/logs?stdout=1&stderr=1&tail=500&timestamps=1',
    );
    expect(logsPathOf('abc', {}, true)).toContain('tail=0');
    expect(logsPathOf('abc', {}, true)).toContain('follow=1');
  });

  it('since 转成 Unix 秒（daemon 只认 10 位数字，RFC3339 会 400）', () => {
    // 注：实测工控机的 daemon 28.x 对任何 RFC3339 形式都回 400，且 19 位纳秒会被当成秒
    expect(
      logsPathOf('abc', { since: '2026-11-05T01:57:07.987702007Z' }),
    ).toContain('since=1793843827');
    expect(logsPathOf('abc', { since: '2026-11-05T01:57:07Z' })).toContain(
      'since=1793843827',
    );
    // 已经是 Unix 秒的原样传
    expect(logsPathOf('abc', { since: '1793843827' })).toContain(
      'since=1793843827',
    );
    // 纳秒宽度不原样透传（会被 daemon 误读成未来），按无法识别处理
    expect(logsPathOf('abc', { since: '1793843827987702007' })).not.toContain(
      'since=',
    );
    // 认不出来就不带该参数（等于不限），而不是把脏值丢给 daemon
    expect(logsPathOf('abc', { since: '不是时间' })).not.toContain('since=');
    expect(logsPathOf('abc', { since: '' })).not.toContain('since=');
  });

  it('timestamps 可关', () => {
    expect(logsPathOf('abc', { timestamps: false })).toContain('timestamps=0');
  });

  it('容器 ID 会被编码（挡住路径穿越）', () => {
    expect(logsPathOf('../etc')).toContain('/containers/..%2Fetc/logs');
  });

  it('tail 超过上限被钳住，非法值退回缺省', () => {
    expect(logsPathOf('abc', { tail: 999999 })).toContain('tail=5000');
    expect(logsPathOf('abc', { tail: -1 })).toContain('tail=500');
    expect(logsPathOf('abc', { tail: Number.NaN })).toContain('tail=500');
  });
});

describe('DockerLogsService.snapshot', () => {
  it('非 TTY：解帧后返回行与流类型', async () => {
    daemon.body = Buffer.concat([frame('out line\n'), frame('err line\n', 2)]);
    /** 快照 */
    const snapshot = await serviceOf().snapshot(1, 'abc', { tail: 10 });
    expect(snapshot.tty).toBe(false);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.lines).toEqual([
      { ts: '', stream: 'stdout', text: 'out line' },
      { ts: '', stream: 'stderr', text: 'err line' },
    ]);
  });

  it('TTY：不解帧，按裸文本切行', async () => {
    daemon.tty = true;
    daemon.body = Buffer.from('a\nb\n');
    /** 快照 */
    const snapshot = await serviceOf().snapshot(1, 'abc', { tail: 10 });
    expect(snapshot.tty).toBe(true);
    expect(snapshot.lines.map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('时间戳按请求解析（缺省开）', async () => {
    daemon.body = frame('2026-11-04T01:12:01.338912Z hello\n');
    /** 快照 */
    const snapshot = await serviceOf().snapshot(1, 'abc', { tail: 10 });
    expect(snapshot.lines[0]).toEqual({
      ts: '2026-11-04T01:12:01.338912Z',
      stream: 'stdout',
      text: 'hello',
    });
  });

  it('行数超过 tail 时只留最新的，并标记 truncated', async () => {
    // 注：故意让 daemon 不遵守 tail（真实场景是 tail 与 since 组合时的边界）
    daemon.body = Buffer.concat([frame('1\n'), frame('2\n'), frame('3\n')]);
    /** 快照 */
    const snapshot = await serviceOf().snapshot(1, 'abc', { tail: 2 });
    expect(snapshot.lines.map((line) => line.text)).toEqual(['2', '3']);
    expect(snapshot.truncated).toBe(true);
  });

  it('TTY 探测结果被缓存，连续取日志只 inspect 一次', async () => {
    /** 被测服务 */
    const service = serviceOf();
    await service.snapshot(1, 'abc', { tail: 10 });
    await service.snapshot(1, 'abc', { tail: 10 });
    expect(inspectCount).toBe(1);
  });

  it('容器不存在时把 404 原样透出', async () => {
    daemon.exists = false;
    /** 抛出的异常 */
    const err = await serviceOf()
      .snapshot(1, 'abc', { tail: 10 })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(404);
    expect((err as HttpException).message).toBe('No such container: abc');
  });

  it('API 版本前缀会拼进两个请求（inspect 与 logs）', async () => {
    await serviceOf().snapshot(1, 'abc', { tail: 10 });
    expect(paths.every((path) => path.startsWith('/v1.47/'))).toBe(true);
  });

  it('快照请求不带 follow（带上会一直读不到结尾，界面停在「正在加载日志…」）', async () => {
    await serviceOf().snapshot(1, 'abc', { tail: 10 });
    expect(paths.some((path) => path.includes('/logs?'))).toBe(true);
    expect(paths.some((path) => path.includes('follow=1'))).toBe(false);
  });
});

describe('DockerLogsService.open', () => {
  it('显式跟随时才带 follow=1，且 tail=0', async () => {
    /** 日志流 */
    const stream = await serviceOf().open(1, 'abc', {}, true);
    expect(stream.tty).toBe(false);
    expect(paths.some((path) => path.includes('follow=1') && path.includes('tail=0'))).toBe(
      true,
    );
    // 注：必须主动释放，否则假 daemon 的连接会挂到静默超时
    stream.handle.abort();
  });

  it('缺省是快照口径（不带 follow），否则快照永远读不到结尾', async () => {
    /** 日志流 */
    const stream = await serviceOf().open(1, 'abc', { tail: 10 });
    expect(paths.some((path) => path.includes('follow=1'))).toBe(false);
    expect(paths.some((path) => path.includes('tail=10'))).toBe(true);
    stream.handle.abort();
  });
});
