// 外部依赖
import type { LogLevel } from '@nestjs/common';

/** 全部日志级别 */
const ALL_LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

/** 默认日志级别
 *
 * 只保留异常（error）与告警（warn）：请求级追踪、连接池心跳这类 info/debug 输出
 * 在容器里会把真正的故障埋掉（实测一个页面请求就要刷 10 行 DEBUG）。
 */
export const DEFAULT_LOG_LEVELS: readonly LogLevel[] = ['error', 'warn'];

/**
 * 解析日志级别
 *
 * 取值来源为环境变量 `LOG_LEVEL`，逗号分隔（如 `error,warn`）；
 * 传 `all` 放行全部级别，供本地排查使用；无法识别的级别直接忽略，解析为空时回落到默认值。
 *
 * @param raw 原始配置值
 * @returns 生效的日志级别
 */
export function resolveLogLevels(
  raw: string | undefined = process.env.LOG_LEVEL,
): LogLevel[] {
  /** 规范化后的原始值 */
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) {
    return [...DEFAULT_LOG_LEVELS];
  }
  if (value === 'all') {
    return [...ALL_LOG_LEVELS];
  }
  /** 合法级别 */
  const levels = value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is LogLevel =>
      (ALL_LOG_LEVELS as readonly string[]).includes(item),
    );
  return levels.length ? levels : [...DEFAULT_LOG_LEVELS];
}
