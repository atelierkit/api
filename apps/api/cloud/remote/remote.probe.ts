// 外部依赖
import { connect } from 'node:net';
// 内部依赖
import type { RemoteSummary } from './remote.types.js';

/** TCP 探测超时（毫秒），注：比握手超时短 —— 端口都不通时没必要等到握手阶段 */
export const PROBE_TIMEOUT = 5000;

/** 诊断用的环境探测命令 */
export const UNAME_COMMAND = 'uname -a';

/**
 * 概览各段的起始标记
 *
 * 注：用固定标记把一条复合命令的输出切成若干段，避免为每个字段单发一次 exec
 * （每次 exec 都是一次往返，家用链路下 8 次往返能到 1 秒以上）
 */
export const SUMMARY_MARKERS = {
  /** 发行版 */
  os: '@@OS@@',
  /** 内核 */
  uname: '@@UNAME@@',
  /** 架构 */
  arch: '@@ARCH@@',
  /** 运行时长 */
  uptime: '@@UPTIME@@',
  /** CPU 核数 */
  cpu: '@@CPU@@',
  /** 平均负载 */
  load: '@@LOAD@@',
  /** 内存 */
  mem: '@@MEM@@',
  /** 磁盘 */
  disk: '@@DISK@@',
  /** 当前用户 */
  who: '@@WHO@@',
  /** 结束标记，注：有它才能判断「输出被截断」而不是「最后一段本来就为空」 */
  end: '@@END@@',
} as const;

/**
 * 概览命令
 *
 * 注 1：全部读 `/proc` 与标准命令，不依赖 `lsb_release`（精简镜像里常常没有）
 * 注 2：每段都带 `2>/dev/null`，某段不存在时只会得到空输出，不会污染其余段
 */
export const SUMMARY_COMMAND = [
  `echo '${SUMMARY_MARKERS.os}'`,
  'cat /etc/os-release 2>/dev/null',
  `echo '${SUMMARY_MARKERS.uname}'`,
  'uname -sr 2>/dev/null',
  `echo '${SUMMARY_MARKERS.arch}'`,
  'uname -m 2>/dev/null',
  `echo '${SUMMARY_MARKERS.uptime}'`,
  'cat /proc/uptime 2>/dev/null',
  `echo '${SUMMARY_MARKERS.cpu}'`,
  'nproc 2>/dev/null',
  `echo '${SUMMARY_MARKERS.load}'`,
  'cat /proc/loadavg 2>/dev/null',
  `echo '${SUMMARY_MARKERS.mem}'`,
  'head -5 /proc/meminfo 2>/dev/null',
  `echo '${SUMMARY_MARKERS.disk}'`,
  'df -kP / 2>/dev/null | tail -1',
  `echo '${SUMMARY_MARKERS.who}'`,
  'whoami 2>/dev/null',
  `echo '${SUMMARY_MARKERS.end}'`,
].join('; ');

/** TCP 探测结果 */
export interface TcpProbeResult {
  /** 端口是否可达 */
  reachable: boolean;
  /** 建连耗时（毫秒） */
  latencyMs: number;
  /** 失败原因，可达时为空串 */
  error: string;
}

/**
 * 探测目标端口是否可连
 *
 * 注：失败**不抛异常** —— 诊断要把「哪一步不通」展示给用户，抛出去就只剩一句 500
 *
 * @param host 主机名或 IP
 * @param port 端口
 * @param timeout 超时（毫秒）
 * @returns 探测结果
 */
export function tcpProbe(
  host: string,
  port: number,
  timeout: number = PROBE_TIMEOUT,
): Promise<TcpProbeResult> {
  return new Promise<TcpProbeResult>((resolve) => {
    /** 起始时刻 */
    const started = Date.now();
    /** 是否已结算，注：destroy 之后仍可能收到 error 事件 */
    let settled = false;
    /** 连接对象 */
    const socket = connect({ host, port });

    /**
     * 收尾
     *
     * @param result 探测结果
     */
    const finish = (result: TcpProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () =>
      finish({ reachable: true, latencyMs: Date.now() - started, error: '' }),
    );
    socket.once('timeout', () =>
      finish({
        reachable: false,
        latencyMs: Date.now() - started,
        error: `连接超时（${timeout} 毫秒），端口可能被防火墙拦掉！`,
      }),
    );
    socket.once('error', (err: Error) =>
      finish({
        reachable: false,
        latencyMs: Date.now() - started,
        error: err.message,
      }),
    );
  });
}

/**
 * 按标记切分输出
 *
 * @param raw 命令输出
 * @returns 段名 → 该段的行
 */
export function sectionsOf(raw: string): Map<string, string[]> {
  /** 段名 → 行 */
  const sections = new Map<string, string[]>();
  /** 当前段名，注：首个标记之前的内容（如登录 banner）全部丢弃 */
  let current = '';
  for (const line of (raw ?? '').split('\n')) {
    /** 去掉行尾的 `\r`（部分系统的 `df` 会带），再比对标记 */
    const text = line.replace(/\r$/, '').trimEnd();
    /** 标记对应的段名 */
    const marker = (Object.entries(SUMMARY_MARKERS) as Array<
      [keyof typeof SUMMARY_MARKERS, string]
    >).find(([, value]) => value === text.trim());
    if (marker !== undefined) {
      current = marker[0];
      sections.set(current, []);
      continue;
    }
    // 注：尾部空行（输出以 `\n` 结尾时必然产生）不进段 —— 否则 `firstOf` 会取到空串，
    // 且各段的数组长度会多出一个无意义的空元素
    if (text === '') {
      continue;
    }
    if (current !== '') {
      sections.get(current)?.push(text);
    }
  }
  return sections;
}

/**
 * 取某段的首行
 *
 * @param sections 分段结果
 * @param name 段名
 * @returns 去空白后的首行，缺失时为空串
 */
function firstOf(sections: Map<string, string[]>, name: string): string {
  return (sections.get(name)?.[0] ?? '').trim();
}

/**
 * 取数值
 *
 * @param text 文本
 * @returns 数值，解析不出来时为 0
 */
function numberOrZero(text: string): number {
  /** 数值 */
  const value = Number.parseFloat((text ?? '').trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * 解析 `/proc/meminfo` 的某个字段
 *
 * @param lines meminfo 的行
 * @param key 字段名，如 `MemTotal`
 * @returns 字节数，缺失时为 0
 */
function meminfoOf(lines: readonly string[], key: string): number {
  /** 匹配行 */
  const line = lines.find((item) => item.startsWith(`${key}:`));
  if (line === undefined) {
    return 0;
  }
  // 注：meminfo 的单位是 kB，换算成字节
  return Math.round(numberOrZero(line.replace(`${key}:`, '').replace('kB', '')) * 1024);
}

/**
 * 解析概览输出
 *
 * 注：逐段容错 —— 某段为空或格式不认识时只让对应字段为 0，不抛异常。
 * 概览是辅助信息，不该因为「读不到磁盘」把整页打成错误（诊断才是判定连通性的地方）
 *
 * @param raw 复合命令的输出
 * @returns 概览
 */
export function parseLinuxSummary(raw: string): RemoteSummary {
  /** 分段结果 */
  const sections = sectionsOf(raw);
  /** `uname -sr` 的输出，注：形如 `Linux 5.15.0-91-generic` */
  const uname = firstOf(sections, 'uname').split(/\s+/);
  /** `df` 的列，注：`Filesystem 1024-blocks Used Available Capacity Mounted` */
  const disk = (firstOf(sections, 'disk') ?? '').split(/\s+/);
  /** 负载字段 */
  const load = firstOf(sections, 'load').split(/\s+/);
  /** meminfo */
  const mem = sections.get('mem') ?? [];
  /** 可用内存，注：老内核没有 `MemAvailable`，退回 `MemFree` */
  const available = meminfoOf(mem, 'MemAvailable') || meminfoOf(mem, 'MemFree');
  /** 发行版名称 */
  const osLine = (sections.get('os') ?? []).find((line) =>
    line.startsWith('PRETTY_NAME='),
  );
  return {
    osName: (osLine ?? '').replace(/^PRETTY_NAME=/, '').replace(/^"|"$/g, ''),
    // 注：`Linux 5.15.0-91-generic` 取第二段；取不到就原样返回
    kernel: uname[1] ?? '',
    arch: firstOf(sections, 'arch'),
    uptime: Math.floor(numberOrZero((sections.get('uptime')?.[0] ?? '').split(/\s+/)[0] ?? '')),
    cpus: Math.round(numberOrZero(firstOf(sections, 'cpu'))),
    load1: numberOrZero(load[0] ?? ''),
    load5: numberOrZero(load[1] ?? ''),
    load15: numberOrZero(load[2] ?? ''),
    memoryTotal: meminfoOf(mem, 'MemTotal'),
    memoryAvailable: available,
    // 注：`df -kP` 的单位是 1K 块
    diskTotal: Math.round(numberOrZero(disk[1] ?? '') * 1024),
    diskUsed: Math.round(numberOrZero(disk[2] ?? '') * 1024),
    diskPercent: Math.round(numberOrZero(disk[4] ?? '')),
    user: firstOf(sections, 'who'),
  };
}
