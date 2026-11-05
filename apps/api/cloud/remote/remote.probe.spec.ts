// 外部依赖
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// 内部依赖
import {
  SUMMARY_COMMAND,
  SUMMARY_MARKERS,
  parseLinuxSummary,
  sectionsOf,
  tcpProbe,
} from './remote.probe.js';

/** 测试期间打开的临时服务，注：用例结束要关掉，否则 vitest 会挂着手柄不退出 */
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

/**
 * 起一个只监听不处理的临时服务
 *
 * @returns 端口
 */
async function listeningPort(): Promise<number> {
  /** 服务 */
  const server = createServer();
  servers.push(server);
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      /** 端口信息 */
      const address = server.address();
      resolve(
        typeof address === 'object' && address !== null ? address.port : 0,
      );
    });
  });
}

describe('SUMMARY_COMMAND', () => {
  it('包含全部分段标记，且以 end 收尾（缺 end 就分不清「输出截断」与「最后一段为空」）', () => {
    for (const marker of Object.values(SUMMARY_MARKERS)) {
      expect(SUMMARY_COMMAND).toContain(marker);
    }
    expect(
      SUMMARY_COMMAND.trimEnd().endsWith(`echo '${SUMMARY_MARKERS.end}'`),
    ).toBe(true);
  });

  it('who 段在 end 之前，end 只出现一次', () => {
    expect(SUMMARY_COMMAND.indexOf(SUMMARY_MARKERS.end)).toBeGreaterThan(
      SUMMARY_COMMAND.indexOf(SUMMARY_MARKERS.who),
    );
    expect(SUMMARY_COMMAND.split(SUMMARY_MARKERS.end).length - 1).toBe(1);
  });

  it('磁盘段取全部挂载点（不能带路径，带路径只会剩根分区一行）', () => {
    expect(SUMMARY_COMMAND).toContain('df -kP 2>/dev/null');
    expect(SUMMARY_COMMAND).not.toContain('df -kP /');
    expect(SUMMARY_COMMAND).toContain('cat /proc/mounts');
  });
});

describe('tcpProbe', () => {
  it('端口在监听时判定可达并给出耗时', async () => {
    /** 端口 */
    const port = await listeningPort();
    /** 探测结果 */
    const result = await tcpProbe('127.0.0.1', port);
    expect(result.reachable).toBe(true);
    expect(result.error).toBe('');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('端口未监听时判定不可达并带上原因（不抛异常）', async () => {
    /** 端口 */
    const port = await listeningPort();
    // 注：服务关掉后端口立即不可连，得到 ECONNREFUSED
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => resolve());
    });
    /** 探测结果 */
    const result = await tcpProbe('127.0.0.1', port);
    expect(result.reachable).toBe(false);
    expect(result.error).not.toBe('');
  });

  it('地址不可路由时按超时/网络错误返回不可达', async () => {
    // 注：192.0.2.0/24 是 TEST-NET-1，保留给文档示例，正常网络里没有路由
    /** 探测结果 */
    const result = await tcpProbe('192.0.2.1', 22, 300);
    expect(result.reachable).toBe(false);
    expect(result.error).not.toBe('');
  });
});

describe('sectionsOf', () => {
  it('首个标记之前的内容（登录 banner）被丢弃', () => {
    /** 分段结果 */
    const sections = sectionsOf(
      [
        'Welcome to Ubuntu',
        '@@OS@@',
        'PRETTY_NAME="Ubuntu 22.04"',
        '@@WHO@@',
        'root',
      ].join('\n'),
    );
    expect(sections.get('os')).toEqual(['PRETTY_NAME="Ubuntu 22.04"']);
    expect(sections.get('who')).toEqual(['root']);
  });

  it('行尾带 \\r 的段内容也能归位（部分系统的 df 会带）', () => {
    /** 分段结果 */
    const sections = sectionsOf('@@DISK@@\r\noverlay 1 2 3 4% /\r\n');
    expect(sections.get('disk')).toEqual(['overlay 1 2 3 4% /']);
  });
});

describe('parseLinuxSummary', () => {
  /** 一份真实的复合命令输出（Ubuntu 22.04） */
  const RAW = [
    '@@OS@@',
    'PRETTY_NAME="Ubuntu 22.04.4 LTS"',
    'NAME="Ubuntu"',
    '@@UNAME@@',
    'Linux 5.15.0-91-generic',
    '@@ARCH@@',
    'x86_64',
    '@@UPTIME@@',
    '123456.78 987654.32',
    '@@CPU@@',
    '8',
    '@@LOAD@@',
    '0.15 0.20 0.25 1/234 5678',
    '@@MEM@@',
    'MemTotal:        8123456 kB',
    'MemFree:          123456 kB',
    'MemAvailable:    6543210 kB',
    '@@DISK@@',
    'Filesystem     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda2         1024000    512000    460000      53% /',
    '/dev/sdb1        20480000   4096000  15360000      21% /data',
    'tmpfs              409600         0    409600       0% /run',
    '/dev/loop0         128000    128000         0     100% /snap/core20/1974',
    '@@FSTYPE@@',
    '/dev/sda2 / ext4 rw,relatime 0 0',
    '/dev/sdb1 /data xfs rw,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
    '/dev/loop0 /snap/core20/1974 squashfs ro,nodev 0 0',
    '@@WHO@@',
    'marbl',
    '@@END@@',
  ].join('\n');

  it('解析出全部字段', () => {
    expect(parseLinuxSummary(RAW)).toEqual({
      osName: 'Ubuntu 22.04.4 LTS',
      kernel: '5.15.0-91-generic',
      arch: 'x86_64',
      uptime: 123456,
      cpus: 8,
      load1: 0.15,
      load5: 0.2,
      load15: 0.25,
      memoryTotal: 8123456 * 1024,
      memoryAvailable: 6543210 * 1024,
      disks: [
        {
          filesystem: '/dev/sda2',
          mountPoint: '/',
          type: 'ext4',
          total: 1024000 * 1024,
          used: 512000 * 1024,
          available: 460000 * 1024,
          percent: 53,
        },
        {
          filesystem: '/dev/sdb1',
          mountPoint: '/data',
          type: 'xfs',
          total: 20480000 * 1024,
          used: 4096000 * 1024,
          available: 15360000 * 1024,
          percent: 21,
        },
      ],
      user: 'marbl',
    });
  });

  it('列出全部真实挂载点，tmpfs / squashfs 等伪文件系统被剔除', () => {
    /** 结果 */
    const result = parseLinuxSummary(RAW);
    expect(result.disks.map((item) => item.mountPoint)).toEqual(['/', '/data']);
  });

  it('根挂载点即使是 overlay 也保留（容器里 `/` 就是 overlay，滤掉会让卡片空白）', () => {
    /** 输出，注：容器内 `df` 的典型形态 */
    const raw = [
      '@@DISK@@',
      'overlay 1024000 512000 460000 53% /',
      '@@FSTYPE@@',
      'overlay / overlay rw,lowerdir=/var/lib/docker/overlay2/l/xxx 0 0',
      '@@END@@',
    ].join('\n');
    /** 结果 */
    const result = parseLinuxSummary(raw);
    expect(result.disks).toHaveLength(1);
    expect(result.disks[0]?.mountPoint).toBe('/');
    expect(result.disks[0]?.type).toBe('overlay');
  });

  it('读不到 /proc/mounts 时不按类型剔除（宁可多显示几行也不漏掉真实数据盘）', () => {
    /** 输出 */
    const raw = ['@@DISK@@', 'tmpfs 409600 0 409600 0% /run', '@@END@@'].join(
      '\n',
    );
    expect(parseLinuxSummary(raw).disks.map((item) => item.mountPoint)).toEqual(
      ['/run'],
    );
  });

  it('挂载点含空格时仍能切对，并与 /proc/mounts 的 \\040 转义对上类型', () => {
    /** 输出 */
    const raw = [
      '@@DISK@@',
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/sdc1 102400 51200 51200 50% /mnt/my disk',
      '@@FSTYPE@@',
      '/dev/sdc1 /mnt/my\\040disk ext4 rw,relatime 0 0',
      '@@END@@',
    ].join('\n');
    /** 第一个挂载点，注：`df` 的表头不是数据行，必须被丢掉 */
    const first = parseLinuxSummary(raw).disks[0];
    expect(first?.mountPoint).toBe('/mnt/my disk');
    expect(first?.type).toBe('ext4');
  });

  it('老内核没有 MemAvailable 时退回 MemFree', () => {
    /** 输出 */
    const raw = [
      '@@MEM@@',
      'MemTotal: 1000 kB',
      'MemFree: 400 kB',
      '@@END@@',
    ].join('\n');
    expect(parseLinuxSummary(raw).memoryAvailable).toBe(400 * 1024);
  });

  it('输出残缺时逐段降级，不抛异常', () => {
    /** 结果 */
    const result = parseLinuxSummary('登录 banner\n@@OS@@\n');
    expect(result.osName).toBe('');
    expect(result.kernel).toBe('');
    expect(result.cpus).toBe(0);
    expect(result.disks).toEqual([]);
  });

  it('非数字字段按 0 处理（脏输出不该让整页 500）', () => {
    /** 输出 */
    const raw = ['@@CPU@@', 'unknown', '@@UPTIME@@', 'n/a'].join('\n');
    /** 结果 */
    const result = parseLinuxSummary(raw);
    expect(result.cpus).toBe(0);
    expect(result.uptime).toBe(0);
  });
});
