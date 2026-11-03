// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  KubernetesObjectActionDto,
  KubernetesObjectIndexDto,
  KubernetesObjectShowDto,
} from './object.dto.js';

/**
 * 校验入参
 *
 * @param cls DTO 类型
 * @param value 原始入参
 * @returns 出错的字段名清单
 */
async function fieldsOf(
  cls: new () => object,
  value: Record<string, unknown>,
): Promise<string[]> {
  /** DTO 实例 */
  const dto = plainToInstance(cls, value);
  /** 校验结果 */
  const errors = await validate(dto, { whitelist: true });
  return errors.map((error) => error.property);
}

/** 合法的清单入参 */
const INDEX = { kubernetesId: 1, type: 'pods' };

describe('kubernetes object.dto', () => {
  describe('KubernetesObjectIndexDto', () => {
    it('类型必须是六种资源之一（路径模板按它选，不能由前端随意指定）', async () => {
      expect(await fieldsOf(KubernetesObjectIndexDto, INDEX)).toEqual([]);
      for (const type of [
        'namespaces',
        'nodes',
        'deployments',
        'statefulsets',
        'services',
      ]) {
        expect(
          await fieldsOf(KubernetesObjectIndexDto, { ...INDEX, type }),
        ).toEqual([]);
      }
      expect(
        await fieldsOf(KubernetesObjectIndexDto, { ...INDEX, type: 'secrets' }),
      ).toContain('type');
    });

    it('集群ID必须是正整数', async () => {
      expect(
        await fieldsOf(KubernetesObjectIndexDto, { ...INDEX, kubernetesId: 0 }),
      ).toContain('kubernetesId');
      expect(
        await fieldsOf(KubernetesObjectIndexDto, {
          ...INDEX,
          kubernetesId: 1.5,
        }),
      ).toContain('kubernetesId');
    });

    it('命名空间可省略（全部命名空间），也可给空串', async () => {
      expect(
        await fieldsOf(KubernetesObjectIndexDto, { ...INDEX, namespace: '' }),
      ).toEqual([]);
      expect(
        await fieldsOf(KubernetesObjectIndexDto, {
          ...INDEX,
          namespace: 'kube-system',
        }),
      ).toEqual([]);
      for (const namespace of ['Default', 'a_b', '-x']) {
        expect(
          await fieldsOf(KubernetesObjectIndexDto, { ...INDEX, namespace }),
        ).toContain('namespace');
      }
    });
  });

  describe('KubernetesObjectShowDto', () => {
    it('资源名允许小写字母、数字、连字符与点（节点名常带域名后缀）', async () => {
      for (const id of ['web-0', 'node1.example.lan', 'a']) {
        expect(
          await fieldsOf(KubernetesObjectShowDto, { ...INDEX, id }),
        ).toEqual([]);
      }
    });

    it('资源名不许带斜杠（挡住了跨命名空间与路径改写）', async () => {
      for (const id of ['default/web', '..', '.hidden', '-x', 'Web']) {
        expect(
          await fieldsOf(KubernetesObjectShowDto, { ...INDEX, id }),
        ).toContain('id');
      }
    });
  });

  describe('KubernetesObjectActionDto', () => {
    it('动作必须在白名单内', async () => {
      for (const action of ['remove', 'scale', 'restart']) {
        expect(
          await fieldsOf(KubernetesObjectActionDto, {
            ...INDEX,
            id: 'web-0',
            action,
          }),
        ).toEqual([]);
      }
      expect(
        await fieldsOf(KubernetesObjectActionDto, {
          ...INDEX,
          id: 'web-0',
          action: 'exec',
        }),
      ).toContain('action');
    });

    it('副本数限定在 0~1000', async () => {
      for (const replicas of [-1, 1001, 1.5]) {
        expect(
          await fieldsOf(KubernetesObjectActionDto, {
            ...INDEX,
            id: 'web',
            action: 'scale',
            replicas,
          }),
        ).toContain('replicas');
      }
      expect(
        await fieldsOf(KubernetesObjectActionDto, {
          ...INDEX,
          id: 'web',
          action: 'scale',
          replicas: 0,
        }),
      ).toEqual([]);
    });

    it('优雅退出秒数限定在 0~600', async () => {
      for (const gracePeriod of [-1, 601]) {
        expect(
          await fieldsOf(KubernetesObjectActionDto, {
            ...INDEX,
            id: 'web',
            action: 'remove',
            gracePeriod,
          }),
        ).toContain('gracePeriod');
      }
      expect(
        await fieldsOf(KubernetesObjectActionDto, {
          ...INDEX,
          id: 'web',
          action: 'remove',
          gracePeriod: 0,
        }),
      ).toEqual([]);
    });
  });
});
