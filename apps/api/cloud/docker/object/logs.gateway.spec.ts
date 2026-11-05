// 外部依赖
import type { Socket } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
// 内部依赖
import type { TokenService, UserService } from '@shared';
import {
  DockerLogGateway,
  LOG_FLUSH_INTERVAL,
  LOG_SESSION_LIFETIME,
} from './logs.gateway.js';
import { DockerLogParser, type DockerLogLine } from './object.logs.js';
import type { DockerLogsService, DockerLogStream } from './logs.service.js';

/** socket 替身 */
interface FakeSocket {
  /** 连接标识 */
  id: string;
  /** 会话数据 */
  data: Record<string, unknown>;
  /** 发送事件，注：用 mock 类型，避免 unbound-method 告警 */
  emit: Mock;
  /** 断开连接 */
  disconnect: Mock;
  /** 握手信息 */
  handshake: { auth: Record<string, unknown>; headers: Record<string, string> };
}

/**
 * 造一行日志
 *
 * @param text 正文
 * @returns 日志行
 */
function lineOf(text: string): DockerLogLine {
  return { ts: '', stream: 'stdout', text };
}

/**
 * 造一个永不结束的流
 *
 * @returns 日志流替身
 */
function streamOf(): DockerLogStream {
  return {
    tty: false,
    handle: {
      chunks: (async function* () {
        // 注：日志流的正常形态就是「一直不结束」，由 abort 终止
      })() as AsyncGenerator<Buffer>,
      abort: vi.fn(),
    },
    parser: new DockerLogParser(false, true),
  };
}

/**
 * 造 socket 替身
 *
 * @param id 连接标识
 * @returns socket 替身
 */
function socketOf(id = 's1'): FakeSocket {
  return {
    id,
    data: { userId: 7 },
    emit: vi.fn(),
    disconnect: vi.fn(),
    handshake: { auth: { token: 'T' }, headers: {} },
  };
}

/**
 * 把替身交给网关（网关的参数是真实 Socket 类型）
 *
 * @param socket 替身
 * @returns 断言成 Socket 的替身
 */
function asSocket(socket: FakeSocket): Socket {
  return socket as unknown as Socket;
}

/**
 * 组装被测网关
 *
 * @param batches 批次产出器，注：缺省是「一直挂住」，与真实跟随流一致
 * @returns 网关与替身
 */
function gatewayOf(
  batches: () => AsyncGenerator<DockerLogLine[]> = () =>
    (async function* () {
      // 注：真实日志流不会自己结束，只有容器停止或连接被回收才终止；
      // 若缺省就结束，会话会被立刻回收，限流用例会误判为「没有会话」
      await new Promise<void>(() => undefined);
    })(),
) {
  /** 日志流 */
  const stream = streamOf();
  /** 日志服务替身 */
  const logsSrv = {
    open: vi.fn(async (..._args: unknown[]) => stream),
    batches: vi.fn(() => batches()),
  };
  /** 令牌服务替身 */
  const tokenSrv = { show: vi.fn(async () => ({ id: '7' }) as unknown) };
  /** 用户服务替身 */
  const userSrv = {
    show: vi.fn(
      async () =>
        ({ id: 7, username: 'marbl', status: true, roles: ['admin'] }) as unknown,
    ),
  };
  return {
    gateway: new DockerLogGateway(
      logsSrv as unknown as DockerLogsService,
      tokenSrv as unknown as TokenService,
      userSrv as unknown as UserService,
    ),
    logsSrv,
    tokenSrv,
    userSrv,
    stream,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DockerLogGateway · 握手', () => {
  it('未携带令牌时 emit 错误并断开', async () => {
    /** 网关 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    socket.handshake.auth = {};
    await gateway.handleConnection(asSocket(socket));
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('令牌'),
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('非 admin 用「查看容器日志」的说法，便于用户理解是哪个功能', async () => {
    /** 网关与替身 */
    const { gateway, userSrv } = gatewayOf();
    userSrv.show.mockResolvedValue({
      id: 7,
      status: true,
      roles: ['user'],
    } as never);
    /** socket */
    const socket = socketOf();
    socket.handshake.auth = { token: 'T' };
    await gateway.handleConnection(asSocket(socket));
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('容器日志'),
    });
  });

  it('校验通过时不断开', async () => {
    /** 网关 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    await gateway.handleConnection(asSocket(socket));
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

describe('DockerLogGateway · open', () => {
  it('成功时返回 sessionId，并按「只要新行 + 带时间戳」请求', async () => {
    /** 网关与替身 */
    const { gateway, logsSrv } = gatewayOf();
    /** socket */
    const socket = socketOf();
    /** 结果 */
    const result = await gateway.open(asSocket(socket), {
      dockerId: 3,
      containerId: 'abc',
    });
    expect(result).toEqual({ sessionId: 's1' });
    expect(logsSrv.open).toHaveBeenCalledWith(
      3,
      'abc',
      {
        tail: 0,
        since: '',
        timestamps: true,
      },
      // 注：第 4 个参数是 follow —— 不传就成了快照口径，读完历史即 EOF
      true,
    );
    gateway.handleDisconnect(asSocket(socket));
  });

  it('握手鉴权尚未写完 socket.data 时，open 等它（否则刚连上就报登录状态无效）', async () => {
    /** 网关与替身 */
    const { gateway, logsSrv, tokenSrv } = gatewayOf();
    // 注：让令牌查询慢一拍，模拟真实的异步窗口（客户端连上立刻发 open）
    tokenSrv.show.mockImplementation(
      async () => (await Promise.resolve({ id: '7' })) as never,
    );
    /** socket，注：data 为空 = 握手鉴权还没跑完 */
    const socket = socketOf();
    socket.data = {};
    /** 结果 */
    const result = await gateway.open(asSocket(socket), {
      dockerId: 3,
      containerId: 'abc',
    });
    expect(result).toEqual({ sessionId: 's1' });
    expect(socket.data['userId']).toBe(7);
    expect(logsSrv.open).toHaveBeenCalledTimes(1);
    gateway.handleDisconnect(asSocket(socket));
  });

  it('握手鉴权失败时拒绝，且不打开流', async () => {
    /** 网关与替身 */
    const { gateway, logsSrv, tokenSrv } = gatewayOf();
    tokenSrv.show.mockResolvedValue(null as never);
    /** socket */
    const socket = socketOf();
    socket.data = {};
    expect(
      await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' }),
    ).toEqual({
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('登录'),
    });
    expect(logsSrv.open).not.toHaveBeenCalled();
  });

  it('同一连接重复 open 被拒', async () => {
    /** 网关 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' });
    expect(
      await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' }),
    ).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    gateway.handleDisconnect(asSocket(socket));
  });

  it('宿主机ID 与容器ID 不合法时给 BAD_REQUEST（两者都会拼进 daemon 的路径）', async () => {
    /** 网关 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    expect(
      await gateway.open(asSocket(socket), { dockerId: 0, containerId: 'abc' }),
    ).toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      await gateway.open(asSocket(socket), {
        dockerId: 1,
        containerId: '../etc/passwd',
      }),
    ).toMatchObject({ code: 'BAD_REQUEST' });
    gateway.handleDisconnect(asSocket(socket));
  });

  it('单用户并发流有上限', async () => {
    /** 网关 */
    const { gateway } = gatewayOf();
    /** 两个连接已开满 */
    const first = socketOf('s1');
    const second = socketOf('s2');
    await gateway.open(asSocket(first), { dockerId: 1, containerId: 'abc' });
    await gateway.open(asSocket(second), { dockerId: 1, containerId: 'def' });
    /** 第三个连接 */
    const third = socketOf('s3');
    expect(
      await gateway.open(asSocket(third), { dockerId: 1, containerId: 'ghi' }),
    ).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      message: expect.stringContaining('最多'),
    });
    gateway.handleDisconnect(asSocket(first));
    gateway.handleDisconnect(asSocket(second));
  });

  it('宿主机连不上时把原因带给前端（不吞成 UNKNOWN）', async () => {
    /** 网关与替身 */
    const { gateway, logsSrv } = gatewayOf();
    logsSrv.open.mockRejectedValue(
      Object.assign(new Error('宿主机请求失败：certificate'), { status: 502 }),
    );
    /** 结果 */
    const result = await gateway.open(asSocket(socketOf()), {
      dockerId: 1,
      containerId: 'abc',
    });
    expect(result.code).toBe('HOST_UNREACHABLE');
    expect(result.message).toContain('certificate');
  });

  it('容器不存在时给 BAD_REQUEST 并带 daemon 的原文', async () => {
    /** 网关与替身 */
    const { gateway, logsSrv } = gatewayOf();
    logsSrv.open.mockRejectedValue(
      Object.assign(new Error('No such container: abc'), { status: 404 }),
    );
    expect(
      await gateway.open(asSocket(socketOf()), {
        dockerId: 1,
        containerId: 'abc',
      }),
    ).toMatchObject({ code: 'BAD_REQUEST', message: 'No such container: abc' });
  });
});

describe('DockerLogGateway · 输出与回收', () => {
  it('聚合后按 output 事件推送，同一次只带一次 truncated', async () => {
    /** 网关 */
    const { gateway } = gatewayOf(() =>
      (async function* () {
        yield [lineOf('a'), lineOf('b')];
        // 注：之后挂住，模拟跟随中
        await new Promise<void>(() => undefined);
      })(),
    );
    /** socket */
    const socket = socketOf();
    await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' });
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_INTERVAL);
    expect(socket.emit).toHaveBeenCalledWith('output', {
      lines: [lineOf('a'), lineOf('b')],
      truncated: false,
    });
    gateway.handleDisconnect(asSocket(socket));
  });

  it('流自然结束（容器停止）时 flush 残留并发 ended', async () => {
    /** 网关 */
    const { gateway } = gatewayOf(() =>
      (async function* () {
        yield [lineOf('last')];
      })(),
    );
    /** socket */
    const socket = socketOf();
    await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.emit).toHaveBeenCalledWith('ended', {
      reason: 'container-stopped',
    });
    expect(socket.emit).toHaveBeenCalledWith('output', {
      lines: [lineOf('last')],
      truncated: false,
    });
  });

  it('断开连接时 abort 宿主机请求（否则 daemon 侧会留着跟随者）', async () => {
    /** 网关与替身 */
    const { gateway, stream } = gatewayOf();
    /** socket */
    const socket = socketOf();
    await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' });
    gateway.handleDisconnect(asSocket(socket));
    expect(stream.handle.abort).toHaveBeenCalled();
    // 注：回收后再 flush 不应再 emit
    socket.emit = vi.fn();
    await vi.advanceTimersByTimeAsync(LOG_FLUSH_INTERVAL * 2);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('主动 close 与重复回收都是幂等的', async () => {
    /** 网关与替身 */
    const { gateway, stream } = gatewayOf();
    /** socket */
    const socket = socketOf();
    await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' });
    gateway.close(asSocket(socket));
    gateway.close(asSocket(socket));
    expect(stream.handle.abort).toHaveBeenCalledTimes(1);
    // 回收后可以重新打开（用户关掉再开是常见操作）
    await expect(
      gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' }),
    ).resolves.toMatchObject({ sessionId: 's1' });
    gateway.handleDisconnect(asSocket(socket));
  });

  it('挂上了 4 小时上限（开着抽屉过夜不能留永久连接）', async () => {
    /** 网关 */
    const { gateway } = gatewayOf();
    /** socket */
    const socket = socketOf();
    await gateway.open(asSocket(socket), { dockerId: 1, containerId: 'abc' });
    // 注：不推进 4 小时 —— 聚合定时器每 16ms 一次，推进 4h 会跑 90 万次回调，
    // 测试会慢到不可接受；这里只钉住「确实挂了两个定时器」与常量值
    expect(LOG_SESSION_LIFETIME).toBe(4 * 60 * 60 * 1000);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    gateway.handleDisconnect(asSocket(socket));
  });
});
