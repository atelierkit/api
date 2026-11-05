// 外部依赖
import { getMetadataArgsStorage } from 'typeorm';

/**
 * 取实体上真实存在的字段路径
 *
 * 注 1：TypeORM 的 `select` 只认属性名，写成实体上没有的属性要到执行查询时才抛
 * `EntityPropertyNotFoundError` —— 而 `find()` 的替身根本不会核对它，单测照样绿，
 * 于是「替身吞掉了生产的错」，故这里按实体元数据造一份白名单给用例断言
 * 注 2：嵌入列（`create` / `update` / `log`）在 `select` 里要展开成嵌套对象，
 * 故子字段拼成 `update.userId` 这种路径
 *
 * @param entity 实体类
 * @returns 字段路径集合
 */
export function selectPathsOf(entity: Function): Set<string> {
  /** 字段路径 */
  const paths = new Set<string>();
  /** 元数据里登记的普通列与嵌入列 */
  const { columns, embeddeds } = getMetadataArgsStorage();

  /**
   * 递归收集某个类上登记的列
   *
   * @param target 当前类
   * @param prefix 路径前缀，注：顶层为空串，嵌入列的子字段带 `字段名.`
   */
  const walk = (target: Function, prefix: string): void => {
    for (const column of columns) {
      if (column.target === target) {
        paths.add(`${prefix}${column.propertyName}`);
      }
    }
    // 注：`@Column(() => XxxEntity)` 在元数据里登记的是 embedded，不占 columns
    for (const embedded of embeddeds) {
      if (embedded.target === target) {
        walk(
          (embedded.type as () => Function)(),
          `${prefix}${embedded.propertyName}.`,
        );
      }
    }
  };

  // 注：继承来的列登记的 `target` 是基类（如 `DockerBaseEntity`），故沿原型链逐个收集
  for (
    let current: unknown = entity;
    typeof current === 'function' && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    walk(current as Function, '');
  }
  return paths;
}

/**
 * 把 `select` 选项摊平成路径数组
 *
 * 注：只把 `true` 与嵌套对象算作「被选中」，`false` / `undefined` 与 TypeORM 一样忽略
 *
 * @param select `select` 选项
 * @param prefix 路径前缀，注：递归用
 * @returns 字段路径数组，如 `['id', 'update.userId']`
 */
export function selectPathsIn(select: unknown, prefix: string = ''): string[] {
  if (select === null || typeof select !== 'object') {
    return [];
  }
  /** 字段路径数组 */
  const paths: string[] = [];
  for (const [key, value] of Object.entries(
    select as Record<string, unknown>,
  )) {
    /** 字段路径 */
    const path = `${prefix}${key}`;
    if (value === true) {
      paths.push(path);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      paths.push(...selectPathsIn(value, `${path}.`));
    }
  }
  return paths;
}

/**
 * 取 `select` 里在实体上不存在的字段路径
 *
 * 注：返回非空即说明该查询一定会抛 `EntityPropertyNotFoundError`（主表与日志表字段不同名时最常见）
 *
 * @param select `select` 选项
 * @param entity 实体类
 * @returns 实体上不存在的字段路径
 */
export function missingSelectPathsOf(
  select: unknown,
  entity: Function,
): string[] {
  /** 实体上的字段路径 */
  const allowed = selectPathsOf(entity);
  return selectPathsIn(select).filter((path) => !allowed.has(path));
}
