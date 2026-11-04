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
 * 注：宿主机不可达时必须尽快失败，不能让浏览器一直挂着；`pull` / `prune` 这类慢操作
 * 由调用方通过 `init.timeout` 单独放宽
 */
export const DOCKER_TIMEOUT = 15000;

/** 慢操作超时（毫秒），注：镜像拉取 / 清理这类分钟级操作使用 */
export const DOCKER_SLOW_TIMEOUT = 300000;

/**
 * 日志跟随的静默超时（毫秒）
 *
 * 注 1：首字节超时沿用 `DOCKER_TIMEOUT`（宿主机不可达要尽快失败），但**已建立的跟随流**
 * 不能按 15 秒计 —— 一个安静的服务十几分钟没有输出是完全正常的
 * 注 2：也不能完全不设：网线被拔掉时 TCP 可能要很久才感知，会留下僵尸请求。
 * 30 分钟是「正常静默」与「链路已死」之间的折中
 */
export const DOCKER_STREAM_IDLE = 30 * 60 * 1000;

/** 错误正文的收集上限（字节），注：非 2xx 时只用来取 `message`，不需要整份读完 */
const DOCKER_ERROR_BODY_MAX = 64 * 1024;

/**
 * 响应体累积上限（字节）
 *
 * 注：`/containers/json` 在容器多时可达数 MB，`/containers/{id}/json` 单条也能到几十 KB；
 * 超过上限就截断（并在结果里体现），避免一次列表请求把 api 进程内存打满
 */
export const DOCKER_MAX_BODY = 2 * 1024 * 1024;

/** daemon 的 HTTP 方法，注：本模块只用这四种 */
export type DockerMethod = 'GET' | 'POST' | 'DELETE' | 'HEAD';

/** 实际使用的协议 */
export type DockerProtocol = 'http' | 'https';

/** 宿主机连接参数 */
export interface DockerTarget {
  /** 实际协议，注：由端点前缀 + `tls` 共同决定，见 `parseEndpoint` */
  protocol: DockerProtocol;
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
  /** 是否校验证书链与主机名 */
  verify: boolean;
  /** API 版本（如 `1.47`），空串表示不拼版本前缀 */
  apiVersion: string;
}

/** TLS 相关字段，注：与实体列一一对应 */
export interface DockerTlsOptions {
  /** CA 证书 PEM */
  ca?: string;
  /** 客户端证书 PEM */
  cert?: string;
  /** 客户端私钥 PEM */
  key?: string;
  /** 是否校验证书链，缺省 true */
  verify?: boolean;
}

/** 请求参数 */
export interface DockerRequestInit {
  /** 请求方式，缺省 `GET` */
  method?: DockerMethod;
  /** 请求正文，非空时按 JSON 发送 */
  body?: unknown;
  /** 超时（毫秒），缺省 `DOCKER_TIMEOUT` */
  timeout?: number;
  /** 是否原样返回文本，注：`/_ping` 返回的就是裸文本 `OK` */
  raw?: boolean;
}

/** 端点解析结果，注：只描述「连哪里」，不含证书 */
export interface DockerEndpoint {
  /** 端点里写的协议前缀 */
  scheme: 'tcp' | 'http' | 'https';
  /** 主机名或 IP */
  host: string;
  /** 端口，注：未写时按协议取 2376 / 2375 */
  port: number;
}

/**
 * 解析 daemon 地址
 *
 * 注 1：只接受 `tcp://` / `http://` / `https://` 三种前缀 —— `unix://` **刻意不支持**
 * （api 与 daemon 同机时也应显式走 tcp + TLS，避免把宿主 socket 交给服务进程）
 * 注 2：`tcp://` 的实际协议由 `tls` 决定：开了 TLS 走 https（Docker 默认 2376），
 * 否则走 http（默认 2375）；`http://` / `https://` 则以前缀为准
 * 注 3：主机名不支持 IPv6 字面量（`[::1]`），家用场景用不到，需要时再补
 *
 * @param endpoint 库中存的地址
 * @param tls 是否启用 TLS 客户端证书
 * @returns 解析结果
 * @throws UnprocessableEntityException 地址格式不正确时抛出
 */
export function parseEndpoint(endpoint: string, tls: boolean): DockerEndpoint {
  /** 地址匹配结果 */
  const matched =
    /^(tcp|http|https):\/\/([^/:?#\s]+)(?::(\d{1,5}))?$/.exec(
      (endpoint ?? '').trim(),
    );
  if (matched === null) {
    throw new UnprocessableEntityException(
      'Docker 地址格式不正确，应为 tcp://主机:端口 或 https://主机:端口！',
    );
  }
  /** 协议前缀 */
  const scheme = matched[1] as DockerEndpoint['scheme'];
  /** 端口，注：未写时按「TLS 走 2376、明文走 2375」的惯例给默认值 */
  const port = matched[3]
    ? Number(matched[3])
    : tls || scheme === 'https'
      ? 2376
      : 2375;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnprocessableEntityException('Docker 地址的端口不正确！');
  }
  return { scheme, host: matched[2], port };
}

/**
 * 组装连接参数
 *
 * @param endpoint 库中存的地址
 * @param tls 是否启用 TLS 客户端证书
 * @param options TLS 证书与校验开关
 * @param apiVersion API 版本，空串表示不拼版本前缀
 * @returns 连接参数
 */
export function dockerTargetOf(
  endpoint: string,
  tls: boolean,
  options: DockerTlsOptions = {},
  apiVersion = '',
): DockerTarget {
  /** 端点解析结果 */
  const parsed = parseEndpoint(endpoint, tls);
  /** 实际协议，注：`tcp://` 看 tls 开关，其余以前缀为准 */
  const protocol: DockerProtocol =
    parsed.scheme === 'tcp'
      ? tls
        ? 'https'
        : 'http'
      : parsed.scheme === 'https'
        ? 'https'
        : 'http';
  return {
    protocol,
    host: parsed.host,
    port: parsed.port,
    ca: options.ca ?? '',
    cert: options.cert ?? '',
    key: options.key ?? '',
    verify: options.verify ?? true,
    apiVersion,
  };
}

/**
 * 判断连接是否为明文
 *
 * 注：明文 daemon（2375）没有鉴权，局域网内任何人都能控制宿主机，故调用方必须要求
 * 用户显式确认后才能使用
 *
 * @param target 连接参数
 * @returns 明文时为 true
 */
export function isInsecure(target: Pick<DockerTarget, 'protocol'>): boolean {
  return target.protocol === 'http';
}

/**
 * 构造请求选项
 *
 * 注 1：**版本前缀在这里拼** —— daemon 在不带 `/v1.x` 时按最低兼容版本（1.24）应答，
 * 新字段会缺失；调用方传的路径一律不带前缀
 * 注 2：抽出成导出函数是为了让流式入口（`dockerStream`）复用同一套拼装，
 * 而不是复制一份 —— 2026-11-03 那次「证书配错只在一条路径上校验」的教训
 *
 * @param target 连接参数
 * @param path 接口路径（可含查询串），以 `/` 开头
 * @param method 请求方式
 * @param payload 已序列化的请求正文，缺省表示无正文
 * @returns 请求选项
 */
export function requestOptionsOf(
  target: DockerTarget,
  path: string,
  method: DockerMethod = 'GET',
  payload?: string,
): HttpsRequestOptions {
  /** 版本前缀 */
  const prefix = target.apiVersion ? `/v${target.apiVersion}` : '';
  /** 请求头，注：只有带正文时才声明 Content-Type */
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  return {
    host: target.host,
    port: target.port,
    path: `${prefix}${path.startsWith('/') ? path : `/${path}`}`,
    method,
    headers,
  };
}

/**
 * 发起请求
 *
 * 注：`https.request()` 在证书与私钥不匹配、CA 无法解析时会在**构造阶段同步抛**
 * （OpenSSL 报 `key values mismatch`），此时还没进入网络；调用方必须 catch 它并转成 422，
 * 否则会冒成 500「服务器内部错误」，用户看不出是哪个框填错了
 *
 * @param target 连接参数
 * @param options 请求选项
 * @param onResponse 响应回调
 * @returns 请求对象
 */
function createRequest(
  target: DockerTarget,
  options: HttpsRequestOptions,
  onResponse: (res: IncomingMessage) => void,
): ClientRequest {
  return target.protocol === 'https'
    ? httpsRequest({ ...options, ...tlsOptionsOf(target) }, onResponse)
    : httpRequest(options, onResponse);
}

/**
 * 把构造期的同步异常转成 422
 *
 * @param err 原始异常
 * @returns 可直接抛出的异常
 */
function connectionErrorOf(err: unknown): HttpException {
  return new HttpException(
    `宿主机连接参数不正确：${err instanceof Error ? err.message : String(err)}`,
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/**
 * 请求 Docker daemon
 *
 * 注 1：**不使用 `fetch`** —— 它既不能给单次请求注入 `ca` / `cert` / `key`，也不支持
 * `unix://` socket；本模块只用 `node:http` / `node:https`，与 `kong.request.ts`（用 fetch）
 * 的差异是刻意的，不是遗漏
 * 注 2：非 2xx **不抛网络错**，按 Docker 的状态码原样转成 `HttpException` 透传给前端，
 * 避免 daemon 的 404 / 409 被吞成 500
 * 注 3：`304 Not Modified` 在 Docker 里表示「已在目标状态」（如 start 一个已启动的容器），
 * 按成功处理并返回 `undefined`
 * 注 4：`follow=1` 这类不会结束的响应**不能走这里**（Promise 永不 resolve），用 `dockerStream`
 *
 * @param target 连接参数
 * @param path 接口路径（可含查询串），以 `/` 开头；**不要**自己带版本前缀
 * @param init 请求方式、正文、超时
 * @returns 响应正文，注：204 / 304 为空正文时得到 `undefined`
 */
export function dockerRequest<T = unknown>(
  target: DockerTarget,
  path: string,
  init: DockerRequestInit = {},
): Promise<T> {
  /** 请求正文 */
  const payload =
    init.body === undefined ? undefined : JSON.stringify(init.body);
  /** 请求选项 */
  const options = requestOptionsOf(target, path, init.method ?? 'GET', payload);
  /** 超时（毫秒） */
  const timeout = init.timeout ?? DOCKER_TIMEOUT;

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
            `宿主机响应超时（${timeout} 毫秒）！`,
            HttpStatus.GATEWAY_TIMEOUT,
          ),
        );
        return;
      }
      reject(
        new HttpException(
          `宿主机请求失败：${err.message}`,
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
      // 注：Docker 用 304 表示「已处于目标状态」，不是错误
      if (status === 304) {
        resolve(undefined as T);
        return;
      }
      if (status < 200 || status >= 300) {
        reject(
          new HttpException(
            dockerMessageOf(text, statusText),
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
        if (size >= DOCKER_MAX_BODY) {
          return;
        }
        /** 剩余可写字节 */
        const rest = DOCKER_MAX_BODY - size;
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
      req = createRequest(target, options, onResponse);
    } catch (err) {
      // 注：证书与私钥不匹配、CA 无法解析这类问题会在**构造请求时同步抛出**
      // （OpenSSL 报 `key values mismatch`），此时还没进入网络阶段。
      // 按「客户端参数不对」处理（422），而不是让它冒成 500 —— 用户该看到「证书配错了」，
      // 而不是「服务器内部错误」
      settled = true;
      reject(connectionErrorOf(err));
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
 * 流式响应的句柄
 *
 * 注：`chunks` 是**原始字节**，解帧（Docker 的 8 字节头）与拼行由调用方负责 ——
 * 请求层不该知道日志的语义，否则「拉镜像进度」「事件流」这些后续复用都得改这里
 */
export interface DockerStreamHandle {
  /** 响应分片，注：流结束或被 `abort()` 后迭代器正常结束 */
  chunks: AsyncIterable<Buffer>;
  /** 主动终止，注：必须调用，否则 daemon 侧会一直挂着一个跟随者 */
  abort: () => void;
}

/** 流式请求参数 */
export interface DockerStreamInit {
  /** 首字节超时（毫秒），缺省 `DOCKER_TIMEOUT` */
  timeout?: number;
  /** 已建立后的静默超时（毫秒），缺省 `DOCKER_STREAM_IDLE` */
  idleTimeout?: number;
}

/**
 * 读取响应分片
 *
 * 注：主动终止时 `for await` 会抛 `ECONNRESET`（socket 被销毁），那是预期行为，
 * 不能当成错误抛给上层 —— 否则用户关掉页面时控制台会多一条无意义的异常；
 * 静默超时则要给出明确原因（「30 分钟没有数据」比「ECONNRESET」有用得多）
 *
 * @param res 响应
 * @param stopReason 终止原因，注：读时求值，避免闭包拿到过期值
 * @param idleSeconds 静默超时的秒数，仅用于文案
 * @returns 分片
 */
async function* chunksOf(
  res: IncomingMessage,
  stopReason: () => 'user' | 'idle' | '',
  idleSeconds: number,
): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of res) {
      yield chunk as Buffer;
    }
  } catch (err) {
    /** 终止原因 */
    const reason = stopReason();
    if (reason === 'user') {
      return;
    }
    if (reason === 'idle') {
      throw new HttpException(
        `宿主机日志流已静默 ${idleSeconds} 秒，已断开！`,
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    throw new HttpException(
      `读取宿主机响应失败：${err instanceof Error ? err.message : String(err)}`,
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/**
 * 请求 Docker daemon 的流式接口（`follow=1` 这类不会结束的响应）
 *
 * 注 1：**与 `dockerRequest` 刻意分开** —— 后者的契约是「拿到完整正文再返回」，
 * `follow` 会让它永远不 resolve；给同一个函数加 `stream` 分支只会让两条路径的
 * 超时与错误语义互相污染
 * 注 2：解析成 `Promise` 而非直接返回句柄，是为了让「首字节之前」的失败（连不上、
 * 证书不匹配、404）能以 reject 的形式暴露给调用方 —— 提交前的失败和流中的失败处理方式不同
 * 注 3：非 2xx 会先把错误体读完再抛（daemon 的错误是 `{"message":...}`），
 * 绝不能把错误体当成日志行推给前端
 *
 * @param target 连接参数
 * @param path 接口路径（可含查询串），以 `/` 开头；**不要**自己带版本前缀
 * @param init 超时
 * @returns 流句柄
 */
export function dockerStream(
  target: DockerTarget,
  path: string,
  init: DockerStreamInit = {},
): Promise<DockerStreamHandle> {
  /** 请求选项 */
  const options = requestOptionsOf(target, path, 'GET');
  /** 首字节超时 */
  const timeout = init.timeout ?? DOCKER_TIMEOUT;
  /** 静默超时 */
  const idleTimeout = init.idleTimeout ?? DOCKER_STREAM_IDLE;

  return new Promise<DockerStreamHandle>((resolve, reject) => {
    /** 是否已结算 */
    let settled = false;
    /** 流结束的原因，注：主动关闭要静默收尾，静默超时要给出可读提示 */
    let stopReason: 'user' | 'idle' | '' = '';
    /** 连接阶段是否因超时而销毁 */
    let connectTimedOut = false;
    /** 请求对象 */
    let req: ClientRequest;

    /**
     * 失败收尾
     *
     * 注：只有「连接阶段的超时」才报超时 —— 连接被拒绝（`ECONNREFUSED`）与超时是两回事，
     * 混成一句「响应超时」会让用户去查网络，而实际问题可能是端口填错了
     *
     * @param err 原始异常
     */
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (connectTimedOut) {
        reject(
          new HttpException(
            `宿主机响应超时（${timeout} 毫秒）！`,
            HttpStatus.GATEWAY_TIMEOUT,
          ),
        );
        return;
      }
      reject(
        new HttpException(
          `宿主机请求失败：${err.message}`,
          HttpStatus.BAD_GATEWAY,
        ),
      );
    };

    /**
     * 终止请求
     *
     * @param reason 终止原因
     */
    const destroyWith = (reason: 'user' | 'idle'): void => {
      stopReason = reason;
      req.destroy();
    };

    /** 响应处理 */
    const onResponse = (res: IncomingMessage): void => {
      /** 状态码 */
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        // 非 2xx：读完错误体（有上限）再抛，状态码原样透传
        /** 错误正文分片 */
        const chunks: Buffer[] = [];
        /** 已收集字节 */
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= DOCKER_ERROR_BODY_MAX) {
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          reject(
            new HttpException(
              dockerMessageOf(
                Buffer.concat(chunks).toString('utf8'),
                res.statusMessage ?? '',
              ),
              status >= 400 ? status : HttpStatus.BAD_GATEWAY,
            ),
          );
        });
        res.on('error', fail);
        return;
      }
      // 已建立：把「连接超时」换成长时间的静默超时
      settled = true;
      req.setTimeout(idleTimeout, () => destroyWith('idle'));
      resolve({
        chunks: chunksOf(res, () => stopReason, Math.round(idleTimeout / 1000)),
        abort: () => destroyWith('user'),
      });
    };

    try {
      req = createRequest(target, options, onResponse);
    } catch (err) {
      settled = true;
      reject(connectionErrorOf(err));
      return;
    }
    req.setTimeout(timeout, () => {
      connectTimedOut = true;
      req.destroy(new Error('timeout'));
    });
    req.on('error', fail);
    // 注：GET 无正文，直接 end
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
export function tlsOptionsOf(target: DockerTarget): HttpsRequestOptions {
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
    // 注：`/_ping` 返回 `OK`、反向代理的错误页是 HTML，两者都原样带回
    return text;
  }
}

/**
 * 提取错误信息
 *
 * 注：Docker 的错误正文恒为 `{"message": "..."}`；解析不出来时退回状态文案
 *
 * @param text 响应正文
 * @param fallback 兜底文案
 * @returns 可直接展示的错误信息
 */
export function dockerMessageOf(text: string, fallback: string): string {
  if (text !== '') {
    try {
      /** 解析后的正文 */
      const body = JSON.parse(text) as unknown;
      if (
        body !== null &&
        typeof body === 'object' &&
        'message' in body &&
        typeof (body as { message: unknown }).message === 'string'
      ) {
        return (body as { message: string }).message;
      }
    } catch {
      // 非 JSON 正文，走下面的原文兜底
    }
    return text;
  }
  return fallback || '宿主机请求失败！';
}
