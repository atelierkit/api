// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  SslAliasDto,
  SslApplyDto,
  SslDeployDto,
  SslListDto,
  SslOperateDto,
} from './ssl.dto.js';

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

describe('ssl.dto', () => {
  describe('SslListDto', () => {
    it('全部可选，字符串数字会被转成数字', async () => {
      expect(await fieldsOf(SslListDto, {})).toEqual([]);
      /** 实例 */
      const dto = plainToInstance(SslListDto, { Offset: '20', Limit: '10' });
      expect(dto.Offset).toBe(20);
      expect(dto.Limit).toBe(10);
    });

    it('负数偏移与 0 条数量都拒绝', async () => {
      expect(await fieldsOf(SslListDto, { Offset: -1 })).toEqual(['Offset']);
      expect(await fieldsOf(SslListDto, { Limit: 0 })).toEqual(['Limit']);
    });
  });

  describe('SslAliasDto', () => {
    it('备注允许空串（清空备注是合法操作）', async () => {
      expect(
        await fieldsOf(SslAliasDto, { CertificateId: 'cert-1', Alias: '' }),
      ).toEqual([]);
    });

    it('证书ID 必填', async () => {
      expect(await fieldsOf(SslAliasDto, { Alias: 'x' })).toEqual([
        'CertificateId',
      ]);
    });
  });

  describe('SslApplyDto', () => {
    it('验证方式只认三种枚举值', async () => {
      expect(
        await fieldsOf(SslApplyDto, {
          DomainName: 'example.com',
          DvAuthMethod: 'DNS_AUTO',
        }),
      ).toEqual([]);
      expect(
        await fieldsOf(SslApplyDto, {
          DomainName: 'example.com',
          DvAuthMethod: 'MAIL',
        }),
      ).toEqual(['DvAuthMethod']);
    });

    it('PackageType 允许字符串数字（前端表单给的就是字符串）', async () => {
      /** 实例 */
      const dto = plainToInstance(SslApplyDto, {
        DomainName: 'example.com',
        DvAuthMethod: 'DNS',
        PackageType: '83',
      });
      expect(await validate(dto)).toEqual([]);
      expect(dto.PackageType).toBe(83);
    });
  });

  describe('SslDeployDto', () => {
    it('域名必须是字符串数组，部署方式只认 0 / 1', async () => {
      /** 合法入参 */
      const value = {
        CertificateId: 'cert-1',
        domain: ['example.com', 'www.example.com'],
        KongId: 1,
        update: 0,
      };
      expect(await fieldsOf(SslDeployDto, value)).toEqual([]);
      expect(await fieldsOf(SslDeployDto, { ...value, domain: 'example.com' })).toEqual([
        'domain',
      ]);
      expect(await fieldsOf(SslDeployDto, { ...value, update: 2 })).toEqual([
        'update',
      ]);
      expect(await fieldsOf(SslDeployDto, { ...value, KongId: 'abc' })).toEqual([
        'KongId',
      ]);
    });

    it('更新模式不强制要求 id（由控制器给出可读的错误）', async () => {
      expect(
        await fieldsOf(SslDeployDto, {
          CertificateId: 'cert-1',
          domain: ['example.com'],
          KongId: 1,
          update: 1,
        }),
      ).toEqual([]);
    });
  });

  describe('SslOperateDto', () => {
    it('证书ID 必填且不能为空串', async () => {
      expect(await fieldsOf(SslOperateDto, {})).toEqual(['CertificateId']);
      expect(await fieldsOf(SslOperateDto, { CertificateId: '' })).toEqual([
        'CertificateId',
      ]);
    });
  });
});
