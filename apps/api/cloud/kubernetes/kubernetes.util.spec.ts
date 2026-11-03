// 外部依赖
import { describe, expect, it } from 'vitest';
// 内部依赖
import type { KubernetesRawNode } from './kubernetes.types.js';
import {
  nodeAddressOf,
  nodeReadyOf,
  nodeRolesOf,
  nodeStatusOf,
  quantityOf,
} from './kubernetes.util.js';

/**
 * 造一个节点对象
 *
 * @param extra 覆盖项
 * @returns 节点对象
 */
function nodeOf(extra: Partial<KubernetesRawNode> = {}): KubernetesRawNode {
  return {
    metadata: {
      name: 'node-1',
      labels: { 'kubernetes.io/hostname': 'node-1' },
    },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
    ...extra,
  };
}

describe('quantityOf', () => {
  it('纯数字按原值返回（CPU 核数、Pod 数都是这种）', () => {
    expect(quantityOf('8')).toBe(8);
    expect(quantityOf('110')).toBe(110);
  });

  it('m 是千分之一（CPU 的 500m = 0.5 核）', () => {
    expect(quantityOf('500m')).toBe(0.5);
    expect(quantityOf('2500m')).toBe(2.5);
  });

  it('二进制单位按 1024 进（内存的 16Gi）', () => {
    expect(quantityOf('1Ki')).toBe(1024);
    expect(quantityOf('2Mi')).toBe(2 * 1024 ** 2);
    expect(quantityOf('16Gi')).toBe(16 * 1024 ** 3);
    expect(quantityOf('1Ti')).toBe(1024 ** 4);
  });

  it('十进制单位按 1000 进（与二进制单位不能混用）', () => {
    expect(quantityOf('1k')).toBe(1000);
    expect(quantityOf('1M')).toBe(1e6);
    expect(quantityOf('1G')).toBe(1e9);
  });

  it('小数与空白都容忍', () => {
    expect(quantityOf(' 1.5Gi ')).toBe(1.5 * 1024 ** 3);
  });

  it('空值、非法值、不认识的单位给 0（界面显示 0 比 NaN 好）', () => {
    expect(quantityOf('')).toBe(0);
    expect(quantityOf('abc')).toBe(0);
    expect(quantityOf('12Xi')).toBe(12);
  });
});

describe('nodeReadyOf / nodeStatusOf', () => {
  it('Ready 条件为 True 才算就绪', () => {
    expect(nodeReadyOf(nodeOf())).toBe(true);
    expect(
      nodeReadyOf(nodeOf({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })),
    ).toBe(false);
    expect(nodeReadyOf(nodeOf({ status: {} }))).toBe(false);
  });

  it('状态文案与 kubectl 的 STATUS 列一致', () => {
    expect(nodeStatusOf(nodeOf())).toBe('Ready');
    expect(
      nodeStatusOf(nodeOf({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })),
    ).toBe('NotReady');
    expect(nodeStatusOf(nodeOf({ status: { conditions: [] } }))).toBe('Unknown');
  });

  it('被 cordon 的节点显示 SchedulingDisabled（即使它是 Ready）', () => {
    expect(nodeStatusOf(nodeOf({ spec: { unschedulable: true } }))).toBe(
      'SchedulingDisabled',
    );
  });
});

describe('nodeRolesOf', () => {
  it('从 node-role.kubernetes.io/ 标签取角色并排序', () => {
    expect(
      nodeRolesOf(
        nodeOf({
          metadata: {
            labels: {
              'node-role.kubernetes.io/master': '',
              'node-role.kubernetes.io/control-plane': '',
              'kubernetes.io/hostname': 'node-1',
            },
          },
        }),
      ),
    ).toBe('control-plane,master');
  });

  it('没有角色标签时给空串（不要编造 worker）', () => {
    expect(nodeRolesOf(nodeOf())).toBe('');
    expect(nodeRolesOf(nodeOf({ metadata: {} }))).toBe('');
  });
});

describe('nodeAddressOf', () => {
  it('优先 InternalIP，退而取 Hostname', () => {
    expect(
      nodeAddressOf(
        nodeOf({
          status: {
            addresses: [
              { type: 'Hostname', address: 'node-1' },
              { type: 'InternalIP', address: '192.168.1.3' },
            ],
          },
        }),
      ),
    ).toBe('192.168.1.3');
    expect(
      nodeAddressOf(
        nodeOf({ status: { addresses: [{ type: 'Hostname', address: 'node-1' }] } }),
      ),
    ).toBe('node-1');
    expect(nodeAddressOf(nodeOf({ status: {} }))).toBe('');
  });
});
