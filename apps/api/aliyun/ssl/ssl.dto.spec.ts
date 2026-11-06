// 外部依赖
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
// 内部依赖
import {
  SslAuditDto,
  SslCancelDto,
  SslDeleteDto,
  SslDeployDto,
  SslDetailDto,
  SslImportDto,
  SslListDto,
  SslStateDto,
  SslVerifyDto,
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

/** 合法的申请入参 */
const AUDIT = {
  InstanceId: 'cas-cn-45912b2nt0wd',
  Domain: 'kong.marbleqi.top',
  DomainVerifyType: 'DNS',
  Username: 'marbleqi',
  Mobile: '13673618697',
  Email: 'marbleqi@163.com',
  Province: 'zhejiang',
  City: 'hangzhou',
};

describe('ssl.dto', () => {
  describe('SslListDto', () => {
    it('全部可选', async () => {
      expect(await fieldsOf(SslListDto, {})).toEqual([]);
    });

    it('字符串数字会被转成数字', async () => {
      /** 实例 */
      const dto = plainToInstance(SslListDto, {
        CurrentPage: '2',
        ShowSize: '20',
      });
      expect(dto.CurrentPage).toBe(2);
      expect(dto.ShowSize).toBe(20);
    });

    it('页码从 1 起、每页不超过 100（订单上万条，放大只会更容易 503）', async () => {
      expect(await fieldsOf(SslListDto, { CurrentPage: 0 })).toEqual([
        'CurrentPage',
      ]);
      expect(await fieldsOf(SslListDto, { ShowSize: 101 })).toEqual(['ShowSize']);
      expect(await fieldsOf(SslListDto, { ShowSize: 100 })).toEqual([]);
    });
  });

  describe('SslDetailDto', () => {
    it('证书ID必填且必须是正整数', async () => {
      expect(await fieldsOf(SslDetailDto, {})).toEqual(['CertId']);
      expect(await fieldsOf(SslDetailDto, { CertId: 0 })).toEqual(['CertId']);
      expect(await fieldsOf(SslDetailDto, { CertId: 'abc' })).toEqual(['CertId']);
      expect(await fieldsOf(SslDetailDto, { CertId: '28334622' })).toEqual([]);
    });
  });

  describe('SslImportDto', () => {
    it('名称、证书、私钥三者必填', async () => {
      expect(await fieldsOf(SslImportDto, {})).toEqual([
        'Name',
        'Cert',
        'Key',
      ]);
      expect(
        await fieldsOf(SslImportDto, { Name: 'n', Cert: 'c', Key: 'k' }),
      ).toEqual([]);
    });

    it('证书名称超过 63 字符被拒（阿里云的限制）', async () => {
      expect(
        await fieldsOf(SslImportDto, {
          Name: 'x'.repeat(64),
          Cert: 'c',
          Key: 'k',
        }),
      ).toEqual(['Name']);
    });
  });

  describe('SslDeleteDto', () => {
    it('证书ID必填', async () => {
      expect(await fieldsOf(SslDeleteDto, {})).toEqual(['CertId']);
    });
  });

  describe('SslAuditDto', () => {
    it('完整入参通过', async () => {
      expect(await fieldsOf(SslAuditDto, AUDIT)).toEqual([]);
    });

    it('八个必填项缺失时全部报出', async () => {
      expect(await fieldsOf(SslAuditDto, {})).toEqual([
        'InstanceId',
        'Domain',
        'DomainVerifyType',
        'Username',
        'Mobile',
        'Email',
        'Province',
        'City',
      ]);
    });

    it('手机号必须是 11 位大陆号段', async () => {
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, Mobile: '12345678901' }),
      ).toEqual(['Mobile']);
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, Mobile: '1367361869' }),
      ).toEqual(['Mobile']);
    });

    it('域名不接受带协议头或空白的形式', async () => {
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, Domain: 'http://a.com' }),
      ).toEqual(['Domain']);
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, Domain: 'not a domain' }),
      ).toEqual(['Domain']);
    });

    it('允许通配符域名（签名时 `*` 会编码成 %2A）', async () => {
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, Domain: '*.marbleqi.top' }),
      ).toEqual([]);
    });

    it('验证方式只认 DNS / FILE', async () => {
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, DomainVerifyType: 'MAIL' }),
      ).toEqual(['DomainVerifyType']);
      expect(
        await fieldsOf(SslAuditDto, { ...AUDIT, DomainVerifyType: 'FILE' }),
      ).toEqual([]);
    });
  });

  describe('SslCancelDto / SslStateDto', () => {
    it('订单ID必填且为正整数', async () => {
      expect(await fieldsOf(SslCancelDto, {})).toEqual(['OrderId']);
      expect(await fieldsOf(SslCancelDto, { OrderId: -1 })).toEqual(['OrderId']);
      expect(await fieldsOf(SslCancelDto, { OrderId: '1851806' })).toEqual([]);
      expect(await fieldsOf(SslStateDto, {})).toEqual(['OrderId']);
    });
  });

  describe('SslVerifyDto', () => {
    it('订单ID必填，域名可选', async () => {
      expect(await fieldsOf(SslVerifyDto, { OrderId: 1 })).toEqual([]);
      expect(await fieldsOf(SslVerifyDto, {})).toEqual(['OrderId']);
    });

    it('传了域名就要校验格式', async () => {
      expect(
        await fieldsOf(SslVerifyDto, { OrderId: 1, Domain: 'bad domain' }),
      ).toEqual(['Domain']);
    });
  });

  describe('SslDeployDto', () => {
    it('部署方式只认 0 / 1，站点ID必须是数字', async () => {
      /** 合法入参 */
      const value = { CertId: 1, KongId: 1, update: 0 };
      expect(await fieldsOf(SslDeployDto, value)).toEqual([]);
      expect(await fieldsOf(SslDeployDto, { ...value, update: 2 })).toEqual([
        'update',
      ]);
      expect(await fieldsOf(SslDeployDto, { ...value, KongId: 'abc' })).toEqual([
        'KongId',
      ]);
    });

    it('更新模式不强制要求 KONG 证书ID（由服务层给出可读错误）', async () => {
      expect(
        await fieldsOf(SslDeployDto, { CertId: 1, KongId: 1, update: 1 }),
      ).toEqual([]);
    });
  });
});
