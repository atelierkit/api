/**
 * 批量写入的分块工具（PostgreSQL 单条语句的参数个数上限）
 *
 * ⚠ 为什么必须有它（2026-11-03 生产事故）：
 *   PostgreSQL 的 Bind 消息里「参数个数」是 Int16，硬上限 65535；`pg` 驱动的
 *   `addInt16` 对超出的值**静默截断**（只取低 16 位），于是：
 *   - 客户端实际写了 N 个参数（N > 65535），服务端只按 `N mod 65536` 个读格式码；
 *   - 剩下的格式码（text 格式，全 0）被当成「参数个数」读出来 ⇒ 报
 *     `bind message has 33 parameter formats but 0 parameters`。
 *   这条错误文本与真实原因（参数太多）完全对不上，排查成本极高。
 *
 *   现场数据：`bars` 每行 17 个绑定参数，2020-06-05 全市场 3857 只 ⇒ 65569 个参数，
 *   65569 − 65536 = 33，正好是报错里的 33；前一天 3855 行 = 65535 个参数恰好在线上，
 *   所以历史数据全都写进去了、只有这一天开始必然失败。
 */

/** PostgreSQL 协议的硬上限（Bind 里参数个数是 Int16） */
const BIND_PARAM_LIMIT = 65_535;

/**
 * 单条语句默认的参数预算
 *
 * 刻意不贴着 65535：留出余量给「同一语句里还有其它占位符」或「将来给表加列」，
 * 多几次往返的代价远低于一次线上失败。
 */
export const MAX_BIND_PARAMS = 30_000;

/**
 * 按「单条语句最多承载多少个绑定参数」把行切块
 *
 * @param rows 待写入的行（保持原顺序）
 * @param paramsPerRow 单行占用的参数个数（取该表的列数即最保守的上界）
 * @param maxParams 单条语句的参数预算，超过协议上限时按协议上限收敛
 * @returns 分块结果；空输入返回空数组（**不是** `[[]]`，否则会发一条空 VALUES）
 */
export function chunkRows<T>(
  rows: readonly T[],
  paramsPerRow: number,
  maxParams: number = MAX_BIND_PARAMS,
): T[][] {
  if (!Number.isInteger(paramsPerRow) || paramsPerRow < 1) {
    // 传 0 / 负数会让下面的除法得到 Infinity，最终一次性拼出一条必然溢出的语句
    throw new RangeError(`paramsPerRow 必须是正整数，收到 ${paramsPerRow}`);
  }

  const budget = Number.isFinite(maxParams) ? Math.floor(maxParams) : MAX_BIND_PARAMS;
  const perChunk = Math.max(1, Math.floor(Math.min(budget, BIND_PARAM_LIMIT) / paramsPerRow));

  if (rows.length === 0) {
    return [];
  }
  if (rows.length <= perChunk) {
    return [rows.slice()];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += perChunk) {
    chunks.push(rows.slice(index, index + perChunk));
  }
  return chunks;
}

/**
 * 单行最多占用多少个绑定参数
 *
 * 取实体元数据的列数：TypeORM 会把「走默认值」的列写成 `DEFAULT`（不占参数），
 * 按列数算只会偏大 ⇒ 分块偏保守，永远不会突破协议上限。反过来按「实际有值的列数」
 * 算，一旦将来补上某个字段就会重新踩线。
 *
 * @param metadata 实体元数据（单测替身没有，缺省时用 fallback）
 * @param fallback 元数据缺失时的保守列数
 */
export function paramsPerRowOf(
  metadata: { columns: unknown[] } | undefined,
  fallback: number,
): number {
  const count = metadata?.columns.length;
  return typeof count === 'number' && count > 0 ? count : fallback;
}
