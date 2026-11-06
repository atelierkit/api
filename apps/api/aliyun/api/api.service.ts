// 外部依赖
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
// 内部依赖
import { KeyService } from '../../cloud/key/key.service.js';
import type { ApiConfig, AliyunResponse } from './api.interface.js';
import { aliyunRequest } from './api.request.js';
import { SIGNATURE_METHOD, SIGNATURE_VERSION, canonicalize, signatureOf } from './api.sign.js';

/** CAS（SSL 证书服务）的接入地址 */
const CAS_ENDPOINT = 'https://cas.aliyuncs.com';

/** CAS 当前主流接口版本，注：`CreateDVOrderAudit` 等少数接口仍只能用 2018-07-13 */
const CAS_VERSION = '2020-04-07';

/** 版本号格式，注：会进签名与请求，挡掉换行之类的字符 */
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 阿里云 API 服务 */
@Injectable()
export class ApiService {
  /**
   * 构造函数
   *
   * @param keySrv 密钥服务
   */
  constructor(private readonly keySrv: KeyService) {}

  /**
   * 调用阿里云接口
   *
   * 注 1：密钥的 `secret` 不出库（`KeyService.show` 的 select 不含它），故这里分两步取 ——
   * `show` 校验密钥存在与云服务商，`secret(id)` 单独取访问密钥 Secret
   * 注 2：签名覆盖「公共参数 + 业务参数」全量，与参数最终落在 query 还是 body 无关
   * 注 3：POST 时公共参数与签名留在 query、业务参数走表单 body —— 证书 PEM 可达数 KB，
   * 全量放 URL 会被网关拒绝
   *
   * @param id 密钥ID（云服务商ID）
   * @param config 请求参数
   * @returns 接口响应
   */
  async request(id: number, config: ApiConfig): Promise<AliyunResponse> {
    /** 密钥 */
    const key = await this.keySrv.show(id);
    if (key === null) {
      throw new NotFoundException('请求的密钥不存在');
    }
    if (key.provider !== 'aliyun') {
      throw new BadRequestException('暂不支持该云服务商');
    }
    if (!VERSION_PATTERN.test(config.version)) {
      throw new BadRequestException('接口版本格式不合法');
    }
    /** 访问密钥 Secret */
    const secret = await this.keySrv.secret(id);
    if (!secret) {
      throw new BadRequestException('密钥缺少访问密钥 Secret');
    }

    /** 请求方法 */
    const method = config.method ?? 'GET';
    /** 业务参数 */
    const params = config.params ?? {};
    /** 公共请求参数 */
    const common: Record<string, unknown> = {
      Action: config.action,
      Version: config.version,
      Format: 'JSON',
      AccessKeyId: key.key,
      SignatureNonce: randomUUID(),
      // 注：按规范取秒级 UTC（不带毫秒），格式 `YYYY-MM-DDThh:mm:ssZ`
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      SignatureMethod: SIGNATURE_METHOD,
      SignatureVersion: SIGNATURE_VERSION,
    };
    /** 签名 */
    const signature = signatureOf(secret, method, { ...common, ...params });
    /** 查询串，注：GET 带全量参数，POST 只带公共参数与签名 */
    const query = `${
      method === 'GET' ? canonicalize({ ...common, ...params }) : canonicalize(common)
    }&Signature=${signature}`;
    return aliyunRequest(
      config.endpoint ?? CAS_ENDPOINT,
      method,
      query,
      method === 'POST' ? canonicalize(params) : undefined,
    );
  }

  /**
   * 证书接口方法
   *
   * @param id 密钥ID
   * @param action 接口名
   * @param params 业务参数
   * @param version 接口版本号，缺省为 2020-04-07
   * @returns 接口响应
   */
  ssl(
    id: number,
    action: string,
    params: Record<string, unknown> = {},
    version: string = CAS_VERSION,
  ): Promise<AliyunResponse> {
    return this.request(id, { action, version, params });
  }

  /**
   * 证书接口方法（POST 提交）
   *
   * 注：`UploadUserCertificate`（证书 PEM）、`RevokeCertificate`（只接受 POST）等必须走这条
   *
   * @param id 密钥ID
   * @param action 接口名
   * @param params 业务参数
   * @param version 接口版本号，缺省为 2020-04-07
   * @returns 接口响应
   */
  sslPost(
    id: number,
    action: string,
    params: Record<string, unknown> = {},
    version: string = CAS_VERSION,
  ): Promise<AliyunResponse> {
    return this.request(id, { action, version, params, method: 'POST' });
  }
}
