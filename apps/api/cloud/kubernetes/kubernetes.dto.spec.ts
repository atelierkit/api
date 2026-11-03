// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { KubernetesCreateDto, KubernetesUpdateDto } from './kubernetes.dto.js';

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

/** 合法的建集群入参，注：token 与客户端证书二选一即可（联动校验在服务层） */
const CLUSTER = {
  name: '家用集群',
  description: '局域网内的 k3s',
  endpoint: 'https://192.168.1.3:6443',
  token: 'eyJhbGciOiJSUzI1NiJ9.token',
  verify: true,
  status: true,
};

describe('kubernetes.dto', () => {
  describe('KubernetesCreateDto', () => {
    it('五个基础字段都必填', async () => {
      expect(await fieldsOf(KubernetesCreateDto, {})).toEqual(
        expect.arrayContaining([
          'name',
          'description',
          'endpoint',
          'verify',
          'status',
        ]),
      );
    });

    it('字段齐备时通过校验', async () => {
      expect(await fieldsOf(KubernetesCreateDto, CLUSTER)).toEqual([]);
    });

    it('status / verify 为 false 时同样通过（不能被判成「空」）', async () => {
      expect(
        await fieldsOf(KubernetesCreateDto, {
          ...CLUSTER,
          verify: false,
          status: false,
        }),
      ).toEqual([]);
    });

    it('地址只认 http / https，且不许带路径或查询串', async () => {
      for (const endpoint of [
        '192.168.1.3:6443',
        'tcp://192.168.1.3:6443',
        'https://192.168.1.3:6443/api',
        'https://192.168.1.3:6443?x=1',
      ]) {
        expect(
          await fieldsOf(KubernetesCreateDto, { ...CLUSTER, endpoint }),
        ).toContain('endpoint');
      }
      expect(
        await fieldsOf(KubernetesCreateDto, {
          ...CLUSTER,
          endpoint: 'https://k8s.lan',
        }),
      ).toEqual([]);
    });

    it('命名空间只认小写字母、数字与连字符，空串表示「全部命名空间」', async () => {
      expect(
        await fieldsOf(KubernetesCreateDto, { ...CLUSTER, namespace: 'kube-system' }),
      ).toEqual([]);
      expect(
        await fieldsOf(KubernetesCreateDto, { ...CLUSTER, namespace: '' }),
      ).toEqual([]);
      for (const namespace of ['Default', 'a_b', '-x', 'x'.repeat(64)]) {
        expect(
          await fieldsOf(KubernetesCreateDto, { ...CLUSTER, namespace }),
        ).toContain('namespace');
      }
    });

    it('明文确认开关是布尔（不落库，只为显式确认服务）', async () => {
      expect(
        await fieldsOf(KubernetesCreateDto, {
          ...CLUSTER,
          endpoint: 'http://127.0.0.1:8001',
          allowInsecure: 'yes',
        }),
      ).toContain('allowInsecure');
    });
  });

  describe('KubernetesUpdateDto', () => {
    it('全部字段可选，空对象也能通过', async () => {
      expect(await fieldsOf(KubernetesUpdateDto, {})).toEqual([]);
    });

    it('只改说明时不需要重填凭据（编辑表单的常态）', async () => {
      expect(
        await fieldsOf(KubernetesUpdateDto, { description: '换个说明' }),
      ).toEqual([]);
    });

    it('更新时的地址与命名空间仍要过格式校验', async () => {
      expect(
        await fieldsOf(KubernetesUpdateDto, { endpoint: 'https://host/path' }),
      ).toContain('endpoint');
      expect(
        await fieldsOf(KubernetesUpdateDto, { namespace: 'Bad_Name' }),
      ).toContain('namespace');
    });
  });
});
