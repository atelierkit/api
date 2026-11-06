// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import { ContactCreateDto, ContactUpdateDto } from './contact.dto.js';

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

/** 合法的创建入参 */
const CONTACT = {
  username: 'marbleqi',
  email: 'marbleqi@163.com',
  phone: '13673618697',
  province: 'zhejiang',
  city: 'hangzhou',
};

describe('contact.dto', () => {
  describe('ContactCreateDto', () => {
    it('完整入参通过（备注、默认项、状态都可选）', async () => {
      expect(await fieldsOf(ContactCreateDto, CONTACT)).toEqual([]);
    });

    it('五个必填项缺失时全部报出', async () => {
      expect(await fieldsOf(ContactCreateDto, {})).toEqual([
        'username',
        'email',
        'phone',
        'province',
        'city',
      ]);
    });

    it('手机号只认 11 位大陆号段', async () => {
      expect(
        await fieldsOf(ContactCreateDto, { ...CONTACT, phone: '12345678901' }),
      ).toEqual(['phone']);
      expect(
        await fieldsOf(ContactCreateDto, { ...CONTACT, phone: '1367361869' }),
      ).toEqual(['phone']);
      expect(
        await fieldsOf(ContactCreateDto, { ...CONTACT, phone: '136736186971' }),
      ).toEqual(['phone']);
    });

    it('邮箱格式校验', async () => {
      expect(
        await fieldsOf(ContactCreateDto, { ...CONTACT, email: 'not-mail' }),
      ).toEqual(['email']);
    });

    it('默认项与状态接受 false（不能被当成空值拒掉）', async () => {
      expect(
        await fieldsOf(ContactCreateDto, {
          ...CONTACT,
          isDefault: false,
          status: false,
        }),
      ).toEqual([]);
    });

    it('默认项传字符串被拒（避免 "false" 被当成 true）', async () => {
      expect(
        await fieldsOf(ContactCreateDto, { ...CONTACT, isDefault: 'false' }),
      ).toEqual(['isDefault']);
    });
  });

  describe('ContactUpdateDto', () => {
    it('全部可选（按需只提交改动项）', async () => {
      expect(await fieldsOf(ContactUpdateDto, {})).toEqual([]);
      expect(await fieldsOf(ContactUpdateDto, { name: '公司' })).toEqual([]);
    });

    it('提交了就照样校验', async () => {
      expect(await fieldsOf(ContactUpdateDto, { phone: '123' })).toEqual([
        'phone',
      ]);
      expect(await fieldsOf(ContactUpdateDto, { email: 'x' })).toEqual([
        'email',
      ]);
    });
  });
});
