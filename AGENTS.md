# AGENTS.md

## Monorepo 结构（NestJS 标准模式）

本仓库采用 NestJS 标准 Monorepo，用 `nest build <project>` / `nest start <project>` 按项目构建与启动：

| 项目 | 类型 | 说明 |
| --- | --- | --- |
| `apps/api` | application | HTTP 接口服务，监听端口（默认 3000）；`apps/api/shared/` 为共用领域模块 |
| `apps/worker` | application | 后台常驻服务，**不监听端口**，用于定时任务 / 队列消费 / 长时异步任务 |
| `libs/` | library | 可复用库（`nest g library <name>`），当前为空 |

约定：

- **新增服务**：`nest g app <name>`（生成到 `apps/`），并手动登记到根 `nest-cli.json` 的 `projects` 与根 `tsconfig.json` 的 `references`。
- **共享代码**：跨 `api` / `worker` 复用的模块下沉到 `libs/`（`nest g library <name>`），通过 tsconfig 路径别名引用。
- 每个 `apps/*/tsconfig.app.json` 必须保留 `"composite": true`（project references 依赖它，移除会导致 `lint` 报 tsconfig-error）。
- 生产产物落在 `dist/apps/<project>/`；入口为 `dist/apps/api/main.js` 与 `dist/apps/worker/main.js`。
- **再建库时**：`nest g lib <name>` 会顺手加 `"builder": "rspack"` 与 4 个 webpack 系 devDep，如无需要记得回退；且 TS 6 起
  `libs/*/tsconfig.lib.json` **必须显式 `rootDir`**（TS5011），写 `"rootDir": "./src"` 才能得到 `dist/libs/<name>/index.js` 而非多套一层的路径。
- **`apps/api/shared`**：自旧私有项目 `marbleqi/api` 的 `src/shared` 迁入的共用领域模块（`SharedModule`：用户 / 角色 / 令牌 / 配置 /
  操作·请求日志 / 缓存 / 队列 / 邮件 / 监控）。它随 `apps/api` 一起构建（产物 `dist/apps/api/shared/`），当前**只有 api 使用**。
  两条不受「库还是目录」影响的 ESM 铁律：内部相对导入**必须带 `.js`**；**不用桶文件（`index.ts`）互相导入**
  （ESM 下会因 TDZ 抛 `Cannot access 'X' before initialization`），一律按文件具名导入 —— `shared/index.ts` 只对外聚合，内部不反向引用它。
- **`apps/api/auth`**：自旧私有项目 `marbleqi/api` 的 `src/auth` 迁入的**访问控制模块**（`AuthModule`），只含管理端控制器：
  角色 `/auth/role`、用户 `/auth/user`、令牌 `/auth/token`，全部用 `@Allow('admin')` 声明所需角色（鉴权由全局 `TokenGuard` 完成）。
  ⚠️ 旧项目里的**分类（`category`）与产品（`product`）不迁移**，别照旧目录补回来。
  管理端建号/改资料走 `UserService.create` / `update` 的**覆盖实现**（用户名归一化 + 密码哈希 + 邮箱空串转 NULL），
  DTO 是 `shared/user/user.dto.ts` 的 `UserManageCreateDto` / `UserManageUpdateDto` —— 与个人端的 `UserUpdateDto` 刻意不同名，
  因为两者字段与权限边界完全不同（管理端含 `status` / `roles`）。管理端用户控制器类名叫 `AuthUserController`，
  避免与个人端 `UserController` 重名（`reqs.controller` 按类名记账，重名会让两类请求在日志里分不开）。
- **`apps/api/cloud`**：自旧私有项目 `marbleqi/api` 的 `src/cloud`（密钥）与 `src/kong`（KONG 站点）**合并**迁入的云服务模块（`CloudModule`），
  接口前缀统一为 `cloud/`（`/cloud/key`、`/cloud/kong`，另有两个探测接口 `summary/:id`、`plugin/:id`），全部 `@Allow('admin')`。
  四条与旧项目**刻意不同**的约定，别按旧代码「改回去」：
  1. **密钥 secret 不出库**：`KeyService.index` / `show` 都走 `PUBLIC_SELECT`（不含 `secret`），详情也不回填；服务端内部要用时才调
     `KeyService.secret(id)`。旧项目 `admin/key` 的详情会把 secret 整个下发浏览器，这里改掉了；因此前端编辑表单是「留空即不改」
     （`KeyUpdateDto.secret` 可选，缺省表示保持原值）。
  2. **DTO 按实体重写**：旧 `admin/key/key.dto.ts` 的字段是 `name / description / url / status`（从 kong 抄错的），配合
     `ValidationPipe({whitelist:true})` 会把 `provider / key / secret` 剥掉，建密钥必然 500。现在是 `KeyCreateDto`（六字段必填）+
     `KeyUpdateDto`（全可选）。`status` 一律用 `@IsBoolean`，不能用 `@IsNotEmpty`（它对 `false` 判空）。
  3. **KONG 探测用 `fetch` 而非 `@nestjs/axios`**：旧项目注入 `HttpService`，本仓库不引 axios；`kongRequest()`（`kong/kong.request.ts`）
     用运行时自带的 `fetch`（非 2xx 不抛网络错），错误按 `HttpException` 原状态码透传，网关不可达转 502。站点与站点对象共用它。
  4. **TypeORM v1 的 `select` 只认对象写法**：旧项目普遍写 `select: ['id', 'name', 'update.at']`，v1 起运行时**直接抛错**
     （`String-array "select" syntax has been removed`，在 `DbErrorFilter` 里表现为 500，单元测试用替身时发现不了）。
     嵌入列要展开成嵌套对象：`select: { id: true, update: { at: true } }`，并用 `satisfies FindOptionsSelect<Entity>` 让 TS 兜住。
- **`apps/api/cloud/kong/object`**：站点下的**对象管理**（旧 `src/kong/object` + `src/admin/kong/object` + web 的 `/kong/:id/*`），
  接口前缀 `cloud/kong/object/`（`index` / `show` / `create` / `update` / `destroy`，全部 POST + 请求体），控制器 `KongObjectController`。
  `kongs` / `kongs_logs` 仍只存站点自身 —— 对象全在 Kong 那边，本仓库不落库。四条约定：
  1. **一个服务管六种对象**：Kong 的 `routes` / `services` / `consumers` / `certificates` / `plugins` / `upstreams` 在 Admin API 上是同一套 REST 形状
     （`GET|POST /{type}`、`GET|PATCH|DELETE /{type}/{id}`），故 `ObjectService` 不按类型拆；类型白名单在 `object.types.ts` 的 `KONG_OBJECT_TYPES`。
  2. **`type` / `id` 必须校验**：两者都会拼进 Admin API 路径，`type` 走 `@IsIn(KONG_OBJECT_TYPES)`，`id` 走 `@Matches` 的正则（首字符必须是字母数字，
     挡掉 `/` 与 `..`）。旧项目只写了 `@IsNotEmpty`，等于把路径交给前端。
  3. **分页用 `offset` 自己拼**：旧代码直接拼 `data.next`，而新版 Kong 给的 `next` 是**完整 URL**（带 `size` 时是相对路径，无下一页时为 `null`，
     已实测 3.9.4），拼出来会变成 `http://host:8001http://...`；
     现在按响应里的 `offset` 逐页取（该字段只在还有下一页时出现），且有 `MAX_PAGES` 上限（超了报 502，不静默返回半份数据）。
  4. **证书的域名与有效期在后端解析**：Kong 的证书对象**不带有效期**（`start` / `end` 只能从 PEM 读），`object/certificate.util.ts` 用 Node 自带的
     `crypto.X509Certificate` 解析 PEM 后补在返回对象上（秒级时间戳，与 Kong 其它时间字段同口径）。这样前端不必再引 `node-forge`；
     解析失败返回 `null`、原样返回对象，一张脏证书不该让整页打不开。
     ⚠️ **`snis` 以 Kong 返回的为准**：Kong 3.9 的证书对象自带 `snis`（实测），它才是网关里实际生效的绑定；PEM 的 SAN 只是「证书能覆盖哪些域名」，
     两者可以不一致（一个证书覆盖多个域名、却只给其中一部分建 SNI）。故 `ObjectService.enrich` 只在 Kong 没给 `snis`（空数组 / 老版本没有该字段）时用 PEM 兜底，
     别按旧私有项目那样直接用 PEM 覆盖。
  5. **仪表板读 `/` + `/status`，不读许可报告**（2026-10-31 在 Kong 3.9.4 社区版实测）：`/default/license/report` 是**企业版专属**，社区版恒为 404
     `{"message":"Not found"}`。`KongService.summary()` 并行取 `/`（version / edition / hostname / node_id / lua_version / 插件数）与
     `/status`（连接数 / `database.reachable`），合并成 `KongSummary` 下发；无数据库模式（DB-less）时 `database` 段不存在，`dbReachable` 给 `null`（不适用），
     与 `false`（不可达）分开。`/plugins/enabled` 在 3.x 返回 **`{ enabled_plugins: [...] }`**（2.x 才是数组），`KongService.plugin()` 统一成 `string[]`。
- **`apps/api/tencent`**：自旧私有项目 `marbleqi/api` 的 `src/tencent` 迁入的**腾讯云模块**（`TencentModule`），
  接口前缀 `tencent/`（`ssl` / `dns` / `domain` / `cdn` / `firewall` / `lighthouse`），全部 `@Allow('admin')`；
  依赖 `CloudModule` —— `KeyService` 取密钥、`KongService` + `ObjectService` 把 SSL 证书部署到 KONG 站点。约定：
  1. **签名是纯函数，且有官方示例向量兜底**：`api/api.sign.ts` 只管算（`canonicalRequestOf` / `stringToSignOf` /
     `authorizationOf` / `headersOf`），不碰网络；`api.sign.spec.ts` 里那两个哈希（`35e9c5b0…`、`7019a55b…`）
     取自腾讯云官方《签名方法 v3》示例，**改动签名实现后这两个值必须仍然相等**，别当成魔法数删掉。
     日期一律按 **UTC** 算（`dateOf`）—— 东八区凌晨时段取本地日期会直接签错。
  2. **不引 `@nestjs/axios`**：请求走运行时自带的 `fetch`（`api/api.request.ts`），与 `cloud/kong/kong.request.ts` 同一套做法；
     超时 15s，连不上 / 非 2xx 转 `HttpException`（502 / 原状态码）。**腾讯云的业务错误是 HTTP 200 + `Response.Error`**，
     该正文原样返回给前端（旧项目契约），不要在后端改判成 HTTP 错误。
  3. **密钥 secret 只在服务端出现**：`KeyService.show(id)` 校验密钥存在与 `provider === 'tencent'`，
     `KeyService.secret(id)` 单独取 Secret（`show` 的 select 不含它）。地域参数会进请求头，`ApiService` 里用
     `^[a-z0-9-]*$` 挡掉换行等字符。
  4. **DTO 按腾讯云参数表重写，不要照抄旧项目**（旧 DTO 与官方参数名不一致，配上 `ValidationPipe({whitelist:true})`
     会静默剥字段，表现为腾讯云报 `MissingParameter`）：
     - `DnsCreateDto` 旧字段是 `Type` / `Name`（腾讯云没有这两个参数），前端提交的 `RecordType` / `SubDomain` 被剥掉 ⇒ 建记录必失败；
       现在按 `CreateRecord` 的 `Domain` / `RecordType` / `RecordLine` / `Value` / `SubDomain` / `TTL` / `MX` / `Status` / `Remark` 声明，
       `DnsModifyDto` 继承它并补 `RecordId`（旧 DTO 漏了 `RecordLine` / `Status`，改线路与启停「看起来成功」其实没生效）。
     - `CdnRemarkDto` / `DomainRemarkDto` 的备注**允许空串**：腾讯云约定「删除备注请提交空内容」，旧 DTO 用 `@IsNotEmpty`
       把清空操作挡在 400。反例：`SslListDto` 的 `Limit` 不能给 0（`@Min(1)`）。
     - 需要透传给腾讯云的字段必须**逐个声明**（`whitelist` 会剥掉未声明的），字段名与官方逐字一致。
  5. **取单条解析记录用 `DescribeRecord`**（`dns/record/:id`，参数 `Domain` + `RecordId`）：
     旧项目错用了 `DescribeRecordList` —— 它既不认 `RecordId`、也不返回 `RecordInfo`，编辑弹窗永远只能退回默认表单。
  6. **SSL 部署不打印证书详情**：旧 `deploy` 把整份 `DescribeCertificateDetail`（**含私钥**）打进 debug 日志；
     现在只记证书 ID 与站点 ID，并且先看 `cert.Error`（旧代码只判公钥为空，证书不存在时用户看到的是「内容或私钥为空」）。
  7. 旧方法上的 `@UsePipes(new ValidationPipe())` 已去掉：全局 `APP_PIPE` 就是 `ValidationPipe({whitelist:true})`，方法级那个既多余，
     又不带 `whitelist`（两套口径并存容易误判）。
  8. 旧的 `@cloud` / `@kong` / `@tencent` 路径别名不迁移：本仓库只有 `@shared` 一个别名，模块间走相对路径（必须带 `.js`）。
- **`apps/api/admin`**：自旧私有项目 `marbleqi/api` 的 `src/admin` 迁入的**管理员模块**（`AdminModule`），
  只保留管理端自用的三块：系统配置 `admin/setting`、操作日志 `admin/operate`、请求日志 `admin/req`，全部 `@Allow('admin')`。
  旧 `src/admin/key`、`src/admin/kong`、`src/admin/kong/object` **不在这里** —— 它们已并入 `cloud` 模块（接口前缀 `cloud/`），别按旧目录补回来。
  四条约定：
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
- **`apps/api/data`**：**新建**的行情数据模块（`DataModule`），照 almanac 桌面端的语义重实现（不是从旧私有 `marbleqi/api/src/data` 搬代码，
  那里是 NestJS 11 单表模型，与本仓库 12 + ESM + vitest 不同）。目录：`data/source/`（baostock 裸 TCP 协议层）、
  `data/sync/`（同步引擎：计划 + 4 同步器 + 台账）、`data/entities/`（7 张行情表实体 + DDL）、`data/`（gateway + 同步控制器 + 查询控制器）。
  关键约定：
  1. **消费段放 api 进程内 ⇒ 部署单实例**：`SyncService.onApplicationBootstrap` 把 `state=2` 的僵尸执行回滚成 `state=1` 再唤醒消费；
     两个 api 实例同时启动会互抢对方正在跑的执行。docker compose 别加多副本。
  2. **队列权威 = `sync_runs` 表**（活跃行就是队列），`shared/queue` 只当「唤醒后的串行宿主」，不存队列语义。
  3. **协议层只实现 4 个接口**（`33/34` 日历、`45/46` 证券、`98/99` 按交易日日 K、`9C/9D` 按交易日复权因子），
     `95/96` 按证券 K 线不需要（浏览页查库）。记录位/列名位：按证券类 6/9、按交易日类 4/5 —— 写错静默拿空串，不报错。
  4. **枚举落库存名字不是序号**：`securities.type`（Stock/Index/Bond/Fund）、`market`（Shanghai/Shenzhen/Beijing）、
     `status`（Listed/Delisted/Suspended）、`bars.trade_status`（Normal/Suspended/Unknown）。与 almanac 落库值逐字一致。
  5. **两种「0 条」语义相反**：日 K 交易日返回 0 条 = 数据源未发布 ⇒ 停段不推台账；复权因子 0 条 = 当天无除权除息 ⇒ 照常推进。
  6. **实体列名与 DDL 两半都要断言**（`entities/entities.spec.ts` 用 `getMetadataArgsStorage` 比对 databaseName），
     单测走内存替身、真连 PG 才 `42703` 的坑。
  7. **行情表 DDL 在 `data/entities/schema.ddl.sql`**，其中两条**部分唯一索引**（`IDX_sync_runs_plan` / `IDX_sync_runs_active`）
     synchronize 生成不了，须手工执行；执行由用户自己做（遵守「不直接改库」纪律）。
  8. **`bars` 4 个估值列（pe_ttm/pb_mrq/ps_ttm/pcf_ncf_ttm）必须 NULL 语义**：数据源空串表示无值，落 0 会让 PE/PB 全错且不报错。
  9. **涨跌色走 web 端 theme 变量**，后端不下发颜色语义，只下发原始数值。
- **`@shared` 路径别名**：根 `tsconfig.json` 的 `paths` 声明 `@shared` → `apps/api/shared/index.ts`、`@shared/*` → `apps/api/shared/*`。
  `shared/` **之外**的代码（`app.module.ts` 等）用 `import { SharedModule } from '@shared'` 或 `@shared/<目录>/<文件>.js`；
  `shared/` **内部**仍用相对路径（保持目录可整体搬迁，也不引入循环依赖风险）。
  `nest build` / `nest start` 由 `@nestjs/cli` 12 的 tsconfig-paths 钩子在**编译期把别名改写成相对路径**（产物里看到的是 `./shared/index.js`），
  所以运行时**不需要** `tsconfig-paths/register`（旧私有项目的 CJS 做法在本仓库用不上）；`vitest` 靠 `resolve.tsconfigPaths` 解析。
  ⚠️ `apps/worker` **暂时不能用 `@shared`**：`apps/api/shared/**` 不在 worker 的 project file list 里（报 TS6307 + rootDir 越界），
  真正的跨 app 复用要回到 `libs/` 方案；别把别名当成已解决跨 app 共享。
- ⚠️ **源码目录里不该出现 `.js` / `.js.map` / `.d.ts`**：`dist/` 之外出现它们，说明有文件被 tsc 在 rootDir 之外**就地 emit** 了
  （典型触发：给 `apps/worker` 加一条 `@shared` 导入去「试一下」，会连带把 `apps/api/shared` 整棵树的三种产物吐回源码目录）。
  这些是构建垃圾，`git status` 核对后直接删；提交前务必扫一眼（本项目 `declaration: true` + `composite: true`，产物正常只落在 `dist/apps/<project>/`）。

## 提交门禁（pre-commit）

- `yarn install` 通过 `prepare: husky` 装好钩子，定义在 `.husky/pre-commit`：顺序执行 `yarn lint` → `yarn test`，任一失败即拒绝提交。
- **不要用 `git commit --no-verify` 绕过**：钩子失败就先修代码或用例；确认是环境问题（缺浏览器、缺 PG 等）时，说明原因由用户决定。
- 钩子只跑单元测试（`**/*.spec.ts`，`passWithNoTests: true`）；`yarn test:e2e`（`**/*.e2e-spec.ts`）需要真实 PostgreSQL + Redis，只在需要时手工执行。
- **覆盖率门槛**在 `vitest.config.ts` 的 `coverage.thresholds`（当前 89/88/83/88：行/语句/分支/函数，实测约 91%/90%/85%/89%）。
  只有 `yarn test:cov` 会校验门槛 —— 钩子为了速度只跑 `vitest run`，**CI 跑 `yarn test:cov`**，所以本地绕过会在 CI 红。
  口径固定为 `apps/api/**/*.ts` 并排除 `*.spec.ts` 与 `test/`；`main.ts` / `app.module.ts` 属启动装配，不纳入目标。
- CI（`.github/workflows/docker.yml` 的 `quality` job）跑同样的 `lint` + `test:cov`，`docker` job `needs: quality` —— 本地绕过也过不了远端。
- ⚠️ 写测试的既有坑：带 `@Type()` 的 DTO 用例必须自己 `import 'reflect-metadata'`（vitest 不走 Nest 引导）；参数装饰器要从 `ROUTE_ARGS_METADATA` 取 `factory` 才能单测；**vitest 不做类型检查**（`apps/api/tsconfig.app.json` 排除了 `**/*spec.ts`），spec 的类型错误要另跑一次性 tsconfig + `tsc --noEmit` 才看得见。

## Production data: NestJS Observe

This app's production telemetry - traces, errors, logs and metrics - goes to [NestJS Observe](https://observe.nestjs.com). Until `ObserveModule` is registered in `apps/api/app.module.ts`, nothing is sent: `npx @nestjs/observe link` sets it up in one step - it installs `@nestjs/observe`, wires it into the app, and writes the key pair (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`) to `.env`.

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.
