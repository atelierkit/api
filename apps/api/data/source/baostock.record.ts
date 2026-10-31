// 内部依赖

/** 「列名 → 值」记录映射结果 */
export type BaostockRecord = ReadonlyMap<string, string>;

/**
 * 记录解析 —— 把响应体里的 JSON 拆成「值数组」列表，再与列名合并
 *
 * baostock 的所有值都是字符串，且「空值」用空串表示而不是 JSON null。
 * 解析失败一律当作「无记录」而不是抛异常 —— 数据源偶发返回空串或截断的 JSON，为此让整次同步
 * 失败（已拉到的几万行全部作废）不划算；空结果会让上层按「本页无数据」正常收尾。
 */
export const RecordParser = {
  /** 记录数组在 JSON 里的属性名 */
  RECORD_PROPERTY: 'record',

  /**
   * 解析响应体 JSON 中的记录数组
   *
   * @returns 每行的值数组；无记录或解析失败时返回空列表
   */
  parseRows(json: string): string[][] {
    if (!json.trim()) {
      return [];
    }
    try {
      const document = JSON.parse(json) as unknown;
      if (typeof document !== 'object' || document === null) {
        return [];
      }
      const record = (document as Record<string, unknown>)[
        RecordParser.RECORD_PROPERTY
      ];
      if (!Array.isArray(record)) {
        return [];
      }
      const rows: string[][] = [];
      for (const row of record) {
        if (!Array.isArray(row)) {
          continue;
        }
        rows.push(
          row.map((cell) => {
            if (typeof cell === 'string') {
              return cell;
            }
            if (cell === null || cell === undefined) {
              return '';
            }
            return String(cell);
          }),
        );
      }
      return rows;
    } catch {
      return [];
    }
  },

  /**
   * 解析列名列表（形如 `date,code,open,...`）
   *
   * 首尾空白一并去掉 —— 数据源偶尔会在逗号后多一个空格。
   */
  parseFieldNames(field: string): string[] {
    if (!field.trim()) {
      return [];
    }
    return field
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  },

  /**
   * 把「值数组」与「列名数组」拼成记录列表
   *
   * 行比列名长时多余的值被忽略，短时缺失的列取空串 —— 与参照实现的 `values[i] ?? ''` 语义一致，
   * 不因个别行的长度异常而中断整页。
   */
  zip(rows: readonly string[][], fieldNames: readonly string[]): BaostockRecord[] {
    if (rows.length === 0 || fieldNames.length === 0) {
      return [];
    }
    return rows.map((values) => {
      const map = new Map<string, string>();
      fieldNames.forEach((field, index) => {
        map.set(field, index < values.length ? values[index] : '');
      });
      return map;
    });
  },
};
