// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { chunkRows, MAX_BIND_PARAMS, paramsPerRowOf } from './write-chunk.js';

/** 造 n 行占位数据（内容不重要，只看块边界） */
function rowsOf(n: number): { index: number }[] {
  return Array.from({ length: n }, (_, index) => ({ index }));
}

describe('chunkRows', () => {
  it('空输入返回空数组，而不是一个空块', () => {
    // 返回 [[]] 会生成一条没有 VALUES 的 INSERT
    expect(chunkRows([], 18)).toEqual([]);
  });

  it('不超预算时原样返回一块（顺序与内容都不变）', () => {
    const rows = rowsOf(3);
    const chunks = chunkRows(rows, 18);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(rows);
    // 是新数组，不与入参共享引用（下游 upsert 可能改动行对象）
    expect(chunks[0]).not.toBe(rows);
  });

  it('按「预算 ÷ 每行参数」切块，每块都不超过预算', () => {
    const paramsPerRow = 18;
    const perChunk = Math.floor(MAX_BIND_PARAMS / paramsPerRow); // 1666
    const rows = rowsOf(perChunk * 2 + 2); // 最后一块只有 2 行

    const chunks = chunkRows(rows, paramsPerRow);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([perChunk, perChunk, 2]);
    for (const chunk of chunks) {
      expect(chunk.length * paramsPerRow).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    }
    // 行不丢、顺序不乱
    expect(chunks.flat().map((r) => r.index)).toEqual(rows.map((r) => r.index));
  });

  it('恰好整除时不产生空块', () => {
    const perChunk = Math.floor(MAX_BIND_PARAMS / 18);
    const chunks = chunkRows(rowsOf(perChunk * 2), 18);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length === perChunk)).toBe(true);
  });

  it('预算超过协议上限时按 65535 收敛（贴线会直接触发 bind 截断）', () => {
    // 传 1_000_000 也不能真的发一条百万参数的语句
    const chunks = chunkRows(rowsOf(10_000), 18, 1_000_000);

    for (const chunk of chunks) {
      expect(chunk.length * 18).toBeLessThanOrEqual(65_535);
    }
    // floor(65535 / 18) = 3640 行/块
    expect(chunks[0].length).toBe(3640);
  });

  it('预算小于单行参数时退化为「每块一行」，不会切出空块或死循环', () => {
    const chunks = chunkRows(rowsOf(3), 18, 5);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length === 1)).toBe(true);
  });

  it('每行参数个数非法时抛错（除零会算出 Infinity，最终拼出必然溢出的单条语句）', () => {
    expect(() => chunkRows(rowsOf(1), 0)).toThrow(RangeError);
    expect(() => chunkRows(rowsOf(1), -18)).toThrow(RangeError);
    // 非整数同样拦下：列数只能是整数
    expect(() => chunkRows(rowsOf(1), 1.5)).toThrow(RangeError);
  });

  it('真实规模回归：一天全市场 5000 行必须被切开', () => {
    // 2020-06-05 现场：3857 行 × 17 = 65569 个参数 > 65535，线上报
    // 「bind message has 33 parameter formats but 0 parameters」
    const chunks = chunkRows(rowsOf(3857), 18);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(3857);
  });
});

describe('paramsPerRowOf', () => {
  it('优先用实体元数据的列数', () => {
    expect(paramsPerRowOf({ columns: Array.from({ length: 18 }) }, 3)).toBe(18);
  });

  it('元数据缺失时退回保守列数（单测替身没有 metadata）', () => {
    expect(paramsPerRowOf(undefined, 18)).toBe(18);
    expect(paramsPerRowOf({ columns: [] }, 18)).toBe(18);
  });
});
