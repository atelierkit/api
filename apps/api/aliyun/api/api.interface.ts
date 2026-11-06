/** 阿里云接口请求参数 */
export interface ApiConfig {
  /** 接口名，如 `DescribeCertificateState` */
  action: string;
  /** 接口版本，如 `2020-04-07` */
  version: string;
  /** 业务参数 */
  params?: Record<string, unknown>;
  /** 请求方法，注：带证书 PEM 的接口必须走 POST（URL 长度限制） */
  method?: 'GET' | 'POST';
  /** 服务接入地址，缺省为 `https://cas.aliyuncs.com` */
  endpoint?: string;
}

/** 阿里云的接口错误 */
export interface AliyunError {
  /** 错误码，如 `InsufficientQuota` */
  Code?: string;
  /** 错误说明 */
  Message?: string;
}

/**
 * 阿里云响应体
 *
 * 注 1：与腾讯云不同，阿里云**用 HTTP 状态码表达失败**（4xx / 5xx），错误信息在正文的
 * `Code` / `Message` 里；2xx 才是成功，故请求层会把非 2xx 转成 `HttpException`
 * 注 2：各接口的返回字段差异极大（`CertificateOrderList` / `Certificate` / `OrderId` …），
 * 故只声明公共字段，其余由调用方按需取
 */
export interface AliyunResponse {
  /** 请求 ID */
  RequestId?: string;
  /** 错误码，注：成功响应里不会出现 */
  Code?: string;
  /** 错误说明，注：成功响应里不会出现 */
  Message?: string;
  /** 各接口自有字段 */
  [field: string]: unknown;
}
