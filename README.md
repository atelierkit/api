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
- **`apps/api/admin`** —— 管理员模块（`AdminModule`），管理端自用的三块：系统配置（`/admin/setting`）、
  操作日志（`/admin/operate`）、请求日志（`/admin/req`），统一 `@Allow('admin')`。两个日志接口只读。
- **`apps/api/data`** —— 行情数据模块（`DataModule`），本地 A 股行情（证券 / 交易日历 / 日 K / 复权因子）的同步与浏览：
  写操作（`/data/sync/start`、`/data/sync/pause`）要求 `admin`；快照（`/data/sync/snapshot`）与三个只读查询
  （`/data/security`、`/data/calendar`、`/data/bar`）登录即可。数据源是 baostock 裸 TCP 协议（`data/source/`），
  **同步消费段跑在 api 进程内 ⇒ 部署必须单实例**（`onApplicationBootstrap` 的僵尸对账在多副本下会互抢正在跑的执行）。
  进度推送走 `DataGateway`（socket.io，只发 `data:changed` 信号、数值仍走 HTTP 快照）；**网关必须开 `cors`**，
  因为 web 与 api 不同源。经 nginx 同机反代时还要**单独放行 `/socket.io/` 并开启 WebSocket 升级**
  （`proxy_http_version 1.1` + `Upgrade`/`Connection` 头，且 `proxy_pass` 末尾不带 `/`）：
  漏了这条，握手会落到前端的 SPA 兜底上返回 `index.html`，实时通道静默退化为 5 秒轮询
  （页面顶部提示「实时通道未连接」）。nginx 写法见 `atelierkit/web` 的 README「部署 → 1.2 nginx 站点」一节。
  快照的 `recent` 同时返回活跃执行与最近 10 条已结束执行（否则失败原因随着收尾一起消失），
  `queue` 计数走 `count()` 而不是「取一页再数」（后者会被 `take` 钉死在页长）。
  行情表（`securities` / `trade_calendar` / `bars` / `adjust_factors` / `data_coverage` / `sync_tasks` / `sync_runs`）
  落同库 public，DDL 见 `apps/api/data/entities/schema.ddl.sql`（含两条 synchronize 生成不了的**部分唯一索引**，须手工执行）。
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

### 部署形态速览

| # | 方式 | 适用场景 | PostgreSQL / Redis 位置 | 需要的工具 |
| --- | --- | --- | --- | --- |
| [1](#1-直接部署宿主机无容器) | 直接部署 | 单机、不引入容器 | 宿主机或外部实例 | Node 24 + yarn + systemd |
| [2](#2-单容器部署api-容器--宿主机中间件) | 单容器部署 | 只容器化应用，中间件留在宿主机 | 宿主机或外部实例 | Docker |
| [3](#3-直接多容器部署docker-run) | 直接多容器部署 | 全部容器化，但不引入编排 | 同网络内的容器 | Docker |
| [4](#4-docker-compose-部署) | Docker Compose | 单机自托管（**推荐**） | 同 compose 内的容器 | Docker Compose v2 |
| [5](#5-kubernetes-部署) | Kubernetes | 已有集群、要声明式发布 | 集群内或外部托管 | kubectl |
| [6](#6-环境变量参考) | 环境变量参考 | 以上任意方式 | — | — |

**以下三条约束对所有方式都成立**，选型前先读：

1. **`apps/api` 必须单实例运行。** 行情同步的消费段跑在 api 进程内（`onApplicationBootstrap` 会做僵尸执行对账），
   多副本会互抢同一条正在跑的执行。⇒ 不要 `--scale api=2`，不要 HPA，Kubernetes 用 `replicas: 1` + `strategy: Recreate`。
2. **产物与镜像里都没有 `.env`。** 配置只能从外部注入；缺 `POSTGRES_HOST` 或 `REDIS_HOST` 会直接拒绝启动（键位见 §6）。
3. **生产环境不会自动建表。** `synchronize` 只在 `NODE_ENV=dev|demo` 生效（`apps/api/app.module.ts`），
   而镜像内置的是 `NODE_ENV=production` ⇒ 空库首次启动**不会建任何表**，必须先按 §1.3 处理（最容易踩的一步）。

### 前置资源

所有方式都要先备好这两样，连接信息写进 `.env`：

| 资源 | 要求 |
| --- | --- |
| PostgreSQL | 一个空库 + 专用账号（需建表权限），表统一落 `public` |
| Redis | 一个实例，建议开密码；不要与其它业务共用 `REDIS_DB`（令牌、频控、初始化标记都在这） |

可选：域名 + 反向代理。**走反代时必须配 `SETUP_TOKEN`**（见 §6.4），否则初始化接口对所有人敞开。

### 1. 直接部署（宿主机，无容器）

#### 1.1 安装依赖与配置

```bash
git clone https://github.com/atelierkit/api.git
cd api
yarn install --frozen-lockfile    # 编译需要 devDependencies（nest cli / typescript）
cp .env.example .env              # 至少改 POSTGRES_* / REDIS_* / SETTING_KEY
```

- Node **24**、yarn **1.22**：仓库带 `yarn.lock`，换用其它包管理器不会锁到同一套版本。
- `.env.example` 里 `POSTGRES_*` / `REDIS_*` 默认指向 `127.0.0.1`，直连本机中间件时保持原样即可。

#### 1.2 编译

```bash
yarn build:api      # → dist/apps/api/main.js
yarn build:worker   # → dist/apps/worker/main.js（需要定时任务 / 队列消费时）
```

两条命令的产物互不覆盖（实测先 api 后 worker，`dist/apps` 下同时存在 `api` 与 `worker`）。

#### 1.3 建表（生产首次部署必做）

`NODE_ENV=production` 下 TypeORM 不做任何表结构同步，空库直接启动会因缺表报错。按场景二选一：

**A. 全新空库** —— 借 `demo` 让 `synchronize` 建一次，再切回生产：

```bash
# ① 以 demo 起一次，建出全部实体表（含行情表），看到
#    "Nest application successfully started" 后 Ctrl-C
NODE_ENV=demo node dist/apps/api/main.js

# ② 补 synchronize 生成不了的部分唯一索引（见下方「行情表」）

# ③ 校验并以生产模式启动
NODE_ENV=production node dist/apps/api/main.js
```

**B. 从旧私有库升级** —— 执行 `docs/auth-username-password-design.md` 4.1 节的迁移 SQL。
⚠️ 那段是 `ALTER TABLE`（假设表已存在），**不是**从零建表脚本：空库执行会直接报 `relation "users" does not exist`。
且顺序不能打乱（先加列 → 回填占位用户名 → 最后建唯一索引），否则唯一索引在第一行之后就冲突。

**行情表的附加 DDL**：`apps/api/data/entities/schema.ddl.sql` 是**带说明的 Markdown**（正文里只有三段 SQL 代码块），
不是可直接 `psql -f` 执行的脚本。`synchronize` 会建表，但生成不了两条部分唯一索引
（`IDX_sync_runs_plan` / `IDX_sync_runs_active`）—— 少了它们，重复入队不会被挡住。抽出 sql 段执行：

```bash
export PG_URL="postgresql://$POSTGRES_USER:$POSTGRES_PSW@$POSTGRES_HOST:5432/$POSTGRES_DB"
awk '/^```sql$/{f=1;next} /^```$/{f=0} f' apps/api/data/entities/schema.ddl.sql \
  | psql "$PG_URL" -v ON_ERROR_STOP=1
```

文件里所有语句都是 `IF NOT EXISTS`，重复执行安全。

#### 1.4 启动

```bash
NODE_ENV=production node dist/apps/api/main.js
NODE_ENV=production node dist/apps/worker/main.js   # 可选
```

- `.env` 由 `@nestjs/config` 按**进程工作目录**加载（顺序 `.env.$APP_PROFILE` → `.env`），
  必须在仓库根启动，否则等同于没配（启动即报「未配置数据库地址」）。
- 真实环境变量优先于 `.env` 文件（dotenv 不覆盖已存在的同名变量），所以 systemd 的 `Environment=` 能覆盖文件里的值。
- 就绪标志是日志中的 `Nest application successfully started`；容器场景建议用 `GET /passport/init` 探活（§2.3）。

#### 1.5 用 systemd 托管

`/etc/systemd/system/atelierkit-api.service`：

```ini
[Unit]
Description=atelierkit api
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=atelierkit
WorkingDirectory=/opt/atelierkit/api
EnvironmentFile=/opt/atelierkit/api/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/apps/api/main.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

worker 同构，只改 `Description` 与 `ExecStart`（`dist/apps/worker/main.js`）。
`apps/api/main.ts` 已调 `enableShutdownHooks()`，SIGTERM 会走优雅关闭（Redis 连接、串行队列），不要用 `SIGKILL`。

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now atelierkit-api
journalctl -u atelierkit-api -f
```

> `EnvironmentFile` 与 `docker --env-file` 的解析规则不同：systemd 认引号与行内注释，Docker 原样当值。
> 同一份 `.env` 两边共用时，值里只写字面量（不加引号、不加行尾注释）。

#### 1.6 反向代理

同机 nginx / Kong 除 HTTP 外还要放行 `/socket.io/` 并允许 WebSocket 升级，否则实时通道静默退化为 5 秒轮询
（页面顶部常驻「实时通道未连接」）。完整写法与验证步骤见 `atelierkit/web` 仓库 README 的「部署 → 1.2 nginx 站点」一节。

### 2. 单容器部署（api 容器 + 宿主机中间件）

#### 2.1 构建镜像

```bash
# ⚠️ 构建上下文必须是仓库根：缺 package.json / tsconfig / libs 会构建失败
docker build -f apps/api/Dockerfile -t atelierkit/api:local .
# 或
yarn docker:build:api
```

多阶段构建：构建阶段装全量依赖并编译，运行阶段只保留 `dist` + 生产依赖（不含源码、typescript、`.env`）。
也可以直接用 CI 产出的镜像 `ghcr.io/atelierkit/api:latest`（另有 `sha-xxx` 与 `v1.2.3` 标签，回滚用 sha）。

#### 2.2 运行

```bash
docker run -d --name atelierkit-api --restart always \
  -p 3000:3000 \
  --env-file .env \
  -e TZ=Asia/Shanghai \
  atelierkit/api:local
```

四个必须知道的点：

1. **容器内的 `127.0.0.1` 是容器自己。** `.env` 里的 `POSTGRES_HOST` / `REDIS_HOST` 要改成宿主机可达地址：

   ```bash
   docker run ... --add-host=host.docker.internal:host-gateway \
     -e POSTGRES_HOST=host.docker.internal -e REDIS_HOST=host.docker.internal ...
   ```

   Linux 上还需：PG `listen_addresses='*'` + `pg_hba.conf` 放行 docker 网段；Redis `bind 0.0.0.0` + `requirepass`。
   若宿主机中间件本身也是容器，直接用 §3 的同网络方案更省事。

2. **端口两侧必须一致。** 容器内监听 `PORT`（默认 3000），`-p 3000:3000` 与之对齐；改成 `-e PORT=8080` 时映射要跟着改。

3. **`--env-file` 不做去转义处理。** 文件里带 `\r`（Windows 下编辑过）会把回车读进变量值，口令从此永远对不上。
   启动前先自查：`grep -c $'\r' .env` 应为 `0`（非 0 就先 `sed -i 's/\r$//' .env`，否则口令里会混入回车）。

4. **这个镜像只含 api。** `Dockerfile` 跑的是 `yarn build:api`，容器里没有 `dist/apps/worker`。
   需要 worker 就把该行改成 `RUN yarn build:api && yarn build:worker` 后重建，再用命令覆盖启动：

   ```bash
   docker run -d --name atelierkit-worker --restart always \
     --env-file .env atelierkit/api:local node dist/apps/worker/main.js
   ```

#### 2.3 健康检查

服务**没有** `/health` 端点（根路径返回 404）。用 `GET /passport/init` 代替：它是公开接口，且会真的查一次库：

```bash
docker exec atelierkit-api wget -qO- http://127.0.0.1:3000/passport/init
# {"initialized":false}
```

镜像本身没有 `HEALTHCHECK`，需要时在 `docker run` 上补：

```bash
  --health-cmd 'wget -qO- http://127.0.0.1:3000/passport/init >/dev/null || exit 1' \
  --health-interval 30s --health-timeout 3s --health-retries 3
```

### 3. 直接多容器部署（docker run）

全部容器化又不引入编排时的顺序化命令：**PG / Redis / api / worker 挂同一个自定义网络**，用容器名互连。

#### 3.1 网络与数据卷

```bash
docker network create atelierkit
docker volume create atelierkit-pg
docker volume create atelierkit-redis
```

#### 3.2 中间件

```bash
docker run -d --name atelierkit-pg --network atelierkit --restart always \
  -e POSTGRES_DB=atelierkit -e POSTGRES_USER=atelierkit -e POSTGRES_PASSWORD='替换为强口令' \
  -e PGDATA=/var/lib/postgresql/data \
  -v atelierkit-pg:/var/lib/postgresql/data \
  postgres:18-alpine

docker run -d --name atelierkit-redis --network atelierkit --restart always \
  -v atelierkit-redis:/data \
  redis:8-alpine redis-server --appendonly yes --requirepass '替换为强口令'
```

- `PGDATA` 显式指定：`postgres:18` 镜像改了默认数据目录，不写死的话换大版本时卷的挂载位置会对不上。
- Redis 不开 `appendonly` 时重启会丢令牌（表现为所有人被登出）。

#### 3.3 api 与 worker

`.env` 里把地址换成**容器名**（不是 `127.0.0.1`）：

```dotenv
POSTGRES_HOST=atelierkit-pg
REDIS_HOST=atelierkit-redis
REDIS_PSW=与上面 requirepass 一致
```

```bash
docker run -d --name atelierkit-api --network atelierkit --restart always \
  -p 3000:3000 --env-file .env -e TZ=Asia/Shanghai atelierkit/api:local

# 需要 worker 时（镜像须含 dist/apps/worker，见 §2.2 第 4 点）
docker run -d --name atelierkit-worker --network atelierkit --restart always \
  --env-file .env -e TZ=Asia/Shanghai atelierkit/api:local node dist/apps/worker/main.js
```

#### 3.4 首次建表

先按 §1.3 让 api 以 `demo` 建一次表（`-e NODE_ENV=demo` 起容器，建完删掉该容器再按生产起），
再用 PG 容器里的 `psql` 补部分唯一索引：

```bash
awk '/^```sql$/{f=1;next} /^```$/{f=0} f' apps/api/data/entities/schema.ddl.sql \
  | docker exec -i atelierkit-pg psql -U atelierkit -d atelierkit -v ON_ERROR_STOP=1
```

#### 3.5 升级与回滚

```bash
docker pull ghcr.io/atelierkit/api:sha-1a2b3c4    # ① 先拉，拉不到就别动在跑的容器
docker rm -f atelierkit-api                       # ② 再删（同名容器无法原地换镜像）
docker run -d --name atelierkit-api ... ghcr.io/atelierkit/api:sha-1a2b3c4   # ③ 按原参数重建
```

顺序不能反：先删后拉，镜像源抖动时会把在跑的服务直接弄下线。
把这三步写成一个脚本复用即可：先拉后删、启动后校验容器仍在跑、失败时打印最近日志。

### 4. Docker Compose 部署

单机自托管的推荐方式。把下面内容存为**仓库根目录**的 `docker-compose.yml`，与 `.env` 同层：

```yaml
name: atelierkit

services:
  postgres:
    image: postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PSW}
      PGDATA: /var/lib/postgresql/data
      TZ: Asia/Shanghai
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}']
      interval: 10s
      timeout: 5s
      retries: 10

  redis:
    image: redis:8-alpine
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes', '--requirepass', '${REDIS_PSW}']
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD-SHELL', 'redis-cli -a ${REDIS_PSW} ping | grep -q PONG']
      interval: 10s
      timeout: 5s
      retries: 10

  api:
    image: ghcr.io/atelierkit/api:latest
    # 本地构建时改用下面一行（上下文是仓库根）
    # build: { context: ., dockerfile: apps/api/Dockerfile }
    restart: unless-stopped
    env_file: .env
    environment:
      # 容器间互连走服务名，覆盖 .env 里的 127.0.0.1
      POSTGRES_HOST: postgres
      REDIS_HOST: redis
      NODE_ENV: production
      TZ: Asia/Shanghai
    ports:
      - '3000:3000'
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/passport/init >/dev/null || exit 1']
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 40s

  # worker 需要镜像内含 dist/apps/worker（见 §2.2 第 4 点），默认不启动
  worker:
    image: ghcr.io/atelierkit/api:latest
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_HOST: postgres
      REDIS_HOST: redis
      NODE_ENV: production
      TZ: Asia/Shanghai
    command: ['node', 'dist/apps/worker/main.js']
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    profiles: ['worker']

volumes:
  pg-data:
  redis-data:
```

常用命令：

```bash
docker compose up -d                    # 起 api + 中间件（worker 属 profile，不含在内）
docker compose --profile worker up -d   # 连 worker 一起起
docker compose ps
docker compose logs -f api
docker compose pull && docker compose up -d   # 升级：只重建有变化的服务
docker compose down                     # ⚠️ 不要加 -v：会连数据卷一起删（等于删库）
```

四个容易出问题的点：

1. **`env_file` 与 `${}` 插值是两件事。** Compose 用**compose 文件所在目录的 `.env`** 做变量替换，
   `env_file` 才是注入进容器的配置。因为此处两者是同一份文件，**别在 `.env` 的值里写 `${...}` 或裸 `$`**
   （会被 Compose 提前展开成空串，口令静默变空）。若把 compose 放进 `deploy/`，必须
   `docker compose --env-file .env -f deploy/docker-compose.yml up -d`，否则 `${POSTGRES_DB}` 之类为空、PG 起不来。
2. **改 `.env` 后 `docker compose up -d` 不会重建容器**，要 `docker compose up -d --force-recreate api`。
3. **不要给 api 配 `deploy.replicas`**（见开头约束 1）。
4. **`REDIS_PSW` 留空时**，`--requirepass ${REDIS_PSW}` 会以「空口令」启动，healthcheck 的 `-a` 也传空串。
   要么在 `.env` 里设一个强口令（推荐），要么把 compose 里的 `--requirepass` 与 healthcheck 的 `-a` 一并删掉。

### 5. Kubernetes 部署

前提：镜像已推到集群可拉的仓库（CI 推 `ghcr.io/atelierkit/api`，私有仓库需配 `imagePullSecrets`）；
PostgreSQL / Redis 建议用集群外的托管实例或独立 StatefulSet，与本清单解耦。

#### 5.1 命名空间与配置

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: atelierkit
---
apiVersion: v1
kind: Secret
metadata:
  name: atelierkit-api
  namespace: atelierkit
type: Opaque
stringData:
  POSTGRES_HOST: postgres.example.internal
  POSTGRES_PORT: '5432'
  POSTGRES_DB: atelierkit
  POSTGRES_USER: atelierkit
  POSTGRES_PSW: '替换为强口令'
  REDIS_HOST: redis.example.internal
  REDIS_PORT: '6379'
  REDIS_DB: '0'
  REDIS_PSW: '替换为强口令'
  SETUP_TOKEN: 'openssl rand -hex 16 的结果'
  SETTING_KEY: 'openssl rand -hex 32 的结果'
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: atelierkit-api-config
  namespace: atelierkit
data:
  NODE_ENV: production      # ⚠️ 不要用 dev/demo：那会让 synchronize 在生产库上改表
  PORT: '3000'
  TZ: Asia/Shanghai
  ALLOW_SIGNUP: 'false'
  WEB_URL: https://www.example.com/
```

#### 5.2 Deployment（api）

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: atelierkit
spec:
  replicas: 1                    # ⚠️ 必须是 1，见开头约束 1
  strategy:
    type: Recreate               # 单副本下 RollingUpdate 会短暂出现两个实例
  selector:
    matchLabels: { app: atelierkit-api }
  template:
    metadata:
      labels: { app: atelierkit-api }
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: api
          image: ghcr.io/atelierkit/api:latest
          imagePullPolicy: IfNotPresent
          ports:
            - { name: http, containerPort: 3000 }
          envFrom:
            - secretRef: { name: atelierkit-api }
            - configMapRef: { name: atelierkit-api-config }
          readinessProbe:        # 走公开接口且会查库 ⇒ 数据库没通就不接流量
            httpGet: { path: /passport/init, port: http }
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:         # 只做 TCP 探活：库挂了重启进程治不了库，别用 readiness 的路径
            tcpSocket: { port: http }
            initialDelaySeconds: 30
            periodSeconds: 20
            timeoutSeconds: 3
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 1Gi }
```

`apps/api/main.ts` 已 `enableShutdownHooks()`，SIGTERM 会优雅关闭 Redis 连接与串行队列，
`terminationGracePeriodSeconds: 30` 足够。**不要加 HPA**；单副本下 PDB 也没有意义。

> 镜像默认以 root 运行（Dockerfile 没有 `USER`），上面用 `runAsUser: 1000` 收窄权限；
> 容器只读 `dist` 与 `node_modules`，不需要写盘。若日后镜像自建用户，把 UID 改成与之一致即可。

#### 5.3 Service 与 Ingress

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: atelierkit
spec:
  selector: { app: atelierkit-api }
  ports:
    - { name: http, port: 3000, targetPort: http }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: atelierkit
  namespace: atelierkit
  annotations:
    # 实时通道（socket.io）：默认 60s 空闲读超时会把 WebSocket 掐断
    nginx.ingress.kubernetes.io/proxy-read-timeout: '600'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '600'
    nginx.ingress.kubernetes.io/proxy-buffering: 'off'
spec:
  ingressClassName: nginx
  rules:
    - host: www.example.com
      http:
        paths:
          # 实时通道：路径原样透传（后端网关的 path 就是 /socket.io）
          - path: /socket.io
            pathType: Prefix
            backend: { service: { name: api, port: { name: http } } }
          # 前端静态站点
          - path: /
            pathType: Prefix
            backend: { service: { name: web, port: { name: http } } }
---
# /api 前缀必须剥掉才能对上后端的路由（后端没有 /api 段），
# 而 rewrite-target 是「整个 Ingress 生效」的注解，所以单独一个 Ingress 承载
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: atelierkit-api-prefix
  namespace: atelierkit
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/proxy-read-timeout: '600'
spec:
  ingressClassName: nginx
  rules:
    - host: www.example.com
      http:
        paths:
          # 前端 baseUrl 写 /api/ 时，/api/passport/init → /passport/init
          - path: /api(/|$)(.*)
            pathType: ImplementationSpecific
            backend: { service: { name: api, port: { name: http } } }
```

- `/socket.io` **不能剥前缀**（后端握手路径就是 `/socket.io`），也不能和 `rewrite-target` 放在同一个 Ingress 里。
- `/api` 这条规则要求前端 `config.json` 的 `baseUrl` 写 `/api/`；若不想在网关做 strip，就干脆去掉这条规则，
  把 `baseUrl` 填成后端的绝对地址（`https://api.example.com/`），此时后端需单独暴露域名或端口。
- `web` 是独立镜像与 Deployment（见 `atelierkit/web` 仓库 README 的部署章节），本节只覆盖 API。

#### 5.4 worker（可选）

与 api 同一镜像、只换启动命令，同样单副本：

```yaml
      containers:
        - name: worker
          image: ghcr.io/atelierkit/api:latest
          command: ['node', 'dist/apps/worker/main.js']
          envFrom:
            - secretRef: { name: atelierkit-api }
            - configMapRef: { name: atelierkit-api-config }
```

⚠️ 前提是镜像里真有 `dist/apps/worker`；当前 Dockerfile 只编译 api，见 §2.2 第 4 点。

#### 5.5 建表

生产 `NODE_ENV` 不是 dev/demo，空库不会自动建表。两种做法：

- **一次性 Pod**：临时以 `NODE_ENV=demo` 起一个 api Pod（`kubectl run` + `--env`），确认表建好后删除；
- 或用 `psql` 镜像跑一次 DDL（行情表的两条部分唯一索引必须手工建，见 §1.3）。

验证表结构就绪：

```bash
kubectl -n atelierkit exec deploy/api -- wget -qO- http://127.0.0.1:3000/passport/init
# {"initialized":false}
```

### 6. 环境变量参考

配置来源优先级（高 → 低）：**进程环境变量 / `docker -e` / k8s `envFrom`** > **`.env.$APP_PROFILE`** > **`.env`**。
`.env.example` 是模板：`cp .env.example .env` 后只改需要改的项。

#### 6.1 应用

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | 建议 | 无（镜像内置 `production`） | 只认 `dev` / `demo` / `production`。**仅 `dev`、`demo` 会同步表结构**；`production` 下不建表也不改表 |
| `PORT` | 否 | `3000` | HTTP 监听端口；容器里改它要同步改 `-p` 映射 |
| `APP_PROFILE` | 否 | 空 | 非空时额外加载 `.env.$APP_PROFILE`（同机多环境用）；留空只读 `.env` |

#### 6.2 数据库（PostgreSQL）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `POSTGRES_HOST` | ✅ | — | 缺失直接拒绝启动 |
| `POSTGRES_PORT` | 否 | `5432` | |
| `POSTGRES_DB` | ✅ | — | 缺失直接拒绝启动 |
| `POSTGRES_USER` | ✅ | — | 缺失直接拒绝启动 |
| `POSTGRES_PSW` | ✅ | — | 缺失直接拒绝启动。口令含 `$`、`#`、空格时，注意 Compose 会展开 `${}`（见 §4） |

#### 6.3 缓存（Redis）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `REDIS_HOST` | ✅ | — | 缺失直接拒绝启动 |
| `REDIS_PORT` | 否 | `6379` | |
| `REDIS_DB` | 否 | `0` | 令牌、频控、初始化标记都落这个库 |
| `REDIS_PSW` | 否 | 空 | 空串表示无密码；目标实例开了密码就**必须填**，否则连接被拒 |
| `REDIS_INIT` | 否 | `false` | `true` 时启动即 `flushdb`。**只在重置环境时开**，生产误开会清掉全部会话 |
| `BULL_DB` | 否 | `1` | 队列独立库号，`REDIS_INIT` 清库时按它避让（当前队列为进程内实现，仅保留配置位） |

#### 6.4 初始化与安全

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `SETUP_TOKEN` | 反代部署时必填 | 空 | `POST /passport/setup` 的守门凭据（请求头 `X-Setup-Token`）。配了则强校验（不一致 `403`）；不配则退化为「只接受回环 / 内网来源」。**经 nginx / Kong 反代时必须配**：对端地址恒为网关，IP 闸门等于放行所有人。初始化成功后即失效，可从配置里删掉。生成：`openssl rand -hex 16` |
| `SETTING_KEY` | 用邮件时必填 | 空 | 系统设置里敏感值（当前是 SMTP 授权码）的 AES-256-GCM 密钥。缺失时**保存邮件配置、发信都直接报错**（不会退化为明文存储）。生成：`openssl rand -hex 32`。⚠️ 更换后库里旧密文解不开，需在「系统设置 → 邮件配置」重填授权码 |
| `ALLOW_SIGNUP` | 否 | `false` | 仅 `true` 时开放 `POST /passport/register`，否则返回 `410`；账号由管理员创建（上限 20 个） |

#### 6.5 邮件（无环境变量）

邮件配置**没有任何环境变量入口**：2026-11-01 起改在「系统设置 → 邮件配置」里维护并落库
（`settings.code='email'`，授权码用 `SETTING_KEY` 加密后存储），运行时**完全不读**
`SMTP_HOST` / `SMTP_PORT` / `SMTP_ACCOUNT` / `SMTP_PASSWORD` / `SMTP_USER`。

`.env` 与 `.env.example` 里的 SMTP 段已于 2026-11-02 删除。从旧版本升级的部署若 `.env` 里还留着这五个键，
既不会生效也不会报错：管理页只会提示一次（接口返回 `envDetected`，探测函数见 `shared/email/email.config.ts` 的 `hasEnvSmtp`），
确认新配置可用后自行删掉即可。邮件功能唯一必填的环境变量是 `SETTING_KEY`，见 §6.4。

#### 6.6 前端地址

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_URL` | 找回密码 / 邮箱激活需要 | `.env.example` 里是 `http://localhost:4200/` | 邮件里链接的前缀。代码是直接拼接（`WEB_URL + passport/activate/...`），**末尾必须带 `/`**，否则链接会拼成 `...4200passport/...` |

前端侧没有「运行时环境变量」：后端地址由 web 的 `assets/config.json` 提供，与本节的 `WEB_URL` 是两套东西，
改 `WEB_URL` 不会改变前端请求哪个后端。

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
│   ├── admin/               # 管理员模块（系统配置 / 操作日志 / 请求日志）
│   ├── cloud/               # 云服务模块（密钥 / KONG 网关站点）
│   ├── tencent/             # 腾讯云模块（证书 / DNS / 域名 / CDN / 防火墙 / 轻量服务器）
│   ├── data/                # 行情数据模块（同步 + 浏览；source/ 协议层、sync/ 同步引擎、entities/ 数据模型）
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
