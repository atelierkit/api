// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { DEFAULT_LOG_LEVELS, resolveLogLevels } from './log.options.js';

describe('日志级别配置', () => {
  it('默认输出异常、告警与常规信息（启动/路由日志可见），关闭 debug', () => {
    expect(resolveLogLevels(undefined)).toEqual(['error', 'warn', 'log']);
    expect(DEFAULT_LOG_LEVELS).toEqual(['error', 'warn', 'log']);
    expect(DEFAULT_LOG_LEVELS).not.toContain('debug');
    expect(DEFAULT_LOG_LEVELS).not.toContain('verbose');
  });

  it('空串与纯空白回落到默认值', () => {
    expect(resolveLogLevels('')).toEqual(['error', 'warn', 'log']);
    expect(resolveLogLevels('   ')).toEqual(['error', 'warn', 'log']);
  });

  it('按逗号解析，容忍大小写与空格', () => {
    expect(resolveLogLevels('ERROR, warn')).toEqual(['error', 'warn']);
    expect(resolveLogLevels(' log ')).toEqual(['log']);
  });

  it('all 放行全部级别（本地排查用）', () => {
    expect(resolveLogLevels('all')).toEqual([
      'fatal',
      'error',
      'warn',
      'log',
      'debug',
      'verbose',
    ]);
  });

  it('无法识别的级别被忽略，全都不识别时回落默认值', () => {
    expect(resolveLogLevels('debug,trace')).toEqual(['debug']);
    expect(resolveLogLevels('trace')).toEqual(['error', 'warn', 'log']);
  });
});
