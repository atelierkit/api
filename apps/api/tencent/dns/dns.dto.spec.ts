// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  DnsCreateDto,
  DnsDeleteDto,
  DnsLineDto,
  DnsListDto,
  DnsModifyDto,
  DnsTypeDto,
} from './dns.dto.js';

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

/** 合法的建记录入参 */
const CREATE = {
  Domain: 'example.com',
  RecordType: 'A',
  RecordLine: '默认',
  Value: '1.2.3.4',
};

describe('dns.dto', () => {
  describe('DnsCreateDto', () => {
    it('域名 / 记录类型 / 线路 / 记录值四个必填', async () => {
      expect(await fieldsOf(DnsCreateDto, {})).toEqual(
        expect.arrayContaining(['Domain', 'RecordType', 'RecordLine', 'Value']),
      );
    });

    it('字段齐备时通过，且可选字段原样保留（它们要透传给腾讯云）', async () => {
      /** 入参 */
      const value = {
        ...CREATE,
        SubDomain: 'www',
        TTL: 600,
        MX: 0,
        Status: 'ENABLE',
        Remark: '官网',
        RecordLineId: '0',
      };
      expect(await fieldsOf(DnsCreateDto, value)).toEqual([]);
      /** 实例 */
      const dto = plainToInstance(DnsCreateDto, value);
      expect(dto.SubDomain).toBe('www');
      expect(dto.Status).toBe('ENABLE');
      expect(dto.RecordLineId).toBe('0');
    });

    it('旧私有项目的字段名（Type / Name）会被 whitelist 静默剥掉 —— 这就是当初建记录报 MissingParameter 的原因', async () => {
      /** 旧字段名 */
      const legacy = { Domain: 'example.com', Type: 'A', Name: 'www', Value: '1.2.3.4' };
      /** 实例 */
      const dto = plainToInstance(DnsCreateDto, legacy);
      /** 校验结果 */
      const errors = await validate(dto, { whitelist: true });
      // 注：whitelist 是「静默剥离」，不会为 Type / Name 报错 —— 所以只剩缺字段的错误
      expect(errors.map((error) => error.property)).toEqual(
        expect.arrayContaining(['RecordType', 'RecordLine']),
      );
      expect(dto).not.toHaveProperty('Type');
      expect(dto).not.toHaveProperty('Name');
    });

    it('状态只认 ENABLE / DISABLE', async () => {
      expect(await fieldsOf(DnsCreateDto, { ...CREATE, Status: 'on' })).toEqual([
        'Status',
      ]);
    });
  });

  describe('DnsModifyDto', () => {
    it('继承建记录的必填项，并要求 RecordId', async () => {
      expect(await fieldsOf(DnsModifyDto, CREATE)).toEqual(['RecordId']);
      expect(await fieldsOf(DnsModifyDto, { ...CREATE, RecordId: 8 })).toEqual([]);
    });

    it('RecordId 允许字符串数字（表单 / URL 里常见）', async () => {
      /** 实例 */
      const dto = plainToInstance(DnsModifyDto, { ...CREATE, RecordId: '8' });
      expect(dto.RecordId).toBe(8);
    });
  });

  describe('其它入参', () => {
    it('DnsDeleteDto 需要域名与记录ID', async () => {
      expect(await fieldsOf(DnsDeleteDto, {})).toEqual(
        expect.arrayContaining(['Domain', 'RecordId']),
      );
      expect(await fieldsOf(DnsDeleteDto, { Domain: 'example.com', RecordId: 8 })).toEqual(
        [],
      );
    });

    it('列表的偏移量从 0 起，负数拒绝', async () => {
      expect(await fieldsOf(DnsListDto, { Domain: 'example.com' })).toEqual([]);
      expect(
        await fieldsOf(DnsListDto, { Domain: 'example.com', Offset: -1 }),
      ).toEqual(['Offset']);
    });

    it('类型查询无需参数，线路查询需要域名', async () => {
      expect(await fieldsOf(DnsTypeDto, {})).toEqual([]);
      expect(await fieldsOf(DnsLineDto, {})).toEqual(['Domain']);
    });
  });
});
