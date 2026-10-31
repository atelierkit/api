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
  接口前缀统一为 `cloud/`（`/cloud/key`、`/cloud/kong`，另有两个探测接口 `report/:id`、`plugin/:id`），全部 `@Allow('admin')`。
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
  3. **分页用 `offset` 自己拼**：旧代码直接拼 `data.next`，而新版 Kong 给的 `next` 是**完整 URL**，拼出来会变成 `http://host:8001http://...`；
     现在按 `offset` 逐页取，且有 `MAX_PAGES` 上限（超了报 502，不静默返回半份数据）。
  4. **证书的域名与有效期在后端解析**：Kong 的证书对象不带 `snis` / `start` / `end`，`object/certificate.util.ts` 用 Node 自带的
     `crypto.X509Certificate` 解析 PEM 后补在返回对象上（秒级时间戳，与 Kong 其它时间字段同口径）。这样前端不必再引 `node-forge`；
     解析失败返回 `null`、原样返回对象，一张脏证书不该让整页打不开。
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
