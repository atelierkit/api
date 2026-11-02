// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import { DEVICE_UNKNOWN, normalizeDevice, sameDevice } from './token.util.js';

describe('normalizeDevice', () => {
  it('采用客户端上报的合法标识', () => {
    expect(normalizeDevice('a1b2c3d4e5f6g7h8')).toBe('a1b2c3d4e5f6g7h8');
    // 允许下划线与连字符，长度边界 8 与 64
    expect(normalizeDevice('ab_cd-12')).toBe('ab_cd-12');
    expect(normalizeDevice('x'.repeat(64))).toBe('x'.repeat(64));
    // 前后空白先去掉，避免同一设备因空白差异拆成两个分组
    expect(normalizeDevice('  a1b2c3d4  ')).toBe('a1b2c3d4');
  });

  it('缺失或非法时归入统一分组', () => {
    // 未上报：与改造前的单会话语义一致，重复登录仍只保留一个令牌
    expect(normalizeDevice()).toBe(DEVICE_UNKNOWN);
    expect(normalizeDevice('')).toBe(DEVICE_UNKNOWN);
    // 过短、超长、含分隔符与空白的值一律丢弃，不能靠乱填刷出无限个设备分组
    expect(normalizeDevice('short')).toBe(DEVICE_UNKNOWN);
    expect(normalizeDevice('x'.repeat(65))).toBe(DEVICE_UNKNOWN);
    expect(normalizeDevice('a:b:c:d:e:f')).toBe(DEVICE_UNKNOWN);
    expect(normalizeDevice('bad device id')).toBe(DEVICE_UNKNOWN);
    expect(normalizeDevice('中文设备标识')).toBe(DEVICE_UNKNOWN);
  });

  it('统一分组本身是合法标识，归一化幂等', () => {
    expect(normalizeDevice(DEVICE_UNKNOWN)).toBe(DEVICE_UNKNOWN);
  });
});

describe('sameDevice', () => {
  it('设备标识一致时视为同一设备', () => {
    expect(sameDevice('dev12345', 'dev12345')).toBe(true);
  });

  it('不同设备互不影响', () => {
    expect(sameDevice('dev12345', 'dev67890')).toBe(false);
  });

  it('没有设备字段的旧令牌视为可清理', () => {
    // 改造前的令牌不带 device 字段，无法归属到具体设备
    expect(sameDevice(undefined, 'dev12345')).toBe(true);
    expect(sameDevice('', 'dev12345')).toBe(true);
  });
});
