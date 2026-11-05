// 外部依赖
import { connect } from 'node:net';
// 内部依赖
import type {
  RemoteDiskMount,
  RemoteGateway,
  RemoteLinkState,
  RemoteNetworkInterface,
  RemoteSummary,
} from './remote.types.js';

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
  /** 磁盘挂载点（`df` 的全部行） */
  disk: '@@DISK@@',
  /** 挂载点 → 文件系统类型（取自 `/proc/mounts`） */
  fstype: '@@FSTYPE@@',
  /** 链路信息（`ip -o link show`：状态 / MAC / MTU） */
  link: '@@LINK@@',
  /** 接口地址（`ip -o addr show`） */
  addr: '@@ADDR@@',
  /** 接口流量（`/proc/net/dev`，任何 Linux 都有） */
  netdev: '@@NETDEV@@',
  /** 默认路由（`ip route show default`） */
  route: '@@ROUTE@@',
  /** 默认路由兜底（`/proc/net/route`，精简系统里没有 `ip` 命令） */
  netroute: '@@NETROUTE@@',
  /** DNS（`/etc/resolv.conf`） */
  resolv: '@@RESOLV@@',
  /** 上游 DNS（`/run/systemd/resolve/resolv.conf`，systemd-resolved 环境下才是真地址） */
  resolvUpstream: '@@RESOLVUP@@',
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
 * 注 3：磁盘段给的是**不带路径的 `df -kP`**（列出全部挂载点），而 `-P` 保证一行一个文件系统；
 * 类型不靠 `df -T`（BusyBox 的 `df` 不支持），改从 `/proc/mounts` 另取一段，
 * 过滤伪文件系统放在 JS 里做 —— 命令里用 `-x` 同样不是 BusyBox 能吃的选项
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
  'df -kP 2>/dev/null',
  `echo '${SUMMARY_MARKERS.fstype}'`,
  'cat /proc/mounts 2>/dev/null',
  `echo '${SUMMARY_MARKERS.link}'`,
  'ip -o link show 2>/dev/null',
  `echo '${SUMMARY_MARKERS.addr}'`,
  'ip -o addr show 2>/dev/null',
  // 注：`/proc/net/dev` 给流量，且在没有 `ip` 命令的精简镜像里是唯一能拿到接口名的来源
  `echo '${SUMMARY_MARKERS.netdev}'`,
  'cat /proc/net/dev 2>/dev/null',
  `echo '${SUMMARY_MARKERS.route}'`,
  'ip route show default 2>/dev/null',
  `echo '${SUMMARY_MARKERS.netroute}'`,
  'cat /proc/net/route 2>/dev/null',
  `echo '${SUMMARY_MARKERS.resolv}'`,
  'cat /etc/resolv.conf 2>/dev/null',
  // 注：systemd-resolved 下 `/etc/resolv.conf` 只有 `nameserver 127.0.0.53`（本地存根），
  // 真正的上游 DNS 在这个文件里；读不到时为空，解析侧会自动退回上面那段
  `echo '${SUMMARY_MARKERS.resolvUpstream}'`,
  'cat /run/systemd/resolve/resolv.conf 2>/dev/null',
  `echo '${SUMMARY_MARKERS.who}'`,
  'whoami 2>/dev/null',
  `echo '${SUMMARY_MARKERS.end}'`,
].join('; ');

/**
 * 伪文件系统类型
 *
 * 注：这些挂载点在 `df` 里同样占一行，但对「还剩多少空间」没有意义 ——
 * tmpfs 的大小是内存的一半、squashfs（snap）恒为 100% 已用，列出来只会淹没真正的数据盘。
 * 根挂载点 `/` 一律保留，不参与此过滤（容器里 `/` 恰好是 overlay）
 */
export const PSEUDO_FS_TYPES = [
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'overlay',
  'ramfs',
  'proc',
  'sysfs',
  'devpts',
  'mqueue',
  'hugetlbfs',
  'securityfs',
  'debugfs',
  'tracefs',
  'pstore',
  'bpf',
  'autofs',
  'configfs',
  'fusectl',
  'nsfs',
  'efivarfs',
  'rpc_pipefs',
  'selinuxfs',
  'cgroup',
  'cgroup2',
] as const;

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
    const marker = (
      Object.entries(SUMMARY_MARKERS) as Array<
        [keyof typeof SUMMARY_MARKERS, string]
      >
    ).find(([, value]) => value === text.trim());
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
  return Math.round(
    numberOrZero(line.replace(`${key}:`, '').replace('kB', '')) * 1024,
  );
}

/**
 * `df -P` 的单行
 *
 * 注 1：`-P` 保证一行一个文件系统（设备名过长也不折行），故无需处理续行
 * 注 2：**挂载点可能含空格**，所以只从行首固定切 5 段，剩下的整段都归挂载点；
 * 末尾用 `.+` 而不是 `\S+` 才不会把 ` /mnt/my disk` 截成 `/mnt/my`
 */
const DF_LINE = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/;

/**
 * 还原 `/proc/mounts` 里的路径转义
 *
 * 注：该文件用八进制转义表示空格、制表、换行与反斜杠（如 `\040`），
 * 不还原就无法与 `df` 的挂载点对上，类型查不到会退化成空串
 *
 * @param value 原始字段
 * @returns 还原后的路径
 */
function decodeMountPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_all: string, code: string) =>
    String.fromCharCode(Number.parseInt(code, 8)),
  );
}

/**
 * 挂载点 → 文件系统类型
 *
 * @param lines `/proc/mounts` 的行
 * @returns 挂载点 → 类型，注：同一挂载点被多次挂载时以最后一次为准（与内核行为一致）
 */
export function mountTypesOf(lines: readonly string[]): Map<string, string> {
  /** 挂载点 → 类型 */
  const types = new Map<string, string>();
  for (const line of lines) {
    /** 字段，注：`设备 挂载点 类型 选项 dump pass` */
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) {
      continue;
    }
    types.set(decodeMountPath(fields[1] ?? ''), fields[2] ?? '');
  }
  return types;
}

/**
 * 解析磁盘挂载点
 *
 * 注 1：伪文件系统（tmpfs / squashfs / overlay …）按类型剔除 —— 它们对「还剩多少空间」没有意义，
 * 但 `/` 一律保留：容器里 `/` 本身就是 overlay，滤掉会让整张卡片空白
 * 注 2：类型查不到时（`/proc/mounts` 读不到）**不剔除**，宁可多显示几行也不漏掉真实数据盘
 *
 * @param lines `df -kP` 的行
 * @param types 挂载点 → 类型
 * @returns 挂载点清单，注：`/` 在首位，其余按挂载点升序
 */
export function diskMountsOf(
  lines: readonly string[],
  types: Map<string, string>,
): RemoteDiskMount[] {
  /** 挂载点清单 */
  const mounts: RemoteDiskMount[] = [];
  for (const line of lines) {
    /** 匹配结果 */
    const parsed = DF_LINE.exec(line.trim());
    if (parsed === null) {
      continue;
    }
    /** 挂载点 */
    const mountPoint = (parsed[6] ?? '').trim();
    /** 文件系统类型 */
    const type = types.get(mountPoint) ?? '';
    if (
      mountPoint !== '/' &&
      (PSEUDO_FS_TYPES as readonly string[]).includes(type.toLowerCase())
    ) {
      continue;
    }
    mounts.push({
      filesystem: parsed[1] ?? '',
      mountPoint,
      type,
      // 注：`df -kP` 的单位是 1K 块
      total: Math.round(numberOrZero(parsed[2] ?? '') * 1024),
      used: Math.round(numberOrZero(parsed[3] ?? '') * 1024),
      available: Math.round(numberOrZero(parsed[4] ?? '') * 1024),
      percent: Math.min(100, Math.round(numberOrZero(parsed[5] ?? ''))),
    });
  }
  return mounts.sort((left, right) => {
    if (left.mountPoint === right.mountPoint) {
      return 0;
    }
    if (left.mountPoint === '/') {
      return -1;
    }
    if (right.mountPoint === '/') {
      return 1;
    }
    return left.mountPoint.localeCompare(right.mountPoint);
  });
}

/**
 * 不列进概览的接口
 *
 * 注 1：`lo` 是回环，收发量与本机对外网络无关
 * 注 2：`veth*` 是容器网络的宿主机侧端点，一台跑着若干容器的 Docker 宿主机能列出几十个，
 * 而真正的信息在 `docker0` / `br-*` 网桥上 —— 全列出来会把有用的那两行淹掉
 */
const HIDDEN_INTERFACE = /^(?:lo|veth.*)$/;

/** `ip -o link show` 的一行，注：`vethxxx@if2` 的对端后缀要先剥掉再取接口名 */
const LINK_LINE = /^\d+:\s+([^:@\s]+?)(?:@\S+)?:\s+<([^>]*)>(.*)$/;

/** `ip -o addr show` 的一行，注：与上面同理，接口名可能带 `@ifN` */
const ADDR_LINE = /^\d+:\s+([^:@\s]+?)(?:@\S+)?\s+(inet6?)\s+(\S+)/;

/** 链路信息 */
interface LinkInfo {
  /** 状态 */
  state: RemoteLinkState;
  /** MAC 地址 */
  mac: string;
  /** 最大传输单元 */
  mtu: number;
}

/**
 * 解析 `ip -o link show`
 *
 * 注：`<...,UP,...>` 里的 `UP` 只代表「管理上已启用」，网线没插或 `docker0` 上没有容器时
 * 它同样是 UP（`NO-CARRIER`），真正该看的是 `state UP|DOWN`。故先取 `state`，
 * 只有精简系统的 `ip` 不给该字段时才退回 flags
 *
 * @param lines `ip -o link show` 的行
 * @returns 接口名 → 链路信息
 */
function linksOf(lines: readonly string[]): Map<string, LinkInfo> {
  /** 接口名 → 链路信息 */
  const links = new Map<string, LinkInfo>();
  for (const line of lines) {
    /** 匹配结果 */
    const parsed = LINK_LINE.exec(line.trim());
    if (parsed === null || (parsed[1] ?? '') === '') {
      continue;
    }
    /** 标志位 */
    const flags = (parsed[2] ?? '').split(',');
    /** 冒号之后的部分（mtu / state / link/ether 都在这里） */
    const rest = parsed[3] ?? '';
    /** `state` 字段，注：`UNKNOWN`（lo / tun）不算停用，交给 flags 判断 */
    const state = /state\s+(UP|DOWN)\b/.exec(rest)?.[1];
    /** 是否启用 */
    const enabled = state === undefined ? flags.includes('UP') : state === 'UP';
    links.set(parsed[1] ?? '', {
      state: enabled ? 'up' : 'down',
      // 注：`link/none`（tun / wireguard）没有 MAC，取不到就是空串
      mac: /\blink\/(?:ether|loopback)\s+(\S+)/.exec(rest)?.[1] ?? '',
      mtu: Math.round(numberOrZero(/\bmtu\s+(\d+)/.exec(rest)?.[1] ?? '')),
    });
  }
  return links;
}

/**
 * 解析 `ip -o addr show`
 *
 * @param lines `ip -o addr show` 的行
 * @returns 接口名 → 地址清单（保留原始顺序）
 */
function addressesOf(lines: readonly string[]): Map<string, string[]> {
  /** 接口名 → 地址 */
  const result = new Map<string, string[]>();
  for (const line of lines) {
    /** 匹配结果，注：第 2 组是 `inet` / `inet6`，第 3 组是带前缀的地址 */
    const parsed = ADDR_LINE.exec(line.trim());
    const name = parsed?.[1] ?? '';
    const address = (parsed?.[3] ?? '').trim();
    if (name === '' || address === '') {
      continue;
    }
    /** 该接口已有的地址 */
    const existing = result.get(name) ?? [];
    existing.push(address);
    result.set(name, existing);
  }
  return result;
}

/**
 * 解析 `/proc/net/dev` 的流量计数
 *
 * 注：格式为 `接口名: 收包 8 项 发包 8 项`，冒号前一律是接口名（`br-xxx` 这类长名字后面不带空格），
 * 故按**第一个冒号**切；两条表头里没有冒号，自然被跳过
 *
 * @param lines `/proc/net/dev` 的行
 * @returns 接口名 → 收发字节
 */
function trafficOf(
  lines: readonly string[],
): Map<string, { rx: number; tx: number }> {
  /** 接口名 → 收发字节 */
  const result = new Map<string, { rx: number; tx: number }>();
  for (const line of lines) {
    /** 冒号位置 */
    const index = line.indexOf(':');
    if (index < 0) {
      continue;
    }
    /** 接口名 */
    const name = line.slice(0, index).trim();
    /** 计数项 */
    const fields = line
      .slice(index + 1)
      .trim()
      .split(/\s+/);
    if (name === '' || fields.length < 9) {
      continue;
    }
    result.set(name, {
      // 注：接收的第 1 项、发送的第 1 项（发送段起点固定在下标 8）
      rx: Math.round(numberOrZero(fields[0] ?? '')),
      tx: Math.round(numberOrZero(fields[8] ?? '')),
    });
  }
  return result;
}

/**
 * 合并三份来源得到接口清单
 *
 * 注 1：三份来源各有对方没有的接口 —— 只有 `/proc/net/dev` 有流量的（veth）、
 * 只有 `ip addr` 有地址而没有 MAC 的，所以取并集
 * 注 2：链路信息缺失时状态给 `unknown`，不猜成 UP / DOWN
 * 注 3：地址排序为「IPv4 在前、IPv6 在后」，组内保留系统给的顺序
 *
 * @param linkLines `ip -o link show` 的行
 * @param addrLines `ip -o addr show` 的行
 * @param netdevLines `/proc/net/dev` 的行
 * @returns 接口清单，按接口名升序
 */
export function interfacesOf(
  linkLines: readonly string[],
  addrLines: readonly string[],
  netdevLines: readonly string[],
): RemoteNetworkInterface[] {
  /** 接口名 → 汇总 */
  const merged = new Map<string, RemoteNetworkInterface>();

  /**
   * 取或建
   *
   * @param name 接口名
   * @returns 汇总项，被过滤掉的接口给 null
   */
  const ensure = (name: string): RemoteNetworkInterface | null => {
    if (name === '' || HIDDEN_INTERFACE.test(name)) {
      return null;
    }
    /** 已有项 */
    const existing = merged.get(name);
    if (existing !== undefined) {
      return existing;
    }
    /** 新建项 */
    const created: RemoteNetworkInterface = {
      name,
      state: 'unknown',
      mac: '',
      mtu: 0,
      addresses: [],
      rxBytes: 0,
      txBytes: 0,
    };
    merged.set(name, created);
    return created;
  };

  for (const [name, link] of linksOf(linkLines)) {
    /** 汇总项 */
    const item = ensure(name);
    if (item === null) {
      continue;
    }
    item.state = link.state;
    item.mac = link.mac;
    item.mtu = link.mtu;
  }
  for (const [name, addresses] of addressesOf(addrLines)) {
    /** 汇总项 */
    const item = ensure(name);
    if (item === null) {
      continue;
    }
    item.addresses = addresses;
  }
  for (const [name, traffic] of trafficOf(netdevLines)) {
    /** 汇总项 */
    const item = ensure(name);
    if (item === null) {
      continue;
    }
    item.rxBytes = traffic.rx;
    item.txBytes = traffic.tx;
  }
  for (const item of merged.values()) {
    // 注：`Array.prototype.sort` 是稳定排序，同族地址之间的顺序不变
    item.addresses.sort(
      (left, right) => Number(left.includes(':')) - Number(right.includes(':')),
    );
  }
  return [...merged.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * `/proc/net/route` 的小端十六进制 IPv4 → 点分十进制
 *
 * 注：该文件把 32 位地址按**主机字节序**写成十六进制，`0101A8C0` 是 `192.168.1.1`
 * 而不是 `1.1.168.192`，故要按字节倒序拆
 *
 * @param hex 8 位十六进制串
 * @returns 点分十进制地址，格式不认识时为空串
 */
function ipv4OfHex(hex: string): string {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
    return '';
  }
  /** 32 位整数 */
  const value = Number.parseInt(hex, 16);
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ].join('.');
}

/**
 * 解析默认网关
 *
 * 注 1：`ip route show default` 是首选（同时给出网关与出口接口）
 * 注 2：`ip` 命令不存在时（BusyBox 精简镜像）退回 `/proc/net/route` —— 该文件里
 * `Destination` 为全零的行就是默认路由
 * 注 3：同一网关经多条路径出现（多网卡双默认路由）时全部保留，去重按「地址 + 接口」
 *
 * @param routeLines `ip route show default` 的行
 * @param netRouteLines `/proc/net/route` 的行
 * @returns 默认网关清单，取不到时为空数组
 */
export function gatewaysOf(
  routeLines: readonly string[],
  netRouteLines: readonly string[],
): RemoteGateway[] {
  /** 网关清单 */
  const gateways: RemoteGateway[] = [];
  /** 已收录的键 */
  const seen = new Set<string>();

  /**
   * 追加一条（去重）
   *
   * @param via 网关地址
   * @param device 出口接口
   */
  const push = (via: string, device: string): void => {
    /** 去重键 */
    const key = `${via}|${device}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    gateways.push({ via, device });
  };

  for (const line of routeLines) {
    /** 去掉行尾空白 */
    const text = line.trim();
    if (!/^default\b/.test(text)) {
      continue;
    }
    push(
      /\bvia\s+(\S+)/.exec(text)?.[1] ?? '',
      /\bdev\s+(\S+)/.exec(text)?.[1] ?? '',
    );
  }
  if (gateways.length > 0) {
    return gateways;
  }
  for (const line of netRouteLines) {
    /** 字段：接口 目标 网关 标志 … */
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[1] !== '00000000') {
      continue;
    }
    push(ipv4OfHex(fields[2] ?? ''), fields[0] ?? '');
  }
  return gateways;
}

/**
 * 解析 DNS 服务器
 *
 * 注：只认 `nameserver` 行；`#` / `;` 注释与 `options` / `search` 一律跳过（resolv.conf 头部
 * 有十几行说明文字，不滤掉会把整张卡片塞满注释）
 *
 * @param lines resolv.conf 的行
 * @returns 地址清单（去重、保留原顺序）
 */
export function dnsServersOf(lines: readonly string[]): string[] {
  /** 地址清单 */
  const servers: string[] = [];
  for (const line of lines) {
    /** 去掉行尾注释后的正文 */
    const text = line.trim();
    if (text === '' || text.startsWith('#') || text.startsWith(';')) {
      continue;
    }
    /** 匹配到的地址 */
    const address = /^nameserver\s+(\S+)/.exec(text)?.[1] ?? '';
    if (address !== '' && !servers.includes(address)) {
      servers.push(address);
    }
  }
  return servers;
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
  /** 上游 DNS，注：systemd-resolved 环境下 `/etc/resolv.conf` 只有本地存根 `127.0.0.53` */
  const upstreamDns = dnsServersOf(sections.get('resolvUpstream') ?? []);
  return {
    osName: (osLine ?? '').replace(/^PRETTY_NAME=/, '').replace(/^"|"$/g, ''),
    // 注：`Linux 5.15.0-91-generic` 取第二段；取不到就原样返回
    kernel: uname[1] ?? '',
    arch: firstOf(sections, 'arch'),
    uptime: Math.floor(
      numberOrZero((sections.get('uptime')?.[0] ?? '').split(/\s+/)[0] ?? ''),
    ),
    cpus: Math.round(numberOrZero(firstOf(sections, 'cpu'))),
    load1: numberOrZero(load[0] ?? ''),
    load5: numberOrZero(load[1] ?? ''),
    load15: numberOrZero(load[2] ?? ''),
    memoryTotal: meminfoOf(mem, 'MemTotal'),
    memoryAvailable: available,
    // 注：磁盘给全量挂载点，解析与伪文件系统过滤都在 `diskMountsOf` 里
    disks: diskMountsOf(
      sections.get('disk') ?? [],
      mountTypesOf(sections.get('fstype') ?? []),
    ),
    interfaces: interfacesOf(
      sections.get('link') ?? [],
      sections.get('addr') ?? [],
      sections.get('netdev') ?? [],
    ),
    gateways: gatewaysOf(
      sections.get('route') ?? [],
      sections.get('netroute') ?? [],
    ),
    // 注：上游文件读到内容就用它，否则退回 `/etc/resolv.conf`
    dnsServers:
      upstreamDns.length > 0
        ? upstreamDns
        : dnsServersOf(sections.get('resolv') ?? []),
    user: firstOf(sections, 'who'),
  };
}
