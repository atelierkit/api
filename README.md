# atelierkit · api

家用局域网服务器上的个人工具集合 —— 后端服务（**Monorepo**）。

基于 [NestJS](https://nestjs.com) 构建，为 `atelierkit` 各前端应用提供统一的 REST API，
并以 **NestJS 标准 Monorepo** 组织两类服务：API 接口服务 + 后台常驻服务。

## 项目简介

`atelierkit` 是一套部署在家庭局域网服务器上的自托管工具集合，所有数据仅在内网流转。
本仓库承载两类后端进程：

- **`apps/api`** —— HTTP 接口服务，承载数据存取、统一鉴权，为前端提供 REST API。
- **`apps/worker`** —— 后台常驻服务，不监听端口，用于定时任务、队列消费、长时异步任务（如下载引擎管理）。
- **`apps/api/shared`** —— API 服务的共用领域模块（用户 / 角色 / 令牌 / 配置 / 操作日志 / 请求日志 / 缓存 / 队列 / 邮件 / 异常监控），以 `SharedModule` 对外提供。
- **`apps/api/auth`** —— 访问控制模块（`AuthModule`），只放**管理端**接口：角色（`/auth/role`）、用户（`/auth/user`）、令牌（`/auth/token`），
  统一由 `@Allow('admin')` 声明所需角色，鉴权本身由全局 `TokenGuard` 完成。
- **`apps/api/cloud`** —— 云服务模块（`CloudModule`），管理端接口：密钥（`/cloud/key`）、KONG 网关站点（`/cloud/kong`，含 `report/:id` 与 `plugin/:id` 两个探测接口）。
  密钥的 `secret` 只在服务端内部使用，清单与详情都不下发浏览器。
- **`libs/`** —— 可复用 NestJS 库（当前为空，待两服务出现共享代码时拆分）。

## 功能

- 私有文件与数据管理：文件上传、下载、预览、分享，以及结构化数据的存取
- 服务器运维：系统状态、进程与服务管理
- 下载中心：网盘分享链接解析、断点续传、后台常驻下载，任务进度 / 暂停 / 限速管理
- 用户与权限：登录、角色、令牌与操作审计
- 云服务：云厂商访问密钥管理（腾讯云 / 阿里云 / 亚马逊）、KONG 网关站点管理与连通性诊断
- 腾讯云：SSL 证书（申请 / 续期 / 部署到 KONG / 吊销）、DNSPod 域名与解析记录、CDN 域名、
  轻量应用服务器（启停 / 重启 / 重置密码 / 删除）与防火墙规则
- （规划中）家庭物联网：设备接入与状态管理

## 技术栈

- [NestJS](https://nestjs.com) 12 · [TypeScript](https://www.typescriptlang.org) 6
- [Vitest](https://vitest.dev) · ESM · [oxlint](https://oxc.rs)

## 部署

### 前置依赖

| 依赖 | 说明 |
| --- | --- |
| Node.js 24 + yarn 1.22 | 运行时，`pg`（PostgreSQL 驱动）已随依赖安装，无需单独装 |
| PostgreSQL | 业务库，需先建好库与账号 |
| Redis | 令牌、频控与初始化标记缓存，多实例共用 |

### 配置环境变量

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PSW` | ✅ | 缺 `POSTGRES_HOST` 或 `POSTGRES_DB` 会直接拒绝启动 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` / `REDIS_PSW` | ✅ | 缺 `REDIS_HOST` 同样拒绝启动 |
| `SETUP_TOKEN` | 建议 | 首次创建管理员的凭据，见下文「初始化凭据」 |
| `ALLOW_SIGNUP` | 可选 | `true` 才开放自助注册，默认关闭 |
| `SMTP_*` / `WEB_URL` | 可选 | 找回密码、改邮箱激活邮件 |
| `REDIS_INIT` | 谨慎 | `true` 时启动即 `flushdb`，会清掉全部缓存 |

### 安装与启动

```bash
yarn install

# 开发（热重载；NODE_ENV=dev 时 TypeORM 会自动同步表结构）
yarn start:dev

# 生产
yarn build
yarn start:prod

# worker 常驻服务（不监听端口：定时任务 / 队列消费）
yarn start:worker:dev
yarn start:worker:prod

# 分别构建
yarn build:api
yarn build:worker
```

> ⚠️ 正式环境**不要依赖自动同步**：`synchronize` 只在 `NODE_ENV=dev|demo` 生效。
> 建表 / 加列 / 建索引请按 [`docs/auth-username-password-design.md`](./docs/auth-username-password-design.md) 4.1 节的 SQL 手工执行，
> 尤其 `users.username` 唯一索引必须先给存量行填占位值再创建。

### Docker 镜像

Dockerfile 按子应用放置：`apps/api/Dockerfile`（worker 完成后同样会在 `apps/worker/Dockerfile`）。
它是**多阶段构建**：构建阶段装全量依赖并编译，运行阶段只保留编译产物 + 生产依赖（不含源码、`typescript`、`.env`）。

```bash
# ⚠️ 构建上下文必须是仓库根目录，所以要显式指定 -f；
#    直接 `docker build apps/api` 会因为缺 package.json / tsconfig 而失败
docker build -f apps/api/Dockerfile -t atelierkit/api .
# 或
yarn docker:build:api

# 环境变量在运行时注入，镜像里不带 .env
docker run -d --name atelierkit-api -p 3000:3000 \
  --env-file .env \
  atelierkit/api
```

- 依赖排除规则读仓库根的 `.dockerignore`（Docker 只认「上下文根」那一份），各子应用共用。
- 容器内监听 `PORT`（默认 3000），源站需要改端口时加 `-e PORT=xxxx`。
- worker 与 api 是同一个镜像的两个入口，需要时用命令覆盖：

  ```bash
  docker run -d --name atelierkit-worker --env-file .env \
    atelierkit/api node dist/apps/worker/main.js
  ```

- CI（`.github/workflows/docker.yml`）：PR 只验证能否构建；推 `main` 或打 `v*` 标签时推送到 `ghcr.io/atelierkit/api`
  （标签含 `latest` / `sha-xxx` / 语义化版本），用的是内置 `GITHUB_TOKEN`，无需额外配置 secret。

## 首次使用：创建管理员

刚部署好的库是**空的**，必须先建管理员，否则任何接口都用不了。

### 初始化状态如何判定

只看 `settings` 表里有没有 `code='init'` 这一行，**不看用户表是否为空**。
这样即便管理员被误删，系统也不会自动回到「未初始化」让任何人重新建号（防接管）。

- 未初始化时：`GET /passport/init` → `{"initialized":false}`
- 未初始化时：除 `GET /passport/init`、`POST /passport/setup`（以及展示用的 `/passport/app`、`/passport/icp`）外，
  其余 `passport` 接口一律返回 **`428`**「系统尚未初始化，请先创建管理员账号！」

### 两种建号方式

**① 走前端（推荐）**：打开 `atelierkit/web`，未初始化时会被强制跳转到「创建管理员账号」页，创建成功即自动登录。

**② 直接调接口**：

```bash
curl -X POST http://localhost:3000/passport/setup \
  -H 'content-type: application/json' \
  -H 'X-Setup-Token: <若配置了 SETUP_TOKEN 则必填>' \
  -d '{"username":"admin","password":"admin12345","email":"you@example.com"}'
```

返回体就是令牌对象（`{id, code, valid, expired, ...}`），与登录接口一致。

### 初始化凭据（`SETUP_TOKEN`）

这是 `POST /passport/setup` 的守门凭据，防止「服务刚暴露到公网、还没建号」的窗口被别人抢先建成管理员。

| 场景 | 行为 |
| --- | --- |
| `.env` 配了 `SETUP_TOKEN` | 请求头 `X-Setup-Token` 必须与之一致，否则 **`403`** |
| 未配置 | 退化为「只接受回环 / 内网来源」：`127.0.0.1`、`::1`、`10.x`、`172.16-31.x`、`192.168.x`、`fc00::/7`、`fe80::/10` |
| 经反向代理（Kong / nginx）访问 | **必须配 `SETUP_TOKEN`**：反代下对端地址恒为网关，IP 闸门等于放行所有人 |

```bash
# 生成
openssl rand -hex 16
# 写入 .env 后重启服务
SETUP_TOKEN=生成的这串
```

它是**一次性**的：初始化成功后写入 `init` 标记，再次调用 `POST /passport/setup` 直接 **`409`**，此时可以把 `SETUP_TOKEN` 从 `.env` 删掉。

### 账号与密码规则

- 用户名：3–20 位字母、数字、下划线或短横线，入库统一转小写
- 密码：8–64 位，必须同时含字母与数字，不得与用户名相同（`scrypt` 加盐哈希存储）
- 自助注册默认关闭（`POST /passport/register` 返回 `410`），账号由管理员创建；需要临时开放时设 `ALLOW_SIGNUP=true`，上限 20 个
- 登录失败 5 次锁账号 5 分钟，单 IP 每分钟 10 次

## 重置开发环境

反复验证「首次部署」流程时，把库清回未初始化状态：

```bash
yarn reset:setup
```

脚本会先备份 `users` 与 `settings(code='init')` 到系统临时目录（JSON），再删除用户、令牌与初始化标记（数据库 + Redis）。
**仅允许 `NODE_ENV=dev`**，其它环境直接拒绝执行。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 启动即退出，日志 `未配置数据库地址` / `未配置缓存地址` | `.env` 缺 `POSTGRES_HOST` / `REDIS_HOST` |
| 启动日志 `DriverPackageNotInstalledError: Please run "npm install pg"` | 依赖没装全，重跑 `yarn install` |
| 所有 `passport` 接口返回 `428` | 系统未初始化，先建管理员（见上） |
| `POST /passport/setup` 返回 `403` | 缺/错 `X-Setup-Token`，或来源不是内网且未配 `SETUP_TOKEN` |
| `POST /passport/setup` 返回 `409` | 已经初始化过了；确需重来用 `yarn reset:setup` |
| `POST /passport/login` 返回 `409` | 该账号尚未设置密码（历史数据），走 `POST /passport/reset` 重置 |

## 测试

```bash
# 单元测试
yarn test

# 端到端测试
yarn test:e2e

# 测试覆盖率（同时校验门槛，不达标直接失败）
yarn test:cov
```

覆盖率口径写在 `vitest.config.ts` 的 `coverage` 里：统计 `apps/api/**/*.ts`，排除 `*.spec.ts` 与 `test/`
（不显式圈定 include 时，v8 只统计「被测试加载过的文件」，controllers 与装配层会整个消失，数字会虚高十几个点）。

当前实测约 **91% 行 / 90% 语句 / 85% 分支**，门槛设在 89/88/83/88（行/语句/分支/函数），留 2-3 个点余量防误红。
`apps/api/main.ts`、`app.module.ts` 属于启动装配，要测就得连真实 PG/Redis，未纳入目标。

### 提交门禁（pre-commit）

仓库用 [husky](https://typicode.github.io/husky/) 挂了 `pre-commit` 钩子，**测试不通过就提交不了**：

```bash
yarn lint   # oxlint --type-aware
yarn test   # vitest run（只跑单元测试）
```

- 钩子由 `yarn install` 自动装好（`prepare: husky`，钩子定义在 `.husky/pre-commit`），新克隆的仓库无需额外操作。
- 只跑单元测试；`yarn test:e2e` 需要真实的 PostgreSQL 与 Redis，不放进本地钩子。
- 应急绕过用 `git commit --no-verify`，但 CI 的 `quality` job（`lint` + `test`）仍会拦下不合规的提交。

## 目录结构

```
apps/
├── api/                     # HTTP 接口服务
│   ├── main.ts / app.module.ts / ...
│   ├── auth/                # 访问控制模块（角色 / 用户 / 令牌）
│   ├── cloud/               # 云服务模块（密钥 / KONG 网关站点）
│   ├── tencent/             # 腾讯云模块（证书 / DNS / 域名 / CDN / 防火墙 / 轻量服务器）
│   ├── shared/              # 共用领域模块（user / token / redis / queue / monitor ...）
│   └── test/                # e2e 测试
└── worker/                  # 后台常驻服务（定时任务 / 队列消费）
    ├── main.ts
    └── worker.module.ts
libs/                        # 可复用 NestJS 库（nest g library <name>）
```

> 目录结构说明：Monorepo 下 `apps/api` 的源码直接位于其根目录（`apps/api/*.ts`），
> 不再有内层 `src/`；`apps/api/test/` 存放 e2e 测试。
>
> 路径别名：根 `tsconfig.json` 的 `paths` 声明 `@shared` → `apps/api/shared/index.ts`、`@shared/*` → `apps/api/shared/*`，
> 于是 `apps/api` 内可写 `import { SharedModule } from '@shared'`；`shared/` 内部仍走相对路径。
> `nest build` / `nest start` 会在编译期把别名改写成相对路径，运行时无需额外注册器。
> ⚠️ `apps/worker` 暂不可用该别名（不在其 project file list 内），跨 app 复用需回到 `libs/`。

## License

[MIT](./LICENSE)
