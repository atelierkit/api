// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
// 内部依赖
import {
  RemoteSshService,
  SSH_READY_TIMEOUT,
  httpErrorOf,
  remoteErrorOf,
} from './remote.ssh.js';
import type { SshChannelLike, SshClientLike, SshConfig } from './remote.ssh.js';
import { RemoteError } from './remote.types.js';

/** 终端通道替身 */
class FakeChannel extends EventEmitter {
  /** 标准错误流，注：命令的报错信息在这里 */
  readonly stderr = new EventEmitter();
  /** 写入记录 */
  readonly written: Buffer[] = [];
  /** 是否已 end */
  ended = false;
  /** 写入 */
  write(data: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }
  /** 关闭 */
  end(): void {
    this.ended = true;
  }
  /** 调整窗口 */
  setWindow(): void {
    // 注：服务层不关心尺寸细节，只要调用不抛错
  }
  /** 暂停 */
  pause(): void {
    // 同上
  }
  /** 恢复 */
  resume(): void {
    // 同上
  }
}

/**
 * SSH 客户端替身
 *
 * 注：`connect()` 之后由用例决定发 `ready` 还是 `error` —— 真实 ssh2 也是这个形状
 */
class FakeClient extends EventEmitter {
  /** 收到的连接参数 */
  config: SshConfig | null = null;
  /** 通道 */
  readonly channel = new FakeChannel();
  /** 是否已 end */
  ended = false;
  /** 是否已 destroy */
  destroyed = false;
  /** exec 的行为 */
  execBehavior: ((channel: FakeChannel) => void) | null = null;
  /** shell 的行为 */
  shellError: Error | null = null;

  /** 连接 */
  connect(config: SshConfig): void {
    this.config = config;
  }
  /** 关闭 */
  end(): void {
    this.ended = true;
  }
  /** 销毁 */
  destroy(): void {
    this.destroyed = true;
  }
  /** 执行命令 */
  exec(
    _command: string,
    callback: (err: Error | undefined, channel: SshChannelLike) => void,
  ): void {
    if (this.execBehavior === null) {
      callback(undefined, this.channel as unknown as SshChannelLike);
      return;
    }
    this.execBehavior(this.channel);
    callback(undefined, this.channel as unknown as SshChannelLike);
  }
  /** 申请 shell */
  shell(
    _options: { term: string; cols: number; rows: number },
    callback: (err: Error | undefined, channel: SshChannelLike) => void,
  ): void {
    if (this.shellError !== null) {
      callback(this.shellError, undefined as unknown as SshChannelLike);
      return;
    }
    callback(undefined, this.channel as unknown as SshChannelLike);
  }
}

/**
 * 组装被测服务
 *
 * @returns 被测服务与客户端替身
 */
function serviceOf() {
  /** 客户端 */
  const client = new FakeClient();
  return {
    service: new RemoteSshService(() => client as unknown as SshClientLike),
    client,
  };
}

/** 最小连接参数 */
function configOf(): SshConfig {
  return {
    host: '192.0.2.10',
    port: 22,
    username: 'atelier',
    password: 'p@ssw0rd',
    hostVerifier: () => true,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('remoteErrorOf', () => {
  it('主机身份校验失败 → HOST_KEY_CHANGED（且提示怎么补救）', () => {
    /** 错误 */
    const error = remoteErrorOf(new Error('Host denied (verification failed)'));
    expect(error.code).toBe('HOST_KEY_CHANGED');
    expect(error.message).toContain('重新信任');
  });

  it('认证失败 → AUTH_FAILED', () => {
    expect(
      remoteErrorOf(new Error('All configured authentication methods failed')).code,
    ).toBe('AUTH_FAILED');
  });

  it('网络不可达 → HOST_UNREACHABLE（各种底层措辞都要归进来）', () => {
    for (const message of [
      'connect ECONNREFUSED 192.0.2.10:22',
      'getaddrinfo ENOTFOUND bad-host',
      'Timed out while waiting for handshake',
    ]) {
      expect(remoteErrorOf(new Error(message)).code).toBe('HOST_UNREACHABLE');
    }
  });

  it('通道被拒 → CHANNEL_CLOSED', () => {
    expect(remoteErrorOf(new Error('Channel open failure')).code).toBe(
      'CHANNEL_CLOSED',
    );
  });

  it('未归类 → UNKNOWN，但保留原文（不吞线索）', () => {
    /** 错误 */
    const error = remoteErrorOf(new Error('something odd'));
    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toContain('something odd');
  });
});

describe('httpErrorOf', () => {
  it('HTTP 异常原样透传（状态码不被改写）', () => {
    /** 原异常 */
    const origin = new HttpException('不存在', HttpStatus.NOT_FOUND);
    expect(httpErrorOf(origin)).toBe(origin);
  });

  it('不可达给 502，配置类错误给 422（502 会被前端当成「服务端挂了」）', () => {
    expect(
      httpErrorOf(new RemoteError('HOST_UNREACHABLE', '连不上')).getStatus(),
    ).toBe(HttpStatus.BAD_GATEWAY);
    expect(httpErrorOf(new RemoteError('AUTH_FAILED', '密码错')).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('普通异常兜底成 502', () => {
    expect(httpErrorOf(new Error('boom')).getStatus()).toBe(
      HttpStatus.BAD_GATEWAY,
    );
  });
});

describe('RemoteSshService.open', () => {
  it('ready 后 resolve，并把参数交给 ssh2（含 keyboard-interactive 开关）', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    /** 连接中 */
    const pending = service.open(configOf());
    client.emit('ready');
    await expect(pending).resolves.toBe(client);
    expect(client.config).toMatchObject({
      host: '192.0.2.10',
      port: 22,
      username: 'atelier',
      password: 'p@ssw0rd',
      tryKeyboard: true,
    });
  });

  it('keyboard-interactive：用密码应答每一问（部分发行版只给这种认证）', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    /** 连接中 */
    const pending = service.open(configOf());
    /** 应答 */
    const answers: string[] = [];
    client.emit(
      'keyboard-interactive',
      '',
      '',
      '',
      [{ prompt: 'Password: ' }],
      (values: string[]) => answers.push(...values),
    );
    expect(answers).toEqual(['p@ssw0rd']);
    client.emit('ready');
    await pending;
  });

  it('握手失败按错误码拒绝，并销毁连接（不留半开连接）', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    /** 连接中 */
    const pending = service.open(configOf());
    client.emit('error', new Error('All configured authentication methods failed'));
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(client.destroyed).toBe(true);
  });

  it('超时按不可达拒绝（ssh2 自己的 readyTimeout 管不到「认证卡住」）', async () => {
    vi.useFakeTimers();
    /** 被测服务 */
    const { service } = serviceOf();
    /** 连接中 */
    const pending = service.open(configOf());
    /** 断言 */
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
    });
    vi.advanceTimersByTime(SSH_READY_TIMEOUT + 1);
    await assertion;
  });
});

describe('RemoteSshService.exec', () => {
  it('合并 stdout 与 stderr，等通道 close 后一次性返回', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    /** 执行中 */
    const pending = service.exec(client as unknown as SshClientLike, 'uname -a');
    client.channel.emit('data', Buffer.from('Linux atelier\n'));
    client.channel.stderr.emit('data', Buffer.from('warning\n'));
    client.channel.emit('close');
    await expect(pending).resolves.toBe('Linux atelier\nwarning\n');
  });

  it('通道打开失败时按错误码拒绝', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    // 注：让 exec 直接失败 —— 真实场景是服务端拒绝开通道
    (client as unknown as { exec: unknown }).exec = (
      _command: string,
      callback: (err: Error) => void,
    ) => callback(new Error('Channel open failure'));
    await expect(
      service.exec(client as unknown as SshClientLike, 'ls'),
    ).rejects.toMatchObject({ code: 'CHANNEL_CLOSED' });
  });

  it('超时拒绝（避免命令挂死后请求一直悬着）', async () => {
    vi.useFakeTimers();
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    /** 执行中，注：通道永远不 close */
    const pending = service.exec(client as unknown as SshClientLike, 'sleep 999', 100);
    /** 断言 */
    const assertion = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('命令执行超时'),
    });
    vi.advanceTimersByTime(101);
    await assertion;
  });
});

describe('RemoteSshService.shell 与 close', () => {
  it('申请到 shell 后返回通道', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    await expect(
      service.shell(client as unknown as SshClientLike, 120, 40),
    ).resolves.toBe(client.channel);
  });

  it('通道申请失败时按错误码拒绝', async () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    client.shellError = new Error('Channel open failure');
    await expect(
      service.shell(client as unknown as SshClientLike, 80, 24),
    ).rejects.toMatchObject({ code: 'CHANNEL_CLOSED' });
  });

  it('关闭时先 end 通道再 end 连接（否则目标机 who 里会留残留会话）', () => {
    /** 被测服务与替身 */
    const { service, client } = serviceOf();
    service.close(
      client as unknown as SshClientLike,
      client.channel as unknown as SshChannelLike,
    );
    expect(client.channel.ended).toBe(true);
    expect(client.ended).toBe(true);
  });

  it('通道已失效时 end 抛错也不影响收尾', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    /** 会抛错的通道 */
    const channel = {
      end: () => {
        throw new Error('channel already closed');
      },
    } as unknown as SshChannelLike;
    expect(() => service.close(null, channel)).not.toThrow();
  });

  it('连接为空时安全（诊断早期失败会走到这里）', () => {
    /** 被测服务 */
    const { service } = serviceOf();
    expect(() => service.close(null, null)).not.toThrow();
  });
});
