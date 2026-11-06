// 外部依赖
import { promises as resolver } from 'node:dns';
// 内部依赖
import type { SslDnsRecord } from './ssl.format.js';
import { dnsStatusOf, domainLevelsOf } from './ssl.format.js';

/** 单次 DNS 查询的超时（毫秒），注：`node:dns` 没有原生超时，靠 `Promise.race` 兜 */
export const DNS_TIMEOUT = 5000;

/** DNS 探测结果 */
export interface SslDnsProbe {
  /** DNS 侧状态 */
  status: 'pending' | 'matched' | 'mismatched' | 'unknown';
  /** DNS 中已存在的同类记录 */
  existing: string[];
  /** 域名当前生效的 NS */
  ns: string[];
}

/**
 * 给 Promise 加超时
 *
 * @param task 待执行的查询
 * @param fallback 超时后的返回值
 * @returns 查询结果或兜底值
 */
async function withTimeout<T>(task: Promise<T>, fallback: T): Promise<T> {
  /** 超时计时器 */
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), DNS_TIMEOUT);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 查询域名当前生效的 NS
 *
 * 注：逐级上推取第一个有结果的层级 —— 直接截「最后两段」在 `.com.cn` / `.co.uk` 上会取错
 *
 * @param domain 起始域名
 * @returns NS 列表，查不到时为空数组
 */
export async function nsOf(domain: string): Promise<string[]> {
  for (const level of domainLevelsOf(domain)) {
    /** 该层级的 NS */
    const ns = await withTimeout(
      resolver.resolveNs(level).catch(() => [] as string[]),
      [] as string[],
    );
    if (ns.length > 0) {
      return ns.map((item) => item.replace(/\.$/, '').toLowerCase());
    }
  }
  return [];
}

/**
 * 判断解析失败是否属于「记录不存在」
 *
 * 注：`ENODATA`（域名在但没有该类型记录）与 `ENOTFOUND`（域名不存在）都应当算「还没加记录」，
 * 报成 `unknown` 会让用户以为探测坏了；只有超时 / 上游不可达才是真的查不到
 *
 * @param err 解析错误
 * @returns 是否属于记录不存在
 */
function isMissingRecord(err: unknown): boolean {
  /** 错误码 */
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENODATA' || code === 'ENOTFOUND';
}

/**
 * 探测 DNS 验证记录是否已生效
 *
 * 注 1：**本地解析结果只能作为参考**。实测出现过「本地连续 5 次查不到、阿里云已判定验证通过并签发」的情况，
 * 因此 `pending` 不等同于验证失败，界面文案必须留出传播中的余地
 * 注 2：TXT 的解析结果是 `string[][]`（一条记录可能被拆成多段），需 `flat()` 后逐条去引号再比
 *
 * @param record 阿里云要求的验证记录
 * @param domain 申请域名，注：用于查 NS；缺省时从记录名上推
 * @returns 探测结果
 */
export async function probeDns(
  record: SslDnsRecord,
  domain?: string,
): Promise<SslDnsProbe> {
  /** 是否查询失败（超时 / 上游不可达） */
  let failed = false;
  /** 查询到的同类记录值 */
  let existing: string[] = [];

  if (record.type === 'TXT') {
    /** TXT 解析结果 */
    const txt = await withTimeout(
      resolver.resolveTxt(record.domain).catch((err: unknown) => {
        if (!isMissingRecord(err)) {
          failed = true;
        }
        return [] as string[][];
      }),
      null,
    );
    if (txt === null) {
      failed = true;
    } else {
      existing = txt.map((chunks) => chunks.join('').replace(/^"|"$/g, '').trim());
    }
  } else {
    /** CNAME 解析结果 */
    const cname = await withTimeout(
      resolver.resolveCname(record.domain).catch((err: unknown) => {
        if (!isMissingRecord(err)) {
          failed = true;
        }
        return [] as string[];
      }),
      null,
    );
    if (cname === null) {
      failed = true;
    } else {
      existing = cname.map((item) => item.replace(/\.$/, '').trim());
    }
  }

  /** 域名 NS */
  const ns = await nsOf(domain ?? record.domain);

  if (failed && existing.length === 0) {
    return { status: 'unknown', existing, ns };
  }
  return { status: dnsStatusOf(record.value, existing), existing, ns };
}
