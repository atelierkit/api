# AGENTS.md

## Monorepo 结构（NestJS 标准模式）

本仓库采用 NestJS 标准 Monorepo，用 `nest build <project>` / `nest start <project>` 按项目构建与启动：

| 项目 | 类型 | 说明 |
| --- | --- | --- |
| `apps/api` | application | HTTP 接口服务，监听端口（默认 80，由 `PORT` 覆盖）；`apps/api/shared/` 为共用领域模块 |
| `apps/worker` | application | 后台常驻服务，**不监听端口**，用于定时任务 / 队列消费 / 长时异步任务 |
| `libs/` | library | 可复用库（`nest g library <name>`），当前为空 |

约定：

- **新增服务**：`nest g app <name>`（生成到 `apps/`），并手动登记到根 `nest-cli.json` 的 `projects` 与根 `tsconfig.json` 的 `references`。
- **共享代码**：跨 `api` / `worker` 复用的模块下沉到 `libs/`（`nest g library <name>`），通过 tsconfig 路径别名引用。
- 每个 `apps/*/tsconfig.app.json` 必须保留 `"composite": true`（project references 依赖它，移除会导致 `lint` 报 tsconfig-error）。
- 生产产物落在 `dist/apps/<project>/`；入口为 `dist/apps/api/main.js` 与 `dist/apps/worker/main.js`。
- **再建库时**：`nest g lib <name>` 会顺手加 `"builder": "rspack"` 与 4 个 webpack 系 devDep，如无需要记得回退；且 TS 6 起
  `libs/*/tsconfig.lib.json` **必须显式 `rootDir`**（TS5011），写 `"rootDir": "./src"` 才能得到 `dist/libs/<name>/index.js` 而非多套一层的路径。
- **`apps/api/shared`**：共用领域模块（`SharedModule`：用户 / 角色 / 令牌 / 配置 / 操作·请求日志 / 缓存 / 队列 / 邮件 / 监控）。
  它随 `apps/api` 一起构建（产物 `dist/apps/api/shared/`），当前**只有 api 使用**。
  两条不受「库还是目录」影响的 ESM 铁律：内部相对导入**必须带 `.js`**；**不用桶文件（`index.ts`）互相导入**
  （ESM 下会因 TDZ 抛 `Cannot access 'X' before initialization`），一律按文件具名导入 —— `shared/index.ts` 只对外聚合，内部不反向引用它。
- **`apps/api/auth`**：**访问控制模块**（`AuthModule`），只含管理端控制器：
  角色 `/auth/role`、用户 `/auth/user`、令牌 `/auth/token`，全部用 `@Allow('admin')` 声明所需角色（鉴权由全局 `TokenGuard` 完成）。
  管理端建号/改资料走 `UserService.create` / `update` 的**覆盖实现**（用户名归一化 + 密码哈希 + 邮箱空串转 NULL），
  DTO 是 `shared/user/user.dto.ts` 的 `UserManageCreateDto` / `UserManageUpdateDto` —— 与个人端的 `UserUpdateDto` 刻意不同名，
  因为两者字段与权限边界完全不同（管理端含 `status` / `roles`）。管理端用户控制器类名叫 `AuthUserController`，
  避免与个人端 `UserController` 重名（`reqs.controller` 按类名记账，重名会让两类请求在日志里分不开）。
- **`apps/api/cloud`**：云服务模块（`CloudModule`），收「密钥 + 各站点管理」，接口前缀统一为 `cloud/`，
  全部 `@Allow('admin')`。当前四类站点（KONG / Docker / Kubernetes / 远程连接）同一套「站点 + 站点下资源」的组织方式：
  站点连接配置与 `_logs` 表落库，站点下的远端资源**不落库**。四条贯穿全模块的约定：
  1. **密钥 secret 不出库**：`KeyService.index` / `show` 都走 `PUBLIC_SELECT`（不含 `secret`），详情也不回填；服务端内部要用时才调
     `KeyService.secret(id)`；因此前端编辑表单是「留空即不改」（`KeyUpdateDto.secret` 可选，缺省表示保持原值）。
  2. **DTO 按实体/接口参数逐字段声明**：`ValidationPipe({whitelist:true})` 会静默剥掉未装饰字段，少声明一个字段的后果是
     「请求看起来成功、值没生效」。`status` 一律用 `@IsBoolean`，不能用 `@IsNotEmpty`（它对 `false` 判空）。
  3. **KONG 探测用 `fetch` 而非 `@nestjs/axios`**：本仓库不引 axios；`kongRequest()`（`kong/kong.request.ts`）
     用运行时自带的 `fetch`（非 2xx 不抛网络错），错误按 `HttpException` 原状态码透传，网关不可达转 502。站点与站点对象共用它。
  4. **TypeORM v1 的 `select` 只认对象写法**：`select: ['id', 'name', 'update.at']` 在 v1 起运行时**直接抛错**
     （`String-array "select" syntax has been removed`，在 `DbErrorFilter` 里表现为 500，单元测试用替身时发现不了）。
     嵌入列要展开成嵌套对象：`select: { id: true, update: { at: true } }`，并用 `satisfies FindOptionsSelect<Entity>` 让 TS 兜住。
- **`apps/api/cloud/kong/object`**：站点下的**对象管理**，
  接口前缀 `cloud/kong/object/`（`index` / `show` / `create` / `update` / `destroy`，全部 POST + 请求体），控制器 `KongObjectController`。
  `kongs` / `kongs_logs` 只存站点自身 —— 对象全在 Kong 那边，本仓库不落库。五条约定：
  1. **一个服务管六种对象**：Kong 的 `routes` / `services` / `consumers` / `certificates` / `plugins` / `upstreams` 在 Admin API 上是同一套 REST 形状
     （`GET|POST /{type}`、`GET|PATCH|DELETE /{type}/{id}`），故 `ObjectService` 不按类型拆；类型白名单在 `object.types.ts` 的 `KONG_OBJECT_TYPES`。
  2. **`type` / `id` 必须校验**：两者都会拼进 Admin API 路径，`type` 走 `@IsIn(KONG_OBJECT_TYPES)`，`id` 走 `@Matches` 的正则（首字符必须是字母数字，
     挡掉 `/` 与 `..`）。只写 `@IsNotEmpty` 等于把路径交给前端。
  3. **分页用 `offset` 自己拼**：Kong 的 `next` 是**完整 URL**（带 `size` 时是相对路径，无下一页时为 `null`，已实测 3.9.4），
     直接拼会变成 `http://host:8001http://...`；现在按响应里的 `offset` 逐页取（该字段只在还有下一页时出现），
     且有 `MAX_PAGES` 上限（超了报 502，不静默返回半份数据）。
  4. **证书的域名与有效期在后端解析**：Kong 的证书对象**不带有效期**（`start` / `end` 只能从 PEM 读），`object/certificate.util.ts` 用 Node 自带的
     `crypto.X509Certificate` 解析 PEM 后补在返回对象上（秒级时间戳，与 Kong 其它时间字段同口径），前端因此不需要 `node-forge`；
     解析失败返回 `null`、原样返回对象，一张脏证书不该让整页打不开。
     ⚠️ **`snis` 以 Kong 返回的为准**：Kong 3.9 的证书对象自带 `snis`（实测），它才是网关里实际生效的绑定；PEM 的 SAN 只是「证书能覆盖哪些域名」，
     两者可以不一致（一个证书覆盖多个域名、却只给其中一部分建 SNI）。故 `ObjectService.enrich` 只在 Kong 没给 `snis`（空数组 / 老版本没有该字段）时用 PEM 兜底。
  5. **仪表板读 `/` + `/status`，不读许可报告**（Kong 3.9.4 社区版实测）：`/default/license/report` 是**企业版专属**，社区版恒为 404
     `{"message":"Not found"}`。`KongService.summary()` 并行取 `/`（version / edition / hostname / node_id / lua_version / 插件数）与
     `/status`（连接数 / `database.reachable`），合并成 `KongSummary` 下发；无数据库模式（DB-less）时 `database` 段不存在，`dbReachable` 给 `null`（不适用），
     与 `false`（不可达）分开。`/plugins/enabled` 在 3.x 返回 **`{ enabled_plugins: [...] }`**（2.x 才是数组），`KongService.plugin()` 统一成 `string[]`。
- **`apps/api/cloud/docker`**：Docker 宿主机管理模块，与 KONG 站点同一套
  「站点 + 站点下资源」的组织方式：`dockers` / `dockers_logs` 存连接配置，宿主机上的容器 / 镜像 / 数据卷 / 网络
  **不落库**。接口前缀 `cloud/docker`（资源在 `cloud/docker/object/`），全部 `@Allow('admin')`。九条约定：
  1. **不用 `fetch`，用 `node:http` / `node:https`**：`fetch`（undici）既不能给单次请求注入 `ca` / `cert` / `key`，
     也不支持 unix socket；`docker.request.ts` 自己拼 `RequestOptions`，非 2xx 按 Docker 的状态码原样转
     `HttpException` 透传（`304 Not Modified` 表示「已在目标状态」，按成功处理）。**与 `kong.request.ts` 用 fetch 的差异是刻意的**：KONG 不需要注入客户端证书。
  2. **端点只支持 `tcp://` / `http://` / `https://`，`unix://` 刻意不支持**：api 与 daemon 同机也应走 tcp + TLS，
     不把宿主 socket 交给服务进程。端口省略时按「TLS 走 2376、明文走 2375」补默认值。
  3. **不做路径透传**：Docker 的 `/containers/{id}/exec`、`/build`、`/swarm/init` 等价于宿主 root，
     故 `object.types.ts` 的 `DOCKER_OBJECT_ACTIONS` 把「类型 × 动作」映射成固定方法与路径，`object.dto.ts` 只校验
     类型白名单与动作白名单，`value` 也只有 `force` / `timeout` 两个平铺字段（**不要**改回 `Record<string, unknown>` 透传）。
  4. **客户端私钥加密落库、永不下发**：`key` 列存 `enc:v1:` 密文（`encryptSecret` + `SETTING_KEY`，与邮件授权码同一套），
     `index` / `show` / `log` 走 `view()` 把 `key` 清成空串、另回 `hasKey`；编辑时私钥留空或提交 `***` 都表示「不修改」，
     只有**显式** `tls: false` 才连带清空证书三件套（否则改个说明就会把私钥抹掉）。
  5. **明文连接必须显式确认**：`allowInsecure` 是 DTO 字段但**不落库**，服务层在「新建」或「提交了 endpoint / tls」时校验，
     缺它直接 422 —— 只改说明不该被要求重新确认一次。
  6. **列表做投影**：`/containers/json` 单个容器 30+ 字段，`ObjectService.index` 只下发展示需要的字段；
     容器详情**不下发 Env**（常见把密码写在环境变量里）。⚠️ `GET /networks` **不返回** `Containers` 明细
     （daemon 29.x 实测该字段整个缺失，只有 `GET /networks/{id}` 才有），网络页的容器数必须由
     `/containers/json?all=1` 的 `NetworkSettings.Networks` 反推（`networkCountsOf`）；网络对象的 `Created`
     是纳秒精度 RFC3339，直接下发原始字符串、由前端按毫秒解析。
  7. **API 版本先探测再拼前缀**：不带 `/v1.x` 时 daemon 按最低兼容版本（1.24）应答、新字段缺失；`DockerService` 取
     `GET /version` 的 `ApiVersion` 并按「协议 + 主机 + 端口 + 校验开关」缓存 5 分钟，配置了 `apiVersion` 则以配置为准。
  8. **启用 TLS 时保存前就校验证书**（`docker.cert.ts`）：用 `X509Certificate` / `createPrivateKey` 归一成 SPKI 比公钥指纹，
     并在「客户端证书框里有多张证书」时直接拒绝。把 `ca.pem` 拼在 `cert.pem` 前面一起粘进来时 Node 只取第一张，
     握手会报 `key values mismatch`，界面上完全看不出原因，所以必须在保存阶段拦。另外 `httpsRequest()` 在证书/私钥不匹配时是
     **构造阶段同步抛错**（还没进网络），`dockerRequest` 必须把它转成 422 可读文案，否则会冒成 500「服务器内部错误」。
  9. **`verify` 同时管「证书链」与「主机名」**：自签场景下即使把服务端证书当 CA 填进去，只要它没有
     `subjectAltName=IP:<地址>`，仍会报 `ERR_TLS_CERT_ALTNAME_INVALID`（真机实测）。家用环境要么关 `verify`
     （传输仍加密，只是不校验对端身份），要么重签服务端证书并带上 SAN —— 别指望「CA 填对了就能过」。
- **`apps/api/cloud/kubernetes`**：Kubernetes 集群管理模块，与 KONG / Docker 同一套
  「站点 + 站点下资源」的组织方式：`kubernetes` / `kubernetes_logs` 存连接凭据，集群里的命名空间 / 节点 / Pod /
  工作负载 / Service **不落库**。接口前缀 `cloud/kubernetes`（资源在 `cloud/kubernetes/object/`），全部 `@Allow('admin')`。
  九条约定：
  1. **Token 与客户端证书都支持，二者可并存**：`token` 与 `key` 两列都是 `enc:v1:` 密文（同一套 `SETTING_KEY`），
     `index` / `show` / `log` 走 `view()` 把两者清空、另回 `hasToken` / `hasKey`。**必须至少有一种凭据**，
     匿名连接只会让用户以为「集群是空的」（实际是 403 被吞成空列表），故服务层直接 422。
  2. **切鉴权方式要能清掉旧的**：详情不下发凭据 ⇒「空串」只能表示「不修改」，所以 `KubernetesUpdateDto` 有
     `clearToken` / `clearCert` 两个显式开关。这不是多余功能：API Server 的鉴权链是「先试 Bearer」，
     一个失效的旧 Token 会直接 401，**不会**回退到客户端证书。
  3. **不用 `fetch`，用 `node:http` / `node:https`**：自建集群几乎都是自签 CA，必须能按请求注入 `ca` / `cert` / `key`；
     非 2xx 按 API Server 的状态码原样转 `HttpException`（403 权限不足 / 404 不存在 / 409 冲突都要透传）。
  4. **路径自带组与版本，不要加前缀**：核心组 `/api/v1/...`、apps 组 `/apis/apps/v1/...`。这与 Docker 的
     `/v1.47` 前缀是两套东西，别照搬。
  5. **不做路径透传**：`object.types.ts` 的 `KUBERNETES_OBJECT_ACTIONS` 把「类型 × 动作」映射成固定方法与路径，
     动作只有 `remove` / `scale` / `restart` / `cordon` / `uncordon`；DTO 只收 `replicas` / `gracePeriod` 两个平铺字段。
     **扩缩容缺 `replicas` 直接 400** —— 默默按 0 处理等于把服务缩到零。
  6. **命名空间两种语义**：列表允许空串（全部命名空间，走 `/api/v1/pods` 这种集群级路径）；
     动作与详情必须落到具体命名空间，取「提交值 → 集群配置的 `namespace` → `default`」。
  7. **`servicePortsOf` / `podStatusOf` 这类投影是纯函数且单独测**：Pod 的容器等待原因优先于阶段
     （`CrashLoopBackOff` 不能被 `Running` 盖掉），`Completed` 不算异常；节点被 cordon 时状态显示
     `SchedulingDisabled`（即使它 Ready），角色只从 `node-role.kubernetes.io/*` 标签取、没有就留空。
  8. **概览用集群级列表**：`KubernetesService.summary` 并行取 `/version` + `/api/v1/{nodes,namespaces,pods}`
     + `/apis/apps/v1/deployments` + `/api/v1/services`，任一失败按原状态码抛；因此 ServiceAccount 需要
     cluster 级 list 权限，权限不足时给 403 由用户自行降级（不做「悄悄少几块」的兜底）。
  9. **证书 PEM 校验复用 `docker/docker.cert.ts`**：它只依赖 `node:crypto`，与 Docker 协议无关；
     新建 / 换证书时先校验「一张证书 + 可解析 + 与私钥配对」，别等握手时报 `key values mismatch`。
- **`apps/api/cloud/remote`**：远程连接模块，只做 **Linux 的 SSH**（不接 Windows / RDP）。
  表 `remotes` / `remotes_logs` 存主机与凭据，接口前缀 `cloud/remote`，全部 `@Allow('admin')`；
  终端数据面走 **WebSocket 命名空间 `/remote`**（`RemoteGateway`），是本仓库第一处 WS 业务网关。十二条约定：
  1. **浏览器不碰 SSH 协议**：建连、认证、PTY、指纹校验全在 api（`ssh2`），前端只经 WS 换原始字节。
     新增依赖仅 `ssh2`（纯 JS，alpine 无需原生编译；可选 `cpu-features` 编译失败会被忽略，属正常）。
  2. **WS 不受 `TokenGuard` 保护** —— 它只处理 `switchToHttp()`。故用**一次性票据**：`POST /cloud/remote/ticket`
     在 HTTP 侧完成「令牌 + admin 角色」校验后签发（60 秒、一次性、绑定 userId），`RemoteGateway` 只认票。
     另外 `handleConnection` 仍自行验一遍令牌、用户启用状态与 `admin` 角色（纵深防御，别删）。
  3. **`ssh2` 的客户端通过工厂注入**（令牌 `SSH_CLIENT`，见 `cloud.module.ts`）：会话层与网关的测试要能塞
     EventEmitter 替身，而 ssh2 的连接行为在 ESM 下没法打桩。`RemoteSshService` 只负责「回调 → Promise」与错误归类。
  4. **主机指纹 TOFU**：`hostVerifier` 默认放行等于给中间人开门。空指纹 → 握手**成功后**回写（`rememberFingerprint`），
     记录过就必须一致；不一致时 verifier 返回 false，让 ssh2 在**认证之前**中止（绝不把密码发给未经验证的主机）。
     `diagnose` 只读、不写指纹；用户确认后走 `POST /trust`（会照常进变更历史）。
  5. **`fingerprint` 不能走普通更新**：`RemoteUpdateDto` 虽收了它，服务层刻意忽略 —— 否则前端一次普通保存
     就能把「指纹已变更」的告警静默抹掉。
  6. **输出侧必须背压**：16ms 聚合 + 32KB 分帧 + `socket.conn.writeBuffer` 水位（>64 帧 `pause()`、<8 帧 `resume()`）。
     不做这一步，`cat` 大文件会把 socket.io 缓冲一路涨到浏览器 OOM。⚠️ `writeBuffer` 是 socket.io 内部字段，升级要复查。
  7. **传输原始字节，不转码**：`Buffer` 直接下发，前端用 `TextDecoder(charset, {stream:true})` 解码
     （`stream` 是 `decode()` 的参数，写进构造会类型报错）。一个汉字可能跨两帧，逐帧解码必乱码。
     主机上的 `charset` 列（`utf-8` / `gb18030`）就是为 locale 仍是 GBK 的老系统准备的。
  8. **凭据三列加密、永不下发**：`password` / `private_key` / `passphrase` 存 `enc:v1:` 密文，`view()` 清空并回
     `hasPassword` / `hasKey` / `hasPassphrase`；编辑时 `''` 或 `***` 都表示不修改，**切鉴权方式时才显式清另一套**。
  9. **私钥在保存时就解析**（`remote.key.ts`）：`crypto.createPrivateKey` 拦下口令错 / 格式错，`.ppk` 直接给转换命令。
     别等到连接时才看到 OpenSSL 的 `bad decrypt` —— 用户不知道是哪个框填错了。
  10. **会话上限与超时在内存里**（`RemoteSessionService`）：单用户 5 / 全局 20 / 单主机 4，空闲 30 分钟、最长 8 小时；
      `onGatewayDisconnect` 必须真正 `end()` SSH（只从 Map 删引用不会断 TCP，目标机 `who` 里会留残留会话）。
  11. **不要把握手成功前的指纹写库**，也不要把「最后连接时间」放主表（`CommonService.update` 会把整行搬日志表，
      每连一次就多一条变更历史）。模块 DDL 见 `deploy/remotes-module.ddl.sql`（docker / kubernetes 的 DDL 仍只在工控机上）。
  12. **概览的网络段以 `ip -o` 为准，且「链路启用」看 `state` 不看 flags**（真机实测）：
      `<...,UP,...>` 在 `NO-CARRIER`（网线没插 / `docker0` 没容器）时同样是 UP，真正该读的是 `state UP|DOWN`；
      `state UNKNOWN`（`lo` / `tun`）才退回 flags，三份来源都取不到时状态给 `unknown` 而不是 `down`。
      接口名后的 `@ifN` 要先剥掉；`lo` 与 `veth*` 必须过滤（一台 Docker 宿主机能列出几十个 veth）。
      DNS 优先读 `/run/systemd/resolve/resolv.conf`（`/etc/resolv.conf` 在 systemd-resolved 下只有存根 `127.0.0.53`），
      网关优先 `ip route show default`、兜底 `/proc/net/route`（小端十六进制，需按字节倒序解）。
      不用 `ip -j` / `ip -br`（老 iproute2 / BusyBox 分别不认），只用两边都支持的 `-o`。
      链路带宽另取 `/sys/class/net/<接口>/{speed,duplex}`，**只用有 `device` 软链接的物理网口**：
      `br-*` / `veth*` 的 `speed` 是内核编的 `10000`、`docker0` 是 `-1`，虚拟设备显示带宽就是假数据；
      网线没插时 `speed` 读出来是空（EINVAL），速率给 0、前端文案给「未连接」。该口径是**协商速率**，
      不是实测吞吐（吞吐要两次采样，概览是单次快照）。不引 `ethtool`（默认镜像常没装、部分型号要 root）。
- **`apps/api/tencent`**：**腾讯云模块**（`TencentModule`），
  接口前缀 `tencent/`（`ssl` / `dns` / `domain` / `cdn` / `firewall` / `lighthouse`），全部 `@Allow('admin')`；
  依赖 `CloudModule` —— `KeyService` 取密钥、`KongService` + `ObjectService` 把 SSL 证书部署到 KONG 站点。约定：
  1. **签名是纯函数，且有官方示例向量兜底**：`api/api.sign.ts` 只管算（`canonicalRequestOf` / `stringToSignOf` /
     `authorizationOf` / `headersOf`），不碰网络；`api.sign.spec.ts` 里那两个哈希（`35e9c5b0…`、`7019a55b…`）
     取自腾讯云官方《签名方法 v3》示例，**改动签名实现后这两个值必须仍然相等**，别当成魔法数删掉。
     日期一律按 **UTC** 算（`dateOf`）—— 东八区凌晨时段取本地日期会直接签错。
  2. **不引 `@nestjs/axios`**：请求走运行时自带的 `fetch`（`api/api.request.ts`），与 `cloud/kong/kong.request.ts` 同一套做法；
     超时 15s，连不上 / 非 2xx 转 `HttpException`（502 / 原状态码）。**腾讯云的业务错误是 HTTP 200 + `Response.Error`**，
     该正文原样返回给前端，由前端读 `Response.Error` 提示，不要在后端改判成 HTTP 错误。
  3. **密钥 secret 只在服务端出现**：`KeyService.show(id)` 校验密钥存在与 `provider === 'tencent'`，
     `KeyService.secret(id)` 单独取 Secret（`show` 的 select 不含它）。地域参数会进请求头，`ApiService` 里用
     `^[a-z0-9-]*$` 挡掉换行等字符。
  4. **DTO 必须按腾讯云参数表逐字段声明**（未声明的字段会被 `ValidationPipe({whitelist:true})` 静默剥掉，
     表现为腾讯云报 `MissingParameter`）：
     - `DnsCreateDto` 按 `CreateRecord` 的 `Domain` / `RecordType` / `RecordLine` / `Value` / `SubDomain` / `TTL` / `MX` / `Status` / `Remark` 声明，
       `DnsModifyDto` 继承它并补 `RecordId`（漏了 `RecordLine` / `Status`，改线路与启停会「看起来成功」其实没生效）。
     - `CdnRemarkDto` / `DomainRemarkDto` 的备注**允许空串**：腾讯云约定「删除备注请提交空内容」，用 `@IsNotEmpty`
       会把清空操作挡在 400。反例：`SslListDto` 的 `Limit` 不能给 0（`@Min(1)`）。
     - 需要透传给腾讯云的字段必须**逐个声明**，字段名与官方文档逐字一致。
  5. **取单条解析记录用 `DescribeRecord`**（`dns/record/:id`，参数 `Domain` + `RecordId`）：
     `DescribeRecordList` 既不认 `RecordId`、也不返回 `RecordInfo`，用它取详情只能退回默认表单。
  6. **SSL 部署不打印证书详情**：`DescribeCertificateDetail` 的返回**含私钥**，只记证书 ID 与站点 ID；
     并且先看 `cert.Error` —— 只判公钥为空的话，证书不存在时用户看到的是「内容或私钥为空」。
  7. 不要在方法上再挂 `@UsePipes(new ValidationPipe())`：全局 `APP_PIPE` 就是 `ValidationPipe({whitelist:true})`，
     方法级那个既多余又不带 `whitelist`（两套口径并存容易误判）。
  8. 路径别名只有 `@shared` 一个：模块间走相对路径（必须带 `.js`），不要新增 `@cloud` / `@kong` / `@tencent` 之类别名。
- **`apps/api/admin`**：**管理员模块**（`AdminModule`），
  只含管理端自用的四块：系统配置 `admin/setting`、邮件配置 `admin/email`、操作日志 `admin/operate`、请求日志 `admin/req`，
  全部 `@Allow('admin')`。密钥与各站点的管理**不在这个模块**，它们属于 `cloud/`（见上）。五条约定：
  1. **控制器类名带 `Admin` 前缀**（`AdminSettingController` / `AdminOperateController` / `AdminReqController`）：
     `shared/setting/setting.controller.ts` 已有一个只读的 `SettingController`（`setting/:code`，个人端读配置用），
     重名会让 `ReqInterceptor` 记的控制器字段分不开两类请求（与 `AuthUserController` 同一考虑）。
  2. **配置的增删改查全走 `OptionController` 基类**，`AdminSettingController` 只声明前缀与角色、`SettingDto` 提供字段。
     `SettingDto` 的 `status` / `value` 用 **`class-validator` 的 `@Allow()`**（与 `@shared` 里那个同名的
     NestJS 元数据装饰器不是一回事，别引错包）：带校验的只有 `code`，另两个字段挂 `@Allow()` 只为躲开全局 `whitelist` 的剥离。
  3. **两个日志接口都只读**：操作 / 请求日志由业务服务在写操作时自动追加，管理端不给改与删（审计记录能改等于没有审计）。
     `admin/req/index` 带 `@ReqId()`，服务层用它把**本次查询自己**那条日志从结果里剔掉。
  4. **字典接口与清单成对**：`admin/operate/options`、`admin/req/{url,user,controller,action/:controller}` 供前端渲染下拉，
     别在前端写死枚举（`operate` / `name` 的取值随业务模块增长而变，写死就会漏项）。
  5. **邮件配置单列 `admin/email`，不复用 `admin/setting`**：SMTP 授权码要加密落库、详情要脱敏
     （只回 `***` + `hasPassword`）、保存要「留空即不改」，通用 `OptionController` 的整对象读写这三点都做不到；
     在子类覆盖父类同路由 handler 又会让 Nest 重复注册路由。配置仍存 `settings`（`code = 'email'`），
     与备案配置共用变更日志与操作序号。三条硬约定：
     ① 密钥取 `SETTING_KEY`（`shared/common/secret.util.ts`，AES-256-GCM + `enc:v1:` 版本前缀），缺失时**直接 500**，
     不给「缺密钥就存明文」留后门；换密钥后旧密文解不开，页面重填一次授权码即可。
     ② **运行时不读 `SMTP_*` 环境变量**：库中无配置即抛 422，`EmailService` 构造期也不建连接器，
     改为按配置指纹 + 60 秒 TTL 懒加载；保存后控制器调 `invalidate()` 立即生效（多实例最迟 TTL 到期跟进）。
     `.env` 与 `.env.example` 都不含 SMTP 段；`hasEnvSmtp()` 只用于探测「部署里是否还留着这几个键」并下发 `envDetected` 作提示，
     **不是**配置回落的入口 —— 别把它改成「环境变量兜底」。
     ③ `EmailService.send()` **失败抛异常**，不返回 `1/0`：调用方从不检查返回值时，SMTP 认证失败会被静默当成「验证码已发送」。
- **`apps/api/data`**：行情数据模块（`DataModule`），负责本地 A 股行情（证券 / 交易日历 / 日 K / 复权因子）的同步与浏览。
  目录：`data/source/`（baostock 裸 TCP 协议层）、
  `data/sync/`（同步引擎：计划 + 4 同步器 + 台账）、`data/entities/`（7 张行情表实体 + DDL）、`data/`（gateway + 同步控制器 + 查询控制器）。
  关键约定：
  1. **消费段放 api 进程内 ⇒ 部署单实例**：`SyncService.onApplicationBootstrap` 把 `state=2` 的僵尸执行回滚成 `state=1` 再唤醒消费；
     两个 api 实例同时启动会互抢对方正在跑的执行。docker compose 别加多副本。
  2. **队列权威 = `sync_runs` 表**（活跃行就是队列），`shared/queue` 只当「唤醒后的串行宿主」，不存队列语义。
  3. **协议层只实现 4 个接口**（`33/34` 日历、`45/46` 证券、`98/99` 按交易日日 K、`9C/9D` 按交易日复权因子），
     `95/96` 按证券 K 线不需要（浏览页查库）。记录位/列名位：按证券类 6/9、按交易日类 4/5 —— 写错静默拿空串，不报错。
  4. **枚举落库存名字不是序号**：`securities.type`（Stock/Index/Bond/Fund）、`market`（Shanghai/Shenzhen/Beijing）、
     `status`（Listed/Delisted/Suspended）、`bars.trade_status`（Normal/Suspended/Unknown）。落库值即中文界面上看到的分类，不要改成数字。
  5. **两种「0 条」语义相反**：日 K 交易日返回 0 条 = 数据源未发布 ⇒ 停段不推台账；复权因子 0 条 = 当天无除权除息 ⇒ 照常推进。
  6. **实体列名与 DDL 两半都要断言**（`entities/entities.spec.ts` 用 `getMetadataArgsStorage` 比对 databaseName），
     单测走内存替身、真连 PG 才 `42703` 的坑。
  7. **行情表 DDL 在 `data/entities/schema.ddl.sql`**，其中两条**部分唯一索引**（`IDX_sync_runs_plan` / `IDX_sync_runs_active`）
     synchronize 生成不了，须手工执行；执行由用户自己做（遵守「不直接改库」纪律）。
  8. **`bars` 4 个估值列（pe_ttm/pb_mrq/ps_ttm/pcf_ncf_ttm）必须 NULL 语义**：数据源空串表示无值，落 0 会让 PE/PB 全错且不报错。
  9. **涨跌色走 web 端 theme 变量**，后端不下发颜色语义，只下发原始数值。
  10. **批量写入必须按参数预算分批**（`data/sync/write-chunk.ts` 的 `chunkRows`）：PostgreSQL 的 Bind 消息里
     参数个数是 **Int16（硬上限 65535）**，`pg` 的 `addInt16` 对超出的值**静默截断**，服务端于是按
     `参数数 mod 65536` 读格式码、把剩下的格式码当成参数个数，报成
     `bind message has N parameter formats but 0 parameters` —— 文本与真实原因完全对不上，极难排查。
     `bars` 每行 17 个绑定参数，全市场一天 3857 只就是 65569 个参数（超出上限 33），一次全量写必然失败。
     因此**所有 `Repository.upsert` 一律走 `SyncService.upsertInChunks`**（默认预算 30000 个参数，按实体列数折算每块行数），
     不要写成一次性全量；按交易日同步是一次写全市场（5000+ 行/天），上游没有分页可依赖。
  11. **浏览页的联想是独立接口**（`GET data/security/suggest?keyword=`）：证券页关键字栏与 K 线页代码栏共用它。
     与列表接口刻意分开 —— 联想是「每敲一键查一次」，只需要 4 列、`LIMIT 12`、**不做 `count(*)`**；
     列表接口要分页总数与 `marketTotal`，两者合并会让每次按键都多算两遍全表。
     排序必须**在 SQL 里分级**（代码精确 → 代码/六位数字前缀 → 名称前缀 → 名称包含 → 同档在市优先 + 代码升序），
     不能在 JS 里对「取回的前 N 行」重排：`%600%` 这类输入命中上千条，先截断再排序等于按代码序随机取 12 条。
     用户输入进 ILIKE 前要**转义 `%` / `_` / `\`**（`likeContains` / `likePrefix`），否则敲一个 `%` 就把全表捞出来。
  12. **`@Query()` 的数值参数必须在 DTO 上用 `@Transform` 显式转 number**：全局管道是
     `ValidationPipe(VALIDATION_PIPE_OPTIONS)`（`apps/api/validation.options.ts`，`whitelist + transform`），
     查询串里的值全是字符串，`@IsInt()` 只认 number —— 只开 `whitelist` 时，带 `page`/`size` 的请求会**恒 400**
     （`page must be an integer number`，证券页一打开就红）。刻意**不开** `enableImplicitConversion`：
     `Boolean('false') === true`，会把所有 `@IsBoolean()` 开关字段静默改成开启。`app.pipe.spec.ts` 钉住了这条口径。
  13. **按交易日数据的「当天」有发布切点**：上界由 `data/sync/daily-window.ts` 决定 ——
     交易日 **19:00 前**的手动同步只到**前一交易日**（数据源此时还没发布当天数据，硬取只会让进度区多一段空转），
     19:00 起含当天；非交易日一律落在最近一个开市日。
     当天由**每日 20:00 的定时补更**收口（`data/sync/daily-catch-up.ts` + `SyncService.startDailyCatchUp`）：
     进程内 5 分钟巡检，命中「交易日 + 已过 20:00 + 今天还没排过」就入队，请求带 `includeToday: true`。
     ⚠ 幂等靠 `sync_runs.plan_date = 'auto:daily:<today>'`（应用层 `findOneBy` 查重 + `IDX_sync_runs_plan` 兜底）——
     这个值**不能改成空串**：空串是手工执行的标记，不受该唯一索引约束。
     ⚠ 用巡检而不是 `setTimeout(20:00)`：20:00 那一刻进程恰好重启，一次性定时器就永久错过当天。
     手动同步与补更的边界要分开测（`sync-plan.service.spec.ts` 的「按交易日的同步上界」一组）。
- **`@shared` 路径别名**：根 `tsconfig.json` 的 `paths` 声明 `@shared` → `apps/api/shared/index.ts`、`@shared/*` → `apps/api/shared/*`。
  `shared/` **之外**的代码（`app.module.ts` 等）用 `import { SharedModule } from '@shared'` 或 `@shared/<目录>/<文件>.js`；
  `shared/` **内部**仍用相对路径（保持目录可整体搬迁，也不引入循环依赖风险）。
  `nest build` / `nest start` 由 `@nestjs/cli` 12 的 tsconfig-paths 钩子在**编译期把别名改写成相对路径**（产物里看到的是 `./shared/index.js`），
  所以运行时**不需要** `tsconfig-paths/register`（CJS 时代的做法在这里用不上）；`vitest` 靠 `resolve.tsconfigPaths` 解析。
  ⚠️ `apps/worker` **暂时不能用 `@shared`**：`apps/api/shared/**` 不在 worker 的 project file list 里（报 TS6307 + rootDir 越界），
  真正的跨 app 复用要回到 `libs/` 方案；别把别名当成已解决跨 app 共享。
- ⚠️ **源码目录里不该出现 `.js` / `.js.map` / `.d.ts`**：`dist/` 之外出现它们，说明有文件被 tsc 在 rootDir 之外**就地 emit** 了
  （典型触发：给 `apps/worker` 加一条 `@shared` 导入去「试一下」，会连带把 `apps/api/shared` 整棵树的三种产物吐回源码目录）。
  这些是构建垃圾，`git status` 核对后直接删；提交前务必扫一眼（本项目 `declaration: true` + `composite: true`，产物正常只落在 `dist/apps/<project>/`）。

## 日志口径（只输出异常与告警）

- 两个入口的日志级别都由 `apps/api/log.options.ts` 的 `resolveLogLevels()` 决定：默认 `['error', 'warn']`，
  环境变量 `LOG_LEVEL`（逗号分隔，或 `all`）可临时放开。**不要在入口硬编码级别数组**
  （例外：`apps/worker` 不能 `@shared`，只能写字面量 `['error', 'warn']`，改口径时两处一起对）。
- ⚠️ **请求路径上不许打 debug**：`TokenGuard` / `ReqInterceptor` 在请求路径上打 debug 会每个请求刷出十行
  `DEBUG clientIp / url / reqId`（`Logger.debug('a', b)` 是**每个参数一行**），容器日志里真正的故障会被淹掉。
  排障需要这些值时临时在本地加断点或 `LOG_LEVEL`，别提交回仓库。
- **正常事件不输出**：连接建立 / 空闲回收 / 启动成功 / 缓存初始化 这类「预期内」的事件一律不打日志；
  值得留痕的只有异常链路 —— 异常、异常后重连、探活自愈。
- **恢复类日志用 `warn` 而不是 `log`**：默认级别下 `log` 不输出，只留「探活失败」而没有「已恢复正常」，
  会把已自愈的故障误判成持续故障（`DbMonitorService` 的探活恢复即按此口径）。
- `logger.log` 仍保留在状态变更处（自动建角色、系统初始化完成、同步入队等），默认级别下不输出，
  排查时 `LOG_LEVEL=log` 恢复；真正需要「一直被看到」的异常请用 `error` / `warn`。

## 提交门禁（pre-commit）

- `yarn install` 通过 `prepare: husky` 装好钩子，定义在 `.husky/pre-commit`：顺序执行 `yarn lint` → `yarn test`，任一失败即拒绝提交。
- **不要用 `git commit --no-verify` 绕过**：钩子失败就先修代码或用例；确认是环境问题（缺浏览器、缺 PG 等）时，说明原因由用户决定。
- 钩子只跑单元测试（`**/*.spec.ts`，`passWithNoTests: true`）；`yarn test:e2e`（`**/*.e2e-spec.ts`）需要真实 PostgreSQL + Redis，只在需要时手工执行。
- **覆盖率门槛**在 `vitest.config.ts` 的 `coverage.thresholds`（当前 89/88/83/88：行/语句/分支/函数，实测约 94%/94%/84%/93%）。
  只有 `yarn test:cov` 会校验门槛 —— 钩子为了速度只跑 `vitest run`，**CI 跑 `yarn test:cov`**，所以本地绕过会在 CI 红。
  口径固定为 `apps/api/**/*.ts` 并排除 `*.spec.ts` 与 `test/`；`main.ts` / `app.module.ts` 属启动装配，不纳入目标。
- CI（`.github/workflows/docker.yml` 的 `quality` job）跑同样的 `lint` + `test:cov`，`docker` job `needs: quality` —— 本地绕过也过不了远端。
- ⚠️ 写测试的既有坑：带 `@Type()` 的 DTO 用例必须自己 `import 'reflect-metadata'`（vitest 不走 Nest 引导）；参数装饰器要从 `ROUTE_ARGS_METADATA` 取 `factory` 才能单测；**vitest 不做类型检查**（`apps/api/tsconfig.app.json` 排除了 `**/*spec.ts`），spec 的类型错误要另跑一次性 tsconfig + `tsc --noEmit` 才看得见。

## Production data: NestJS Observe

This app's production telemetry - traces, errors, logs and metrics - goes to [NestJS Observe](https://observe.nestjs.com). Until `ObserveModule` is registered in `apps/api/app.module.ts`, nothing is sent: `npx @nestjs/observe link` sets it up in one step - it installs `@nestjs/observe`, wires it into the app, and writes the key pair (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`) to `.env`.

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.
