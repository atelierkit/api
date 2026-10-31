// 外部依赖
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
// 内部依赖
import { KeyService } from '../../cloud/key/key.service.js';
import type { ApiConfig, TencentResponse } from './api.interface.js';
import { tencentRequest } from './api.request.js';
import { headersOf } from './api.sign.js';

/** 合法地域，注：地域会进入请求头，挡掉换行之类的字符（Header 注入） */
const REGION_PATTERN = /^[a-z0-9-]*$/;

/** 腾讯云 API 服务 */
@Injectable()
export class ApiService {
  /**
   * 构造函数
   *
   * @param keySrv 密钥服务
   */
  constructor(private readonly keySrv: KeyService) {}

  /**
   * 调用腾讯云接口
   *
   * 注 1：密钥的 `secret` 不出库（`KeyService.show` 的 select 不含它），故这里分两步取 ——
   * `show` 校验密钥存在与云服务商，`secret(id)` 单独取访问密钥 Secret
   * 注 2：返回值已剥离外层 `Response`，业务错误（`Response.Error`）原样保留，与旧项目契约一致
   *
   * @param id 密钥ID（云服务商ID）
   * @param config 请求参数
   * @returns 接口响应（`Response` 段）
   */
  async request(id: number, config: ApiConfig): Promise<TencentResponse> {
    /** 密钥 */
    const key = await this.keySrv.show(id);
    if (key === null) {
      throw new NotFoundException('请求的密钥不存在');
    }
    if (key.provider !== 'tencent') {
      throw new BadRequestException('暂不支持该云服务商');
    }
    if (config.region && !REGION_PATTERN.test(config.region)) {
      throw new BadRequestException('地域格式不合法');
    }
    /** 访问密钥 Secret */
    const secretKey = await this.keySrv.secret(id);
    if (!secretKey) {
      throw new BadRequestException('密钥缺少访问密钥 Secret');
    }
    /** 请求正文 */
    const payload = JSON.stringify(config.params ?? {});
    /** 秒级时间戳 */
    const timestamp = Math.floor(Date.now() / 1000);
    /** 请求头（已签名） */
    const headers = headersOf({
      secretId: key.key,
      secretKey,
      service: config.service,
      host: config.host,
      action: config.action,
      version: config.version,
      region: config.region,
      payload,
      timestamp,
    });
    /** 云厂商响应正文 */
    const body = await tencentRequest(config.host, headers, payload);
    if (body === null || typeof body !== 'object') {
      return {};
    }
    /** 响应段 */
    const response = (body as { Response?: unknown }).Response;
    return (response ?? {}) as TencentResponse;
  }

  /**
   * CDN 接口方法
   *
   * @param id 密钥ID
   * @param action 接口名
   * @param params 接口参数
   * @returns 接口响应
   */
  cdn(id: number, action: string, params: object): Promise<TencentResponse> {
    return this.request(id, {
      host: 'cdn.tencentcloudapi.com',
      service: 'cdn',
      region: '',
      action,
      version: '2018-06-06',
      params,
    });
  }

  /**
   * 证书接口方法
   *
   * @param id 密钥ID
   * @param action 接口名
   * @param params 接口参数
   * @returns 接口响应
   */
  ssl(id: number, action: string, params: object): Promise<TencentResponse> {
    return this.request(id, {
      host: 'ssl.tencentcloudapi.com',
      service: 'ssl',
      region: '',
      action,
      version: '2019-12-05',
      params,
    });
  }

  /**
   * 轻量应用服务器接口方法
   *
   * @param id 密钥ID
   * @param region 地域
   * @param action 接口名
   * @param params 接口参数
   * @returns 接口响应
   */
  lighthouse(
    id: number,
    region: string,
    action: string,
    params: object,
  ): Promise<TencentResponse> {
    return this.request(id, {
      host: 'lighthouse.tencentcloudapi.com',
      service: 'lighthouse',
      region,
      action,
      version: '2020-03-24',
      params,
    });
  }

  /**
   * DNSPod 接口方法
   *
   * @param id 密钥ID
   * @param action 接口名
   * @param params 接口参数
   * @returns 接口响应
   */
  dnspod(id: number, action: string, params: object): Promise<TencentResponse> {
    return this.request(id, {
      host: 'dnspod.tencentcloudapi.com',
      service: 'dnspod',
      region: '',
      action,
      version: '2021-03-23',
      params,
    });
  }
}
