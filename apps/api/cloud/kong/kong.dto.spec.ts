// 外部依赖
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { KongCreateDto, KongUpdateDto } from './kong.dto.js';

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

/** 合法的建站点入参 */
const KONG = {
  name: '本地网关',
  description: '家用服务器的 Kong',
  url: 'http://192.168.1.10:8001',
  status: true,
};

describe('kong.dto', () => {
  describe('KongCreateDto', () => {
    it('四个字段都必填', async () => {
      expect(await fieldsOf(KongCreateDto, {})).toEqual(
        expect.arrayContaining(['name', 'description', 'url', 'status']),
      );
    });

    it('字段齐备时通过校验', async () => {
      expect(await fieldsOf(KongCreateDto, KONG)).toEqual([]);
    });

    it('status 为 false 时同样通过（禁用站点不能被判成「空」）', async () => {
      expect(await fieldsOf(KongCreateDto, { ...KONG, status: false })).toEqual(
        [],
      );
    });

    it('地址超长时报错', async () => {
      expect(
        await fieldsOf(KongCreateDto, { ...KONG, url: `http://${'a'.repeat(200)}` }),
      ).toEqual(['url']);
    });
  });

  describe('KongUpdateDto', () => {
    it('全部字段可选：空提交也要能通过（只改状态的场景）', async () => {
      expect(await fieldsOf(KongUpdateDto, {})).toEqual([]);
    });

    it('提交了就按建站点的规则校验', async () => {
      expect(await fieldsOf(KongUpdateDto, { name: '' })).toEqual(['name']);
      expect(await fieldsOf(KongUpdateDto, { status: 'false' })).toEqual([
        'status',
      ]);
    });
  });
});
