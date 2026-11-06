// 外部依赖
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
// 内部依赖
import { KongService } from '../../cloud/kong/kong.service.js';
import { ObjectService } from '../../cloud/kong/object/object.service.js';
import { ApiService } from '../api/api.service.js';
import { AliyunException } from '../api/api.request.js';
import type { AliyunResponse } from '../api/api.interface.js';
import {
  certItemOf,
  dnsRecordOf,
  orderItemOf,
  sansOf,
  timeOf,
} from './ssl.format.js';
import { probeDns } from './ssl.dns.js';
import type {
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

/** 证书列表与订单列表共用的响应数组名，注：数组名恒定，字段集随 `OrderType` 变化 */
const LIST_KEY = 'CertificateOrderList';

/**
 * 把 DTO 实例拍平成普通对象
 *
 * 注：直接 `{ ...dto }` 会丢原型并触发 `no-misused-spread`，而 DTO 在这里只是「参数包」，
 * 用 `Object.entries` 显式拷贝即可；`undefined` 取值留给签名层统一剔除
 *
 * @param value DTO 实例
 * @returns 普通对象
 */
function plainOf(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

/**
 * 把阿里云的错误码翻成可读文案
 *
 * 注：`InsufficientQuota` 是这个账号最容易撞的一个 —— 免费额度订单不计入新版「证书资源包」，
 * 直接把「额度不足。」抛给用户会让人以为是账号欠费
 *
 * @param err 捕获到的异常
 * @returns 原异常或翻译后的异常
 */
function translate(err: unknown): unknown {
  if (!(err instanceof AliyunException)) {
    return err;
  }
  if (err.code === 'InsufficientQuota') {
    return new BadRequestException(
      '该账号没有可用的证书资源包（免费额度订单不计入新版资源包），请先在阿里云控制台购买或领取证书',
    );
  }
  if (err.code === 'NotFound') {
    return new NotFoundException(err.message);
  }
  return err;
}

/**
 * 取响应里的列表数组
 *
 * @param body 接口响应
 * @returns 条目数组
 */
function itemsOf(body: AliyunResponse): Record<string, unknown>[] {
  /** 原始数组 */
  const list = body[LIST_KEY];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null,
  );
}

/** SSL 证书服务 */
@Injectable()
export class SslService {
  /**
   * 构造函数
   *
   * @param apiSrv 阿里云接口服务
   * @param kongSrv KONG 站点服务
   * @param objectSrv KONG 对象服务
   */
  constructor(
    private readonly apiSrv: ApiService,
    private readonly kongSrv: KongService,
    private readonly objectSrv: ObjectService,
  ) {}

  /**
   * 获取证书列表
   *
   * 注：`OrderType` 固定为 `CERT` —— 不传时阿里云返回的是**购买订单**（13940 条），
   * 字段集也完全不同（`OrderId` / `ProductName` / `CertType`），前端会整列空
   *
   * @param id 密钥ID
   * @param query 查询条件
   * @returns 证书列表与总数
   */
  async list(id: number, query: SslListDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.ssl(id, 'ListUserCertificateOrder', {
        ...plainOf(query),
        OrderType: 'CERT',
      });
      return {
        total: typeof body.TotalCount === 'number' ? body.TotalCount : 0,
        items: itemsOf(body).map(certItemOf),
      };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 获取证书详情（概览）
   *
   * 注：`GetCertificateDetail` 不含私钥，返回证书链、算法、部署情况等元信息；
   * 私钥另走 `pem()`，避免每次打开详情页都把私钥下发一次
   *
   * @param id 密钥ID
   * @param query 查询条件
   * @returns 证书概览
   */
  async show(id: number, query: SslDetailDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.ssl(id, 'GetCertificateDetail', {
        CertificateId: query.CertId,
      });
      return {
        certId: query.CertId,
        name: typeof body.CertificateName === 'string' ? body.CertificateName : '',
        commonName: typeof body.CommonName === 'string' ? body.CommonName : '',
        sans: sansOf(body.SubjectAlternativeNames ?? body.Domain),
        issuer: typeof body.Issuer === 'string' ? body.Issuer : '',
        algorithm: typeof body.Algorithm === 'string' ? body.Algorithm : '',
        keySize: typeof body.KeySize === 'number' ? body.KeySize : 0,
        serial: typeof body.Serial === 'string' ? body.Serial : '',
        fingerprint: typeof body.FingerPrint === 'string' ? body.FingerPrint : '',
        status: typeof body.CertificateStatus === 'string' ? body.CertificateStatus : '',
        instanceId: typeof body.InstanceId === 'string' ? body.InstanceId : '',
        certIdentifier:
          typeof body.CertIdentifier === 'string' ? body.CertIdentifier : '',
        existPrivateKey: body.ExistPrivateKey === true,
        startAt: timeOf(body.NotBefore),
        endAt: timeOf(body.NotAfter),
        // 注：证书链用于排查「中间证书缺失」导致的浏览器不受信
        chain: sansOf(body.CertificateChainList),
      };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 获取证书的公私钥
   *
   * @param id 密钥ID
   * @param query 查询条件
   * @returns PEM 格式的证书与私钥
   */
  async pem(id: number, query: SslDetailDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.ssl(id, 'GetUserCertificateDetail', {
        CertId: query.CertId,
      });
      /** 证书内容 */
      const cert = typeof body.Cert === 'string' ? body.Cert : '';
      /** 私钥内容 */
      const key = typeof body.Key === 'string' ? body.Key : '';
      if (cert === '' && key === '') {
        throw new NotFoundException('证书内容为空，请确认证书ID是否正确');
      }
      return { cert, key };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 上传证书
   *
   * @param id 密钥ID
   * @param value 上传参数
   * @returns 新证书ID
   */
  async import(id: number, value: SslImportDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.sslPost(
        id,
        'UploadUserCertificate',
        plainOf(value),
      );
      return { certId: typeof body.CertId === 'number' ? body.CertId : 0 };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 删除证书
   *
   * 注：阿里云的 `DeleteUserCertificate` 定位是「删除已过期的证书文件」，主要针对**上传证书**；
   * 已签发的证书是否可删取决于证书类型，失败时由阿里云的错误码给出原因
   *
   * @param id 密钥ID
   * @param value 删除参数
   * @returns 删除结果
   */
  async remove(id: number, value: SslDeleteDto) {
    try {
      await this.apiSrv.ssl(id, 'DeleteUserCertificate', { CertId: value.CertId });
      return { deleted: true, certId: value.CertId };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 获取订单列表
   *
   * @param id 密钥ID
   * @param query 查询条件
   * @returns 订单列表与总数
   */
  async orders(id: number, query: SslListDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.ssl(id, 'ListUserCertificateOrder', {
        ...plainOf(query),
        OrderType: 'CPACK',
      });
      return {
        total: typeof body.TotalCount === 'number' ? body.TotalCount : 0,
        items: itemsOf(body).map(orderItemOf),
      };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 提交 DV 证书申请
   *
   * 注：走 2018-07-13 版 `CreateDVOrderAudit` —— 新版 `CreateCertificateRequest` 需要证书资源包，
   * 本账号恒 `InsufficientQuota`；该接口只接受 `payed` 状态且 `Domain` 为空的订单
   *
   * @param id 密钥ID
   * @param value 申请参数
   * @returns 提交结果
   */
  async audit(id: number, value: SslAuditDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.sslPost(
        id,
        'CreateDVOrderAudit',
        plainOf(value),
        '2018-07-13',
      );
      return { submitted: true, requestId: body.RequestId ?? '' };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 取消证书申请
   *
   * 注：实测取消后订单会**彻底消失**（再查状态直接 404 `NotFound`），不是变成 `CLOSED`，
   * 因此前端必须二次确认
   *
   * @param id 密钥ID
   * @param value 取消参数
   * @returns 取消结果
   */
  async cancel(id: number, value: SslCancelDto) {
    try {
      await this.apiSrv.sslPost(id, 'CancelCertificateForPackageRequest', {
        OrderId: value.OrderId,
      });
      return { canceled: true, orderId: value.OrderId };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 查询申请状态
   *
   * 注：这是**唯一**能拿到验证记录与已签发证书的接口 —— `GetInstanceDetail` 对本账号的老订单
   * 恒 400 `NotFound`（2008… 旧实现就栽在这里）
   *
   * @param id 密钥ID
   * @param value 查询条件
   * @returns 状态、验证记录与已签发内容
   */
  async state(id: number, value: SslStateDto) {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.ssl(id, 'DescribeCertificateState', {
        OrderId: value.OrderId,
      });
      return {
        type: typeof body.Type === 'string' ? body.Type : 'unknow',
        record: dnsRecordOf(body),
        certId: typeof body.CertId === 'number' ? body.CertId : 0,
        // 注：已签发时返回 PEM；未签发时为空串
        cert: typeof body.Certificate === 'string' ? body.Certificate : '',
        key: typeof body.PrivateKey === 'string' ? body.PrivateKey : '',
      };
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * 探测 DNS 验证信息
   *
   * 注 1：只读，不代替用户在 DNS 服务商处添加记录
   * 注 2：`status` 为 `pending` 只代表**本地**查不到，不等于验证失败（实测存在本地查不到但
   * 阿里云已签发的情况），界面文案要留出传播中的余地
   *
   * @param id 密钥ID
   * @param value 探测条件
   * @returns 记录要求、DNS 状态与域名 NS
   */
  async verify(id: number, value: SslVerifyDto) {
    /** 申请状态 */
    const state = await this.state(id, { OrderId: value.OrderId });
    if (state.record === null) {
      return {
        type: state.type,
        record: null,
        status: 'unknown' as const,
        existing: [] as string[],
        ns: [] as string[],
        checkedAt: new Date().toISOString(),
      };
    }
    /** DNS 探测结果 */
    const probe = await probeDns(state.record, value.Domain);
    return {
      type: state.type,
      record: state.record,
      status: probe.status,
      existing: probe.existing,
      ns: probe.ns,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 部署证书到 KONG 站点
   *
   * 注 1：公私钥由阿里云接口现取，不经过浏览器 —— 前端只提交证书ID与站点ID
   * 注 2：`GetUserCertificateDetail` 的返回**含私钥**，只记证书 ID 与站点 ID，不打印内容
   *
   * @param id 密钥ID
   * @param value 部署参数
   * @returns 部署结果
   */
  async deploy(id: number, value: SslDeployDto) {
    /** 证书公私钥 */
    const { cert, key, sans } = await this.pemOf(id, value.CertId);
    if (cert === '' || key === '') {
      throw new BadRequestException('证书内容或私钥为空');
    }
    /** 需提交到 KONG 的证书数据 */
    const certData = { cert, key, snis: sans };

    /** KONG 站点 */
    const kong = await this.kongSrv.show(value.KongId);
    if (kong === null) {
      throw new NotFoundException('KONG 站点不存在');
    }

    if (value.update === 1) {
      if (!value.id) {
        throw new BadRequestException('更新模式下必须选择待更新的证书');
      }
      await this.objectSrv.update(value.KongId, 'certificates', value.id, certData);
      return { message: '证书更新成功', updated: true, certId: value.id };
    }
    /** 创建结果 */
    const created = await this.objectSrv.create(
      value.KongId,
      'certificates',
      certData,
    );
    return {
      message: '证书部署成功',
      created: true,
      certId: String(created['id'] ?? ''),
    };
  }

  /**
   * 取证书的公私钥与域名
   *
   * @param id 密钥ID
   * @param certId 证书ID
   * @returns 证书、私钥与域名列表
   */
  private async pemOf(
    id: number,
    certId: number,
  ): Promise<{ cert: string; key: string; sans: string[] }> {
    try {
      /** 接口响应 */
      const body = await this.apiSrv.ssl(id, 'GetUserCertificateDetail', {
        CertId: certId,
      });
      /** 证书内容 */
      const cert = typeof body.Cert === 'string' ? body.Cert : '';
      /** 私钥内容 */
      const key = typeof body.Key === 'string' ? body.Key : '';
      /** 证书域名 */
      const sansList = sansOf(body.Sans);
      return {
        cert,
        key,
        sans: sansList.length > 0 ? sansList : sansOf(body.Common),
      };
    } catch (err) {
      throw translate(err);
    }
  }
}
