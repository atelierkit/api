/** 腾讯云接口请求参数 */
export interface ApiConfig {
  /** 请求域名，如 `cdn.tencentcloudapi.com` */
  host: string;
  /** 服务名，用于派生签名密钥与拼 credential scope */
  service: string;
  /** 地域，注：CDN / SSL / DNSPod 不需要，传空串 */
  region: string;
  /** 接口名，如 `DescribeCertificates` */
  action: string;
  /** 接口版本，如 `2019-12-05` */
  version: string;
  /** 请求参数 */
  params?: object;
}

/** 腾讯云的业务错误 */
export interface TencentError {
  /** 错误码，如 `AuthFailure.SignatureFailure` */
  Code?: string;
  /** 错误说明 */
  Message?: string;
}

/**
 * 腾讯云响应体
 *
 * 注 1：腾讯云的**业务错误也是 HTTP 200**，错误信息在 `Response.Error` 里 —— 旧私有项目
 * 把它原样下发给前端，由前端判断 `RequestId` / `Error.Message`，这里保持同一契约
 * 注 2：各接口的返回字段差异极大（`Certificates` / `RecordList` / `InstanceSet` …），
 * 故只声明公共字段，其余由前端按需取
 */
export interface TencentResponse {
  /** 请求 ID，注：成功时必有，失败时也可能没有 */
  RequestId?: string;
  /** 业务错误 */
  Error?: TencentError;
  /** 各接口自有字段 */
  [field: string]: unknown;
}
