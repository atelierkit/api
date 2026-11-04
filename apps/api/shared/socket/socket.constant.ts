// 外部依赖
import type { GatewayMetadata } from '@nestjs/websockets';

/**
 * socket.io 服务端选项 —— **所有网关必须共用这一份，别在网关里各写一套**
 *
 * 注 1（致命）：Nest 只按 `{ port, path }` 给 socket.io `Server` 去重（`SocketsContainer` 的哈希键）。
 *   某个网关的 `path` 与其它网关不一致（漏写、或用了 `@WebSocketGateway()` 的默认空对象）时会
 *   **再建一个 `Server`** 挂到同一个 httpServer 上，于是 `upgrade` 事件有两个监听者 ⇒
 *   同一个升级请求被处理两次 ⇒ ws 抛
 *   `server.handleUpgrade() was called more than once with the same socket`，异常从事件回调里逃逸，
 *   **整个进程退出**（不是单个连接失败）。
 *   实测：`object-hash` 对 `{ port: 0, path: undefined }` 与 `{ port: 0, path: '/socket.io' }`
 *   给出不同哈希 ⇒ 去重不命中。新增网关时**必须**展开本常量。
 *
 * 注 2：去重命中后**只有第一个注册的网关的选项生效** —— `cors` / `maxHttpBufferSize` 都是 engine.io
 *   Server 级配置。各写一份的话，`/remote` 的 2 MB 上限会被先注册的网关的默认 1 MB 顶掉
 *   （终端里粘贴大段文本直接被断开），而且这种「选项随模块注册顺序变化」的缺陷极难复现。
 *   统一放这里，改一处即对所有网关生效。
 */
export const SOCKET_GATEWAY_OPTION: GatewayMetadata = {
  /** 握手路径，注：反向代理（nginx / Kong）要原样透传 `/socket.io`，不能剥前缀 */
  path: '/socket.io',
  /** 跨域许可，注：web 与 api 不同源，socket.io 默认不发 CORS 头 ⇒ 浏览器在握手阶段直接拦掉 */
  cors: { origin: true },
  /** 单帧上限（字节），注：远程终端粘贴大段文本需要 2 MB，engine.io 默认只有 1 MB */
  maxHttpBufferSize: 2 * 1024 * 1024,
};
