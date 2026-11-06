// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';
// 内部依赖
import type { AliyunResponse } from './api.interface.js';

/** 阿里云 API 请求超时（毫秒），注：订单列表在数据量大时会明显变慢 */
export const ALIYUN_TIMEOUT = 15000;

/**
 * 阿里云接口异常
 *
 * 注：带出原始错误码 —— 调用方需要按 `InsufficientQuota` / `NotFound` 这类码做分支处理，
 * 只靠提示文案判断会把中英文案改一次就失效
 */
export class AliyunException extends HttpException {
  /**
   * 构造函数
   *
   * @param code 阿里云错误码
   * @param message 错误说明
   * @param status HTTP 状态码
   */
  constructor(
    readonly code: string,
    message: string,
    status: number,
  ) {
    super(message, status);
  }
}

/**
 * 请求阿里云 API
 *
 * 注 1：不引 `@nestjs/axios`，请求走运行时自带的 `fetch`，与
 * `tencent/api/api.request.ts`、`cloud/kong/kong.request.ts` 同一套做法
 * 注 2：阿里云**用 HTTP 状态码表达失败**，非 2xx 一律转 `AliyunException`（保留原状态码与错误码），
 * 与腾讯云「HTTP 200 + `Error`」的形状不同，不要照搬那边的处理
 * 注 3：`ServiceUnavailable`（订单量大时偶发）不自动重试 —— 重试只会加深限流
 *
 * @param endpoint 服务接入地址（不含查询串）
 * @param method 请求方法
 * @param query 已签名的查询串
 * @param body 已编码的表单正文（仅 POST）
 * @returns 响应正文
 */
export async function aliyunRequest(
  endpoint: string,
  method: 'GET' | 'POST',
  query: string,
  body?: string,
): Promise<AliyunResponse> {
  /** 云厂商响应 */
  let response: Response;
  try {
    response = await fetch(`${endpoint}/?${query}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          }),
      signal: AbortSignal.timeout(ALIYUN_TIMEOUT),
    });
  } catch (err) {
    throw new HttpException(
      `阿里云接口请求失败：${err instanceof Error ? err.message : String(err)}`,
      HttpStatus.BAD_GATEWAY,
    );
  }

  /** 响应正文 */
  const text = await response.text();
  /** 解析后的正文，注：非 JSON（如网关错误页）时保留原文 */
  let parsed: AliyunResponse;
  try {
    parsed = JSON.parse(text) as AliyunResponse;
  } catch {
    parsed = { Message: text.trim() };
  }

  if (!response.ok) {
    /** 阿里云错误码 */
    const code = typeof parsed.Code === 'string' ? parsed.Code : '';
    /** 阿里云错误说明 */
    const message =
      typeof parsed.Message === 'string' && parsed.Message !== ''
        ? parsed.Message
        : response.statusText;
    throw new AliyunException(code, message, response.status);
  }
  return parsed;
}
