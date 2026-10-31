// 外部依赖
import { HttpException, HttpStatus } from '@nestjs/common';

/** Admin API 请求超时（毫秒），注：网关不可达时必须尽快失败，不能让浏览器一直挂着 */
export const KONG_TIMEOUT = 10000;

/** Admin API 请求方式，注：对象管理只用到这五种 */
export type KongMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Admin API 请求参数 */
export interface KongRequestInit {
  /** 请求方式，缺省 `GET` */
  method?: KongMethod;
  /** 请求正文，非空时按 JSON 发送 */
  body?: unknown;
}

/**
 * 请求 KONG 的 Admin API
 *
 * 注 1：旧私有项目用 `@nestjs/axios` + `validateStatus` 兜住所有状态码，这里改用运行时自带的
 * `fetch`（Node 18+），不引新依赖，语义一致：非 2xx 不抛网络错，由本函数按状态码转成
 * `HttpException` 原样透传给前端，避免网关的 401/404 被吞成 500
 * 注 2：站点与站点下的对象共用本函数，故抽成独立文件而不是某个服务的私有方法
 *
 * @param base 站点 Admin API 地址
 * @param path 接口路径（可含查询串），以 `/` 开头
 * @param init 请求方式与正文
 * @returns 响应正文，注：Kong 的 DELETE 返回 204 空正文，此时得到空串
 */
export async function kongRequest<T = unknown>(
  base: string,
  path: string,
  init: KongRequestInit = {},
): Promise<T> {
  /** 目标地址，注：库里存的地址可能带结尾斜杠，统一去掉再拼，避免出现 `//plugins` */
  const target = `${base.replace(/\/+$/, '')}${path}`;
  /** 请求头，注：只有带正文时才声明 Content-Type */
  const headers: Record<string, string> = {};
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  /** 网关响应 */
  let response: Response;
  try {
    response = await fetch(target, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(KONG_TIMEOUT),
    });
  } catch (err) {
    throw new HttpException(
      `网关请求失败：${err instanceof Error ? err.message : String(err)}`,
      HttpStatus.BAD_GATEWAY,
    );
  }
  /** 响应正文，注：Kong 正常返回 JSON，出错时返回 `{ message }` */
  const text = await response.text();
  /** 解析后的正文 */
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON 正文（如反向代理的 HTML 错误页）原样带回，交给下面的 message 兜底
  }
  if (!response.ok) {
    throw new HttpException(
      messageOf(body, response.statusText),
      response.status,
    );
  }
  return body as T;
}

/**
 * 提取错误信息
 *
 * @param body 响应正文
 * @param fallback 兜底文案
 * @returns 可直接展示的错误信息
 */
export function messageOf(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && 'message' in body) {
    return String((body as { message: unknown }).message);
  }
  if (typeof body === 'string' && body.trim() !== '') {
    return body;
  }
  return fallback || '网关请求失败！';
}
