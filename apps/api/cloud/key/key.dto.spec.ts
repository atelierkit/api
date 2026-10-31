// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { KeyCreateDto, KeyUpdateDto } from './key.dto.js';

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

/** 合法的建密钥入参 */
const KEY = {
  name: '腾讯云主账号',
  description: '部署 CDN 用',
  provider: 'tencent',
  key: 'AKIDEXAMPLE',
  secret: 'SECRETEXAMPLE',
  status: true,
};

describe('key.dto', () => {
  describe('KeyCreateDto', () => {
    it('六个字段都必填', async () => {
      expect(await fieldsOf(KeyCreateDto, {})).toEqual(
        expect.arrayContaining([
          'name',
          'description',
          'provider',
          'key',
          'secret',
          'status',
        ]),
      );
    });

    it('字段齐备时通过校验', async () => {
      expect(await fieldsOf(KeyCreateDto, KEY)).toEqual([]);
    });

    it('status 为 false 时同样通过（禁用密钥不能被判成「空」）', async () => {
      expect(await fieldsOf(KeyCreateDto, { ...KEY, status: false })).toEqual([]);
    });

    it('provider 只认 aws / aliyun / tencent', async () => {
      expect(await fieldsOf(KeyCreateDto, { ...KEY, provider: 'google' })).toEqual([
        'provider',
      ]);
    });

    it('名称超长时报错（避免把长文本塞进列表列）', async () => {
      expect(
        await fieldsOf(KeyCreateDto, { ...KEY, name: 'a'.repeat(51) }),
      ).toEqual(['name']);
    });
  });

  describe('KeyUpdateDto', () => {
    it('全部字段可选：空提交也要能通过（只改状态的场景）', async () => {
      expect(await fieldsOf(KeyUpdateDto, {})).toEqual([]);
    });

    it('不提交 secret 表示保持原值（详情接口不下发 secret）', async () => {
      expect(
        await fieldsOf(KeyUpdateDto, { name: '改名', status: false }),
      ).toEqual([]);
    });

    it('提交了 secret 就不能是空串', async () => {
      expect(await fieldsOf(KeyUpdateDto, { secret: '' })).toEqual(['secret']);
    });

    it('provider 与 status 的取值同样受限', async () => {
      expect(await fieldsOf(KeyUpdateDto, { provider: 'ovh' })).toEqual([
        'provider',
      ]);
      expect(await fieldsOf(KeyUpdateDto, { status: 'false' })).toEqual([
        'status',
      ]);
    });
  });
});
