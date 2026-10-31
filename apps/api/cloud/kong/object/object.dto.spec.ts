// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  KongObjectCreateDto,
  KongObjectIndexDto,
  KongObjectShowDto,
  KongObjectUpdateDto,
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

describe('object.dto', () => {
  describe('KongObjectIndexDto', () => {
    it('站点ID与对象类型都必填', async () => {
      expect(await fieldsOf(KongObjectIndexDto, {})).toEqual(
        expect.arrayContaining(['kongId', 'type']),
      );
    });

    it('合法入参通过', async () => {
      expect(
        await fieldsOf(KongObjectIndexDto, { kongId: 3, type: 'routes' }),
      ).toEqual([]);
    });

    it('对象类型走白名单（值会拼进 Admin API 路径，不能放任任意串）', async () => {
      expect(
        await fieldsOf(KongObjectIndexDto, {
          kongId: 3,
          type: 'services/../../status',
        }),
      ).toEqual(['type']);
    });

    it('站点ID必须是正整数', async () => {
      expect(await fieldsOf(KongObjectIndexDto, { kongId: 0, type: 'routes' })).toEqual([
        'kongId',
      ]);
      expect(
        await fieldsOf(KongObjectIndexDto, { kongId: 1.5, type: 'routes' }),
      ).toEqual(['kongId']);
    });
  });

  describe('KongObjectShowDto', () => {
    it('对象ID必填', async () => {
      expect(
        await fieldsOf(KongObjectShowDto, { kongId: 3, type: 'routes' }),
      ).toEqual(['id']);
    });

    it('接受 UUID 与带 . _ ~ : 的名称', async () => {
      expect(
        await fieldsOf(KongObjectShowDto, {
          kongId: 3,
          type: 'routes',
          id: '3f1b9c2e-0a41-4f6d-9f8e-1a2b3c4d5e6f',
        }),
      ).toEqual([]);
      expect(
        await fieldsOf(KongObjectShowDto, {
          kongId: 3,
          type: 'routes',
          id: 'api.v1_test:prod~x',
        }),
      ).toEqual([]);
    });

    it('挡住能改变请求路径的 ID（/ 与 ..）', async () => {
      // 注：id 会原样拼进 `/{type}/{id}`，`..` 和 `/` 能把请求拐到别的接口上
      expect(
        await fieldsOf(KongObjectShowDto, {
          kongId: 3,
          type: 'routes',
          id: '../../status',
        }),
      ).toEqual(['id']);
      expect(
        await fieldsOf(KongObjectShowDto, {
          kongId: 3,
          type: 'routes',
          id: '..',
        }),
      ).toEqual(['id']);
      expect(
        await fieldsOf(KongObjectShowDto, {
          kongId: 3,
          type: 'routes',
          id: 'a b',
        }),
      ).toEqual(['id']);
    });
  });

  describe('KongObjectCreateDto', () => {
    it('对象信息必须是对象（数组不算）', async () => {
      expect(
        await fieldsOf(KongObjectCreateDto, {
          kongId: 3,
          type: 'routes',
          value: [1, 2],
        }),
      ).toEqual(['value']);
    });

    it('合法入参通过', async () => {
      expect(
        await fieldsOf(KongObjectCreateDto, {
          kongId: 3,
          type: 'routes',
          value: { name: '路由一', paths: ['/a'] },
        }),
      ).toEqual([]);
    });
  });

  describe('KongObjectUpdateDto', () => {
    it('对象ID与对象信息都必填', async () => {
      expect(
        await fieldsOf(KongObjectUpdateDto, { kongId: 3, type: 'routes' }),
      ).toEqual(expect.arrayContaining(['id', 'value']));
    });

    it('合法入参通过', async () => {
      expect(
        await fieldsOf(KongObjectUpdateDto, {
          kongId: 3,
          type: 'routes',
          id: 'abc',
          value: { name: '路由一' },
        }),
      ).toEqual([]);
    });
  });
});
