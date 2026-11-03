// 外部依赖
import {
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';

/**
 * 请求超时（毫秒）
 *
 * 注：集群不可达时必须尽快失败，不能让浏览器一直挂着；`/pods` 这类大列表在集群规模大时
 * 可能偏慢，由调用方通过 `init.timeout` 单独放宽
 */
export const KUBERNETES_TIMEOUT = 15000;

/**
 * 响应体累积上限（字节）
 *
 * 注：`/api/v1/pods`（全部命名空间）在节点多、Pod 多时可达数 MB，单条 Pod 也有几十 KB；
 * 超过上限就截断，避免一次列表请求把 api 进程内存打满
 */
export const KUBERNETES_MAX_BODY = 4 * 1024 * 1024;

/** API Server 的 HTTP 方法，注：本模块只用这四种 */
export type KubernetesMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** 实际使用的协议 */
export type KubernetesProtocol = 'http' | 'https';

/** 鉴权方式，注：由「有没有 token / 客户端证书」推导，见 `authModeOf` */
export type KubernetesAuthMode = 'token' | 'cert' | 'anonymous';

/** 集群连接参数 */
export interface KubernetesTarget {
  /** 实际协议，注：由端点前缀决定 */
  protocol: KubernetesProtocol;
  /** 主机名或 IP */
  host: string;
  /** 端口 */
  port: number;
  /** CA 证书 PEM，空串表示用系统根证书 */
  ca: string;
  /** 客户端证书 PEM */
  cert: string;
  /** 客户端私钥 PEM，注：调用方传入的是**解密后**的明文 */
  key: string;
  /** ServiceAccount Token，注：调用方传入的是**解密后**的明文 */
  token: string;
  /** 是否校验证书链与主机名 */
  verify: boolean;
  /** 默认命名空间 */
  namespace: string;
}

/** 凭据字段，注：与实体列一一对应 */
export interface KubernetesCredentialOptions {
  /** CA 证书 PEM */
  ca?: string;
  /** 客户端证书 PEM */
  cert?: string;
  /** 客户端私钥 PEM */
  key?: string;
  /** ServiceAccount Token */
  token?: string;
  /** 是否校验证书链，缺省 true */
  verify?: boolean;
}

/** 请求参数 */
export interface KubernetesRequestInit {
  /** 请求方式，缺省 `GET` */
  method?: KubernetesMethod;
  /** 请求正文，非空时按 JSON 发送 */
  body?: unknown;
  /** 正文类型，缺省 `application/json`；PATCH 用 `application/merge-patch+json` */
  contentType?: string;
  /** 超时（毫秒），缺省 `KUBERNETES_TIMEOUT` */
  timeout?: number;
  /** 是否原样返回文本，注：`/healthz` 返回的就是裸文本 `ok` */
  raw?: boolean;
}

/** 端点解析结果，注：只描述「连哪里」，不含凭据 */
export interface KubernetesEndpoint {
  /** 端点里写的协议前缀 */
  scheme: KubernetesProtocol;
  /** 主机名或 IP */
  host: string;
  /** 端口，注：未写时按惯例取 6443 */
  port: number;
}

/**
 * 解析 API Server 地址
 *
 * 注 1：只接受 `http://` / `https://` 两种前缀 —— Kubernetes 的 API 恒为 HTTP 语义，
 * 没有 `tcp://` 这种写法
 * 注 2：`http://` 只对「本机 `kubectl proxy`」有意义（它自带凭据、监听 127.0.0.1），
 * 明文访问远端 API Server 等于把 token 明文发出去，故服务层要求用户显式确认
 * 注 3：主机名不支持 IPv6 字面量（`[::1]`），家用场景用不到，需要时再补
 *
 * @param endpoint 库中存的地址
 * @returns 解析结果
 * @throws UnprocessableEntityException 地址格式不正确时抛出
 */
export function parseEndpoint(endpoint: string): KubernetesEndpoint {
  /** 地址匹配结果 */
  const matched = /^(http|https):\/\/([^/:?#\s]+)(?::(\d{1,5}))?$/.exec(
    (endpoint ?? '').trim(),
  );
  if (matched === null) {
    throw new UnprocessableEntityException(
      '集群地址格式不正确，应为 https://主机:端口（如 https://192.168.1.3:6443）！',
    );
  }
  /** 端口 */
  const port = matched[3] ? Number(matched[3]) : 6443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnprocessableEntityException('集群地址的端口不正确！');
  }
  return {
    scheme: matched[1] as KubernetesProtocol,
    host: matched[2],
    port,
  };
}

/**
 * 组装连接参数
 *
 * @param endpoint 库中存的地址
 * @param options 凭据与校验开关
 * @param namespace 默认命名空间
 * @returns 连接参数
 */
export function kubernetesTargetOf(
  endpoint: string,
  options: KubernetesCredentialOptions = {},
  namespace = '',
): KubernetesTarget {
  /** 端点解析结果 */
  const parsed = parseEndpoint(endpoint);
  return {
    protocol: parsed.scheme,
    host: parsed.host,
    port: parsed.port,
    ca: options.ca ?? '',
    cert: options.cert ?? '',
    key: options.key ?? '',
    token: options.token ?? '',
    verify: options.verify ?? true,
    namespace,
  };
}

/**
 * 判断连接是否为明文
 *
 * 注：明文访问远端 API Server 会把 token 与全部响应内容暴露在链路上，调用方必须要求
 * 用户显式确认后才能使用
 *
 * @param target 连接参数
 * @returns 明文时为 true
 */
export function isInsecure(target: Pick<KubernetesTarget, 'protocol'>): boolean {
  return target.protocol === 'http';
}

/**
 * 取实际使用的鉴权方式
 *
 * 注：token 与客户端证书可以同时配置 —— 托管集群偶尔会给「证书 + token」两套，
 * 只要 token 在就按 token 上报（请求里两个都会带，由 API Server 决定认哪个）
 *
 * @param target 连接参数
 * @returns 鉴权方式
 */
export function authModeOf(
  target: Pick<KubernetesTarget, 'token' | 'cert'>,
): KubernetesAuthMode {
  if (target.token !== '') {
    return 'token';
  }
  return target.cert !== '' ? 'cert' : 'anonymous';
}

/**
 * 请求 Kubernetes API Server
 *
 * 注 1：**不使用 `fetch`** —— 它不能给单次请求注入 `ca` / `cert` / `key`，而自建集群
 * 几乎都用自签 CA；本模块只用 `node:http` / `node:https`，与 `docker.request.ts` 同一做法
 * 注 2：非 2xx **不抛网络错**，按 API Server 的状态码原样转 `HttpException` 透传
 * （403 权限不足、404 资源不存在、409 冲突都要让用户看见，不能一律吞成 500）
 * 注 3：与 Docker 不同，Kubernetes 的路径**没有版本前缀** —— 版本段就在路径里
 * （`/api/v1/...`、`/apis/apps/v1/...`），不要自作聪明加 `/v1` 之类的前缀
 *
 * @param target 连接参数
 * @param path 接口路径（可含查询串），以 `/` 开头
 * @param init 请求方式、正文、正文类型、超时
 * @returns 响应正文，注：空正文时得到 `undefined`
 */
export function kubernetesRequest<T = unknown>(
  target: KubernetesTarget,
  path: string,
  init: KubernetesRequestInit = {},
): Promise<T> {
  /** 目标路径 */
  const fullPath = path.startsWith('/') ? path : `/${path}`;
  /** 请求正文 */
  const payload =
    init.body === undefined ? undefined : JSON.stringify(init.body);
  /** 请求头，注：只有带正文时才声明 Content-Type */
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (target.token !== '') {
    headers['Authorization'] = `Bearer ${target.token}`;
  }
  if (payload !== undefined) {
    headers['Content-Type'] = init.contentType ?? 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  /** 请求选项 */
  const options: HttpsRequestOptions = {
    host: target.host,
    port: target.port,
    path: fullPath,
    method: init.method ?? 'GET',
    headers,
  };
  /** 超时（毫秒） */
  const timeout = init.timeout ?? KUBERNETES_TIMEOUT;

  return new Promise<T>((resolve, reject) => {
    /** 是否已结束，注：destroy 之后仍可能收到 error 事件，需防重复结算 */
    let settled = false;
    /** 是否因超时而销毁 */
    let timedOut = false;

    /**
     * 失败收尾
     *
     * @param err 原始异常
     */
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timedOut) {
        reject(
          new HttpException(
            `集群响应超时（${timeout} 毫秒）！`,
            HttpStatus.GATEWAY_TIMEOUT,
          ),
        );
        return;
      }
      reject(
        new HttpException(
          `集群请求失败：${err.message}`,
          HttpStatus.BAD_GATEWAY,
        ),
      );
    };

    /**
     * 成功 / 业务失败收尾
     *
     * @param status 状态码
     * @param statusText 状态文案
     * @param text 响应正文
     */
    const settle = (status: number, statusText: string, text: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (status < 200 || status >= 300) {
        reject(
          new HttpException(
            kubernetesMessageOf(text, statusText),
            status >= 400 ? status : HttpStatus.BAD_GATEWAY,
          ),
        );
        return;
      }
      if (init.raw) {
        resolve(text as T);
        return;
      }
      resolve(parseBody(text) as T);
    };

    /** 响应处理 */
    const onResponse = (res: IncomingMessage): void => {
      /** 正文分片 */
      const chunks: Buffer[] = [];
      /** 已累积字节数 */
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= KUBERNETES_MAX_BODY) {
          return;
        }
        /** 剩余可写字节 */
        const rest = KUBERNETES_MAX_BODY - size;
        /** 本片实际写入部分 */
        const part = chunk.length > rest ? chunk.subarray(0, rest) : chunk;
        chunks.push(part);
        size += part.length;
      });
      res.on('end', () =>
        settle(
          res.statusCode ?? 0,
          res.statusMessage ?? '',
          Buffer.concat(chunks).toString('utf8'),
        ),
      );
      res.on('error', fail);
    };

    /** 请求对象 */
    let req: ClientRequest;
    try {
      req =
        target.protocol === 'https'
          ? httpsRequest({ ...options, ...tlsOptionsOf(target) }, onResponse)
          : httpRequest(options, onResponse);
    } catch (err) {
      // 注：证书与私钥不匹配、CA 无法解析这类问题会在**构造请求时同步抛出**
      // （OpenSSL 报 `key values mismatch`），此时还没进入网络阶段。
      // 按「客户端参数不对」处理（422），而不是让它冒成 500
      settled = true;
      reject(
        new HttpException(
          `集群连接参数不正确：${err instanceof Error ? err.message : String(err)}`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        ),
      );
      return;
    }
    req.setTimeout(timeout, () => {
      timedOut = true;
      req.destroy(new Error('timeout'));
    });
    req.on('error', fail);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * 取 TLS 选项
 *
 * 注 1：空串不能直接传给 `ca` / `cert` / `key` —— Node 会把空串当成「提供了空的证书」，
 * 自签场景下反而连不上；故只在非空时赋值
 * 注 2：导出是为了能单测「证书有没有真的进到请求里」—— `node:https.request` 的入参
 * 没法在 ESM 下打桩，只能把这个纯函数单独钉住
 *
 * @param target 连接参数
 * @returns TLS 选项
 */
export function tlsOptionsOf(target: KubernetesTarget): HttpsRequestOptions {
  /** TLS 选项 */
  const options: HttpsRequestOptions = {
    rejectUnauthorized: target.verify,
  };
  if (target.ca) {
    options.ca = target.ca;
  }
  if (target.cert) {
    options.cert = target.cert;
  }
  if (target.key) {
    options.key = target.key;
  }
  return options;
}

/**
 * 解析响应正文
 *
 * @param text 响应文本
 * @returns 解析结果，注：空正文得到 `undefined`，非 JSON 正文原样返回
 */
function parseBody(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 注：`/healthz` 返回 `ok`、反向代理的错误页是 HTML，两者都原样带回
    return text;
  }
}

/**
 * 提取错误信息
 *
 * 注：Kubernetes 的错误正文是 `Status` 对象（`{"kind":"Status","message":"...","reason":"..."}`）；
 * 优先取 `message`，没有时退回 `reason`，再退回状态文案
 *
 * @param text 响应正文
 * @param fallback 兜底文案
 * @returns 可直接展示的错误信息
 */
export function kubernetesMessageOf(text: string, fallback: string): string {
  if (text.trim() !== '') {
    try {
      /** 解析后的正文 */
      const body = JSON.parse(text) as unknown;
      if (body !== null && typeof body === 'object') {
        /** 错误信息 */
        const message = (body as { message?: unknown }).message;
        if (typeof message === 'string' && message !== '') {
          return message;
        }
        /** 错误原因 */
        const reason = (body as { reason?: unknown }).reason;
        if (typeof reason === 'string' && reason !== '') {
          return reason;
        }
      }
    } catch {
      // 非 JSON 正文，走下面的原文兜底
    }
    return text;
  }
  return fallback || '集群请求失败！';
}
