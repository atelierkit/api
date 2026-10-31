// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';

/** 腾讯云 API 请求超时（毫秒），注：云厂商接口偶发长尾，比 Kong 的 10s 放宽些 */
export const TENCENT_TIMEOUT = 15000;

/**
 * 请求腾讯云 API
 *
 * 注 1：旧私有项目用 `@nestjs/axios`，本仓库不引 axios，改用运行时自带的 `fetch`（Node 18+），
 * 与 `cloud/kong/kong.request.ts` 同一套做法
 * 注 2：**业务错误不在这里抛** —— 腾讯云出错时同样是 HTTP 200，正文为 `{ Response: { Error } }`，
 * 该正文原样返回给调用方（与旧项目契约一致，前端据 `Error.Message` 提示）
 * 注 3：只有「连不上 / 非 2xx」才转成 `HttpException`，避免把网络故障伪装成业务失败
 *
 * @param host 请求域名
 * @param headers 已签名的请求头
 * @param payload 已序列化的请求正文
 * @returns 响应正文
 */
export async function tencentRequest(
  host: string,
  headers: Record<string, string>,
  payload: string,
): Promise<unknown> {
  /** 云厂商响应 */
  let response: Response;
  try {
    response = await fetch(`https://${host}/`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(TENCENT_TIMEOUT),
    });
  } catch (err) {
    throw new HttpException(
      `腾讯云接口请求失败：${err instanceof Error ? err.message : String(err)}`,
      HttpStatus.BAD_GATEWAY,
    );
  }
  /** 响应正文 */
  const text = await response.text();
  if (!response.ok) {
    throw new HttpException(
      text.trim() === '' ? response.statusText : text,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 非 JSON 正文（如网关错误页）原样带回，由调用方判断
    return text;
  }
}
