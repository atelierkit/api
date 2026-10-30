# 登录方式改造设计：邮箱验证码 → 用户名 + 密码

> 状态：**已按「推荐」列落地第一版代码**（P1–P6 完成；P7 需真实 PG/Redis 环境，待你本地跑）
> 范围：本文只覆盖 `atelierkit/api`（`apps/api` 的 `passport` / `user` / `token` / `setup` 模块）；前端 `atelierkit/web` 的联调改造另行安排。
> 更新：2026-10-29（补充「首次部署初始化 Setup」设计见 4.6；实现差异见第 11 节）

## 1. 背景与目标

当前登录是「邮箱 → 收验证码 → 验证码换令牌」的两步流程，账号标识是**邮箱**，用户表里没有密码列。
目标改成**用户名 + 密码**单步登录，同时保留令牌（Redis）这一套会话机制不变。

达成标准：

- 一条 `POST /passport/login`（`username` + `password`）即可拿到令牌，不再依赖 SMTP。
- 密码只以**加盐哈希**落库，任何接口/日志都不出现明文与哈希。
- 有防爆破（IP 维度 + 账号维度）、有账号枚举防护、禁用用户即时拦截。
- 现有令牌签发/续期/作废语义（`token_valid` 档位、单会话清理）保持不变。
- **首次部署**（库里一个用户都没有）时，前端被强制引导到「创建管理员账号」页，未初始化完成前拿不到任何其它能力（见 4.6）。

## 2. 现状盘点

### 2.1 登录链路（改造前）

```
POST /passport/status    {email}              → {id, status}        查是否已注册
POST /passport/captcha   {email}              → {code, msg}         发邮件验证码（IP 3/min、邮箱 1/min）
POST /passport/verify    {code, captcha}      → token 哈希对象       校验验证码 → 签发令牌
POST /passport/register  {name, avatar, email} → 用户ID             注册（首个用户自动 admin，上限 20 个）
POST /passport/activate  {code}               → {code, msg}        邮箱修改激活（走邮件链接）
```

登录成功后 `UserService.verify()` 做四件事：清该用户全部旧令牌 → 写登录统计（`loginTimes` / `firstLoginAt` / `lastLoginAt` / `lastSessionAt`）→ 记操作日志（`operate: 'login'`）→ `redisSrv.addCode('token:<id>', 60, valid, {id, valid})` 签发令牌。

### 2.2 涉及文件

| 文件 | 与登录相关的内容 |
| --- | --- |
| `shared/passport/passport.controller.ts` | `status` / `captcha` / `verify` / `register` / `activate` / `app` / `icp` |
| `shared/user/user.service.ts` | `status()` / `captcha()` / `verify()` / `register()` / `email()` / `activate()` / `limitByIp()` / `normalizeEmail()` / `normalizeValid()` / `session()` |
| `shared/user/user.dto.ts` | `RegisterDto`（name/avatar/email）、`UserUpdateDto`、`TokenValidDto` |
| `shared/user/user.entity.ts` | `users` 表：`email` 唯一索引；`users_logs` 表 |
| `shared/token/token.service.ts` | `refresh()` / `applyValid()` / `destroy()`（**本次不改**） |
| `shared/token/token.guard.ts` | 全局守卫：`/passport` 前缀免令牌；其余校验 `token` 头（**基本不改**） |
| `shared/setting/setting.entity.ts` | `settings` 表（`code` 主键 + json `value`，带创建/更新审计列），本次用来存「已初始化」标记 |
| `shared/req/req.decorator.ts` | `getClientIp()` —— 无条件采信 `X-Forwarded-For`，初始化闸门**不能**用它（见 4.6.2） |
| `shared/email/email.service.ts` | 发验证码/激活邮件（是否保留取决于决策 3） |

### 2.3 现有可复用的东西

- `limitByIp(ip, action, max)` —— IP 维度频控，抛 `RetryAfterException`（429 + `Retry-After` 头，已有全局过滤器）。
- `redisSrv.addCode()` / `set(..., 'EX', 60, 'NX')` —— 序列码与「1 分钟锁」的现成写法。
- 令牌与「登录成功后清旧令牌」的整套逻辑：`verify()` 里那段可以直接平移到 `login()`。
- `ValidationPipe({ whitelist: true })` 已全局启用 —— DTO 加装饰器即生效，未装饰字段会被静默剥掉。

## 3. 决策点（需要你拍板）

| # | 问题 | 推荐 | 备选与影响 |
| --- | --- | --- | --- |
| 1 | **邮箱还留不留？** | **留**：`username` 作登录凭据，`email` 降级为可选资料（用于后续找回密码/通知） | 若「彻底删邮箱」：`users.email` 唯一索引、`/user/email`、`/passport/activate`、`EmailService` 全部下线，改动面大一倍，且以后做找回密码要重新引入 |
| 2 | **注册入口开不开？** | **仅保留「首次初始化」这一个建号入口**：首次部署走 `/passport/setup` 建管理员（首个用户即 admin），之后 `/passport/register` **默认关闭**（返回 410），账号改由管理员创建（本期先只留接口位，管理端后续做）；如需临时开放，用 `ALLOW_SIGNUP=true` 显式打开 | 若「继续开放自助注册」：任何人只要拿到地址就能注册，配合「上限 20」早晚被占满，个人工具场景不合适；若「完全删掉 register」：临时加人只能改库，保留一个受开关控制的入口成本更低 |
| 3 | **验证码流程怎么处理？** | **登录用的 `captcha`/`verify` 删掉**；把「邮箱验证码」保留为**找回密码**用途（`/passport/reset` 两步：发码 + 校验改密） | 若「全删」：老用户（只有邮箱、无密码）将无法自助设密，只能手工跑 SQL 写初始哈希；且 `EmailService` 可一起删 |
| 4 | **密码哈希用什么？** | **Node 内置 `crypto.scrypt`**（零依赖、无原生编译，避开本机 SAC 拦截未签名二进制的坑） | `argon2` / `bcrypt`：生态更主流，但要装原生包、有编译与跨平台风险；本机历史上被 SAC 成簇拦过本地编译产物 |
| 5 | **初始化端点怎么防「抢先建号」？** | **`SETUP_TOKEN` 环境变量为主闸门**（配了就校验 `X-Setup-Token` 头），**IP 白名单只作单机/直连场景的便利**（未配 token 时生效） | 若「完全不设防」：服务一旦在公网可达且尚未初始化，任何先到的人都能建成管理员（这是本设计里唯一的高危窗口）；⚠️ 若「只用 IP 白名单」：反代/Kong 后面 `remoteAddress` 恒为网关地址 ⇒ 等于放行所有人，且 `getClientIp()` 无条件信任 `X-Forwarded-For`（客户端自填 `127.0.0.1` 即可绕过），所以 IP 不能当主闸门 |

下文按「推荐」列展开；选了备选我再调整。

## 4. 目标设计

### 4.1 数据模型

`users` 表新增两列（`users_logs` 同步加 `username`，保持日志表与主表字段对齐）：

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `username` | `text` | `NOT NULL DEFAULT ''`，**唯一索引** | 登录名，入库前归一化（见 4.2） |
| `password` | `text` | `NOT NULL DEFAULT ''`，`select: false` | scrypt 哈希串；空串 = 尚未设密（老数据） |
| `password_at` | `bigint` | `NOT NULL DEFAULT 0` | 密码最后修改时间（改密后作废旧令牌用） |

⚠️ **`email` 改为可空**（`text NULL`，原来是 `NOT NULL DEFAULT ''`）：邮箱降级为可选资料后，多个用户都不填就会都存成空串，**撞上 email 的唯一索引**（PostgreSQL 的唯一索引不限制多个 NULL，但会限制多个空串）。`users_logs.email` 同步改可空，否则后台回填日志时会被非空约束打断。

实体侧：

```ts
// users
@Column({ type: 'text', name: 'username', default: '' })
@Index({ unique: true })
username!: string;

/** 密码哈希，注：select:false ⇒ 默认不查出来，登录时显式 addSelect */
@Column({ type: 'text', name: 'password', default: '', select: false })
password!: string;

@Column({ type: 'bigint', name: 'password_at', default: 0 })
passwordAt!: number; // AfterLoad 里 Number() 归一
```

> `select: false` 很关键：`show()` / `index()` 这些既有方法用的是 select 白名单，但**任何 `find()` 全字段查询都不会带上哈希**，比逐个方法补字段安全。

**迁移 SQL**（`synchronize` 只在 `dev`/`demo` 生效，正式库必须手工执行）：

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS username   text   NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password   text   NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_at bigint NOT NULL DEFAULT 0;

-- 邮箱降级为可选资料：存量若都是空串则不能直接建唯一索引，先转 NULL
ALTER TABLE users      ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users_logs ALTER COLUMN email DROP NOT NULL;

-- 老数据先填占位用户名，再建唯一索引（空串会在第二行就撞索引）
UPDATE users SET username = 'u' || id WHERE username = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);

ALTER TABLE users_logs ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT '';
```

老数据 `username` 为空串会让唯一索引在第一行之后冲突 —— 所以**迁移分两步**：先加列，再用 `UPDATE users SET username = 'u' || id WHERE username = ''` 填占位值，最后建唯一索引（顺序写进运维脚本，别一把梭）。

### 4.2 用户名与密码规则

- **用户名归一化**：`trim()` + `toLowerCase()`，与既有 `normalizeEmail()` 同一风格；`^[a-z0-9_-]{3,20}$`（忽略大小写输入），保留字 `admin` 不予特殊处理（首个用户自动 admin 角色，与名字无关）。
- **密码策略**：长度 8–64；必须同时含字母与数字；不允许与用户名相同（大小写不敏感）。不做过度的「大小写+符号」强制，避免个人工具自己都记不住。
- **哈希格式**（自描述，便于以后升级参数）：

```
scrypt$N$r$p$<saltBase64>$<hashBase64>
例：scrypt$16384$8$1$<24B salt>$<64B hash>
```

参数：`N=16384, r=8, p=1, keylen=64, salt=16~24B randomBytes`；校验用 `crypto.timingSafeEqual`；参数变更时可在登录成功后就地重算并升级哈希（本期不做，先留格式）。

工具位置：`shared/user/password.util.ts`（纯函数，便于单测）

```ts
export function hashPassword(plain: string): Promise<string>;
export function verifyPassword(plain: string, stored: string): Promise<boolean>;
```

### 4.3 接口清单

| 方法 | 路径 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/passport/init` | — | `{initialized: boolean}` | **新增**，免令牌；前端每次整页加载探测一次（见 4.6） |
| POST | `/passport/setup` | `{username, password, email?, name?, avatar?}` + 头 `X-Setup-Token`（可选，视决策 5） | 令牌对象 | **新增**，免令牌；**只在未初始化时可用**，成功后直接登录 |
| POST | `/passport/login` | `{username, password}` | 令牌对象（同现有 `verify`） | **新增**，登录 |
| POST | `/passport/register` | `{username, password, name?, avatar?, email?}` | 用户ID | **改**，去验证码；**初始化后默认关闭**（`ALLOW_SIGNUP=true` 才开，否则 410） |
| POST | `/passport/check` | `{username}` | `{exists: boolean}` | **改**（替代 `/passport/status`），仅注册页查重用，IP 限流 |
| POST | `/passport/captcha` | — | — | **删除**（决策 3 推荐） |
| POST | `/passport/verify` | — | — | **删除**（决策 3 推荐） |
| POST | `/passport/reset` | `{email}` | `{code: 0, msg}` | **新增**（决策 3 推荐：找回密码，第一步发码） |
| POST | `/passport/reset/confirm` | `{email, code, password}` | `{code: 0, msg}` | **新增**（第二步：校验验证码并改密） |
| POST | `/user/password` | `{oldPassword, newPassword}` | `{code: 0, msg}` | **新增**，登录后改密 |
| POST | `/passport/activate` | `{code}` | 不变 | 保留（改邮箱激活） |
| POST | `/user/email` | `{email}` | 不变 | 保留（改邮箱，走邮件链接） |
| POST | `/passport/status` | — | — | **删除**（被 `check` 取代） |

令牌相关（`/user/refresh`、`/user/valid`、`DELETE /user/logout`）**完全不动**，请求头仍是 `token: <id>:<随机码>`。

状态码约定（沿用现有风格，中文文案）：

| 场景 | 状态码 | 文案示例 |
| --- | --- | --- |
| 系统尚未初始化（访问除 init/setup 外的任何 passport 接口） | `428` | 系统尚未初始化，请先创建管理员账号！ |
| 重复初始化 / 已初始化后调 setup | `409` | 系统已完成初始化，无法重复创建管理员！ |
| setup 缺少/错误的防护凭据 | `403` | 初始化凭据无效或来源不被允许！ |
| 用户名或密码错误 | `401` | 用户名或密码不正确！ |
| 账号不存在 | `401`（**与密码错同一文案**，防枚举） | 用户名或密码不正确！ |
| 用户被禁用 | `403` | 用户已被禁用！ |
| 账号尚未设密（老数据） | `409` | 该账号尚未设置密码，请先通过邮箱重置密码！ |
| 失败次数超限 / 频控 | `429` + `Retry-After` | 密码错误次数过多，请 N 秒后再试！ |
| 注册重名 | `409` | 用户名 xxx 已被占用！ |
| 注册超上限 / 已被关闭 | `409` / `410` | 当前系统限制最大用户数为 20，已关闭注册！ / 系统已关闭自助注册！ |

### 4.4 登录流程

```
POST /passport/login {username, password}
  ├─ 1. IP 限流 limitByIp(ip,'login',10)               → 超限 429
  ├─ 2. 账号维度冷却：exists(`loginLock:<username>`)?      → 429（带剩余秒数）
  ├─ 3. 归一化 username，查用户（含 password）
  │     └─ 未命中：仍跑一次 dummy hash 校验（对齐耗时）→ 401
  ├─ 4. status=false → 403
  ├─ 5. password 为空串 → 409（提示去重置）
  ├─ 6. verifyPassword
  │     ├─ 失败：incr `loginFail:<username>`（TTL 600s，首击设）
  │     │        ≥5 次 → set `loginLock:<username>` TTL 300s → 429
  │     │        否则 401
  │     └─ 成功：del `loginFail:<username>`
  ├─ 7. 清该用户全部旧令牌（scan `token:<id>:*` + pipeline.del）
  ├─ 8. 写登录统计 + 操作日志（operate: 'login'）
  └─ 9. addCode('token:<id>', 60, valid, {id, valid}) → 返回令牌
```

第 3 步的 dummy 校验：账号不存在时也跑一次 `verifyPassword(password, 固定假哈希)`，让两种失败耗时接近，避免用响应时间探测账号是否存在（`scrypt` 单次 ~50–100ms，差异足够被看出）。

### 4.5 注册、改密、重置

- **注册**：`limitByIp(ip,'register')` → **先判 `ALLOW_SIGNUP`（关则 410）** → 归一化 username → 查重（`existsBy`，并兜住 `23505` 唯一索引冲突，写法沿用现有 `register()`）→ 校验密码策略 → `hashPassword()` → 插入（**永不回显 password**）。`email` 可选，给了就做格式校验与唯一性校验。首个用户自动 `['admin']` 这条**移交给 `setup`**（见 4.6），`register` 不再承接「首个用户即管理员」。
- **改密**（登录态）：校验 `oldPassword` → 校验新密码策略且不得与旧密码相同 → 更新 `password` / `password_at` → **保留当前令牌、作废该用户其它令牌**（或按需全作废，让前端重新登录；推荐「保留当前、清其它」）。
- **找回密码**（决策 3 推荐保留）：`POST /passport/reset` 第一步 `{email}` 走 IP 限流 + 邮箱 1/min，发 6 位验证码（复用 `addCode('reset', 100, 2, {id})`，模板文案换成「重置密码」）；第二步 `{code, password}` 校验验证码（失败计数照抄现有 `loginFail` 逻辑，5 次作废）→ 改密 → 作废该用户全部令牌。
- **老用户**（`password` 为空）：登录返回 409 并引导到 `/passport/reset`；若决策 3 选「全删验证码」，则改为运维脚本 `scripts/set-password.mjs`（读 SQL 生成哈希）手工处理。

### 4.6 首次部署初始化（Setup）

**目标**：空库（一个用户都没有）时系统处于「未初始化」态，前端**强制**只显示「创建管理员账号」页；初始化完成后该入口永久关闭。这一节只写后端，前端契约见第 9 节。

#### 4.6.1 状态判定与存储

**不用「users 表是否为空」判定** —— 那会留下接管漏洞：管理员被误删 ⇒ 系统回到未初始化 ⇒ 任何人都能重新建成管理员。改为**一次性标记**：

`settings` 表（已有表，`code` 是主键、`value` 是 json）加一行：

| 列 | 值 |
| --- | --- |
| `code` | `'init'` |
| `value` | `{ at: 时间戳, username: 管理员名, version: 1 }` |

- 存在 ⇒ 已初始化；不存在 ⇒ 未初始化。
- 标记**只由 setup 写入，任何业务流程都不删它**。即使用户表被清空，系统也保持「已初始化」，只能由运维手工重置（见 6.3）—— 把「回到 setup 态」从「自动发生」改成「显式决策」。

读取路径：Redis key `init`（**无 TTL**）→ 未命中则查 `settings` → 命中则回填。**只缓存正向结果**（未初始化只存在于极短窗口，缓存它反而会拖慢首次 setup）。

#### 4.6.2 接口

**`GET /passport/init`**（免令牌，不进任何守卫的校验分支）→ `{initialized: boolean}`

只回一个布尔。不回用户数、初始化时间、版本 —— 对未授权调用者没用，却是信息泄露。

**`POST /passport/setup`** → 令牌对象（与 `login` 同一形状）

入参 `{username, password, email?, name?, avatar?}`，可选头 `X-Setup-Token`（决策 5）。闸门顺序：

```
1. 已初始化？(Redis → settings)                          → 409「系统已完成初始化」
2. 防护闸门（决策 5，详见下方注意）
   ├ 配了 SETUP_TOKEN ⇒ 校验 X-Setup-Token 头，不符         → 403
   └ 没配 ⇒ 校验 req.socket.remoteAddress ∈ 回环/内网       → 403
3. IP 限流 limitByIp(ip, 'setup', 5)                     → 429
4. DTO 校验（用户名/密码策略复用 4.2）                     → 400
5. 事务：INSERT settings(code='init') ON CONFLICT DO NOTHING
   ├ 影响 0 行 ⇒ 并发中被抢先                            → 409
   └ 插入管理员用户（roles=['admin'], status=true, password=hash）
6. 出事务：set Redis `init` → 写操作日志（operate: 'setup'）→ 签发令牌并返回
```

> ⚠️ **IP 闸门必须读 `req.socket.remoteAddress`，不要用 `getClientIp()`**：后者无条件采信 `X-Forwarded-For` / `X-Real-IP`（见 `req.decorator.ts`），任何客户端自己加一个 `X-Forwarded-For: 127.0.0.1` 就能过闸。
> ⚠️ 反代（Kong）部署下 `remoteAddress` 恒为网关地址 ⇒ IP 闸门等价于「放行所有人」。**所以 `SETUP_TOKEN` 才是主闸门**，公网/反代部署必须配它；IP 分支只服务「本机直连首次启动」这种场景。`SETUP_TOKEN` 建议用 `openssl rand -hex 16` 生成，初始化完成后可以从 `.env` 里删掉（标记已在库里，端点直接 409）。

**并发正确性完全押在 `settings.code` 主键上**：两个请求同时进来只有一个能拿到 `RETURNING` 行，另一个 409，不需要分布式锁。

```sql
INSERT INTO settings (code, value, status,
                      create_user_id, create_at,
                      update_user_id, update_operate, update_operate_id, update_req_id, update_at)
VALUES ('init', $1::json, true, 0, $2, 0, 'setup', 0, 0, $2)
ON CONFLICT (code) DO NOTHING
RETURNING code;
-- $1 = {"at":1698600000000,"username":"admin","version":1}
```

> 列名取自 `CreateEntity` / `UpdateEntity` 的嵌入前缀（`create_*` / `update_*`），`_operate` 等 NOT NULL 且无默认值的列必须显式给值，否则插入直接报错。

#### 4.6.3 守卫：未初始化时关掉其它 passport 接口

新增 `SetupGuard`（`shared/setup/setup.guard.ts`），注册为**第一个** `APP_GUARD`（Nest 按 providers 数组顺序执行，必须排在 `TokenGuard` 之前）：

```
path = req.path
if (!path.startsWith('/passport')) return true            // 其余路径都要令牌，空库不可能有令牌
if (白名单命中) return true                                // GET /passport/init、POST /passport/setup
                                                          // 另含 GET /passport/app、GET /passport/icp（纯展示配置，建号页要渲染页头）
if (await setupSrv.ready()) return true                   // Redis 命中，零 DB
throw new HttpException('系统尚未初始化，请先创建管理员账号！', 428)
```

- **为什么不全路径检查**：非 `/passport` 的第一道关是令牌，没有用户就发不出令牌，天然进不来。只查 passport ⇒ 正常业务请求**零额外开销**（不增加 Redis 往返）。
- **为什么 428 而不是 403**：语义上是「缺前置条件」，且前端可按状态码专跳 setup 页，不会与「用户被禁用」的 403 混淆。
- ⚠️ **Nest 12 没有 `PreconditionRequiredException` 类**：`HttpStatus.PRECONDITION_REQUIRED = 428` 存在，但 `exceptions/index.d.ts` 里没有对应异常类，只能 `new HttpException(msg, HttpStatus.PRECONDITION_REQUIRED)`。

#### 4.6.4 与注册的关系

初始化之后 `register` 默认关闭（决策 2），开关 `ALLOW_SIGNUP`：

| `ALLOW_SIGNUP` | `POST /passport/register` |
| --- | --- |
| 未设置 / `false` | `410`「系统已关闭自助注册！」 |
| `true` | 保留原逻辑（含上限 20） |

`setup` 创建的用户不计入「上限 20」判断（它本身就是唯一入口、必然只有一次）。

### 4.7 安全要点（逐条落进代码）

1. `password` 列 `select: false`；任何 DTO/返回值不含密码字段；`UserEntity` 不实现 `toJSON` 暴露。
2. 请求体不进日志：`req` 表目前无 payload 列，**改造期间也不要加**；`operate` 的 `remark` 不得写密码。
3. 枚举防护：登录失败文案与耗时对齐；`/passport/check` 只回 `exists`，且 IP 限流（3/min）。
4. 爆破防护：账号维度 5 次/10 分钟 → 锁 5 分钟；IP 维度 10 次/分钟；两者都用现成 `RetryAfterException` 返回 `Retry-After`。
5. 令牌仍走 Redis（多实例可用），`token_valid` 档位（60/1440/10080/43200/0）不变。
6. 改密/重置后作废旧令牌；禁用用户由 `TokenGuard` 在每次请求时拦（已实现，不改）。
7. **初始化窗口是本设计里唯一的高危面**：`setup` 必须过决策 5 的防护闸门；`init` 只回布尔；标记不可自动重建（4.6.1）；`setup` 的请求体同样**不进日志**，操作日志只写 `operate: 'setup'` + 用户名，不写密码。

## 5. 代码改动清单

| 文件 | 动作 |
| --- | --- |
| `shared/user/user.constant.ts` | **新增**：`PASSWORD_MIN/MAX`、`SCRYPT_N/R/P/KEYLEN`、`LOGIN_FAIL_MAX=5`、`LOGIN_FAIL_TTL=600`、`LOGIN_LOCK_TTL=300`、`USERNAME_RE` |
| `shared/user/password.util.ts` | **新增**：`hashPassword` / `verifyPassword` / `DUMMY_HASH` |
| `shared/user/user.entity.ts` | 加 `username` / `password` / `passwordAt` 三列 + `username` 唯一索引；`users_logs` 加 `username` |
| `shared/user/user.dto.ts` | 新增 `LoginDto`、`RegisterDto`(重写)、`PasswordDto`、`ResetDto`；`UserUpdateDto` / `TokenValidDto` 不动 |
| `shared/user/user.service.ts` | 新增 `login()` / `password()` / `reset()`；`register()` 改写（哈希 + username 查重 + `ALLOW_SIGNUP` 开关）；新增 `findByUsername()` 私有方法；`status()` → `check()`；删除 `captcha()` / `verify()` / `normalizeEmail()` 的登录用途（改邮箱仍需要，保留） |
| `shared/setup/setup.service.ts` | **新增**：`ready()`（Redis → settings 回填）、`setup()`（事务 + `ON CONFLICT` 闸门 + 建管理员 + 签发令牌） |
| `shared/setup/setup.guard.ts` | **新增**：全局守卫，未初始化时只放行 `GET /passport/init` 与 `POST /passport/setup`（4.6.3） |
| `shared/setup/setup.dto.ts` | **新增**：`SetupDto`（复用 `RegisterDto` 的字段校验）；`INIT_SETTING_CODE='init'` 常量 |
| `shared/index.ts` | 聚合导出 `SetupGuard` / `SetupService` |
| `shared/shared.module.ts` | providers 加 `SetupService`；exports 加 `SetupService` |
| `apps/api/app.module.ts` | providers 里 `APP_GUARD: SetupGuard` **放在 `TokenGuard` 之前**（顺序即执行顺序） |
| `.env.example` | 加 `SETUP_TOKEN=`（留空 = 走内网 IP 闸门）与 `ALLOW_SIGNUP=false`，并写注释说明 |
| `shared/passport/passport.controller.ts` | 新增 `init` / `setup` / `login` / `check` / `reset`；删除 `status` / `captcha` / `verify`；`register` 入参改 DTO |
| `shared/user/user.controller.ts` | 新增 `POST /user/password` |
| `shared/user/user.service.ts` 的 `show()` / `index()` | select 白名单补 `username`（管理员列表与 `startup` 都要能用用户名展示）；**不补 `password`** |
| `shared/token/token.guard.ts` | 仅把日志里的 `user.email` 换成 `user.username`（`status` select 需带上 `username`） |
| `docs/` | 本文；另出一份「前端联调变更点」给 `atelierkit/web` |

不改：`token.service.ts`、`redis.service.ts`、`queue`、`email.service.ts`（保留邮箱能力）、`setting` 模块（只往 `settings` 表写一行 `code='init'`，不加接口）。

## 6. 迁移、部署与回滚

### 6.1 上线顺序

1. **先跑 SQL 加列**（可空/默认值，不阻塞旧版本）。
2. **部署新版本**。
3. **立刻完成初始化**：打开前端会自动跳到「创建管理员」页；也可直接 `curl -X POST /passport/setup`。此时服务已可达但还没有管理员，是**唯一的高危窗口**（决策 5 的闸门就是为它设的），别拖到第二天。
4. 老用户首次登录走 `reset` 设密（或运维脚本批量设初始密码）。

### 6.2 回滚

- 旧版本不读 `username/password`，新列保留即可回退；**已改密的老用户回退后仍需验证码登录**（邮箱还在），不会被锁死。
- 已初始化过的库回滚到旧版本：旧版本不认识 `settings` 里的 `init` 行，也不会读它（`settings` 表本来就存在，多一行不影响任何逻辑）；再升回新版本时仍是「已初始化」，**不会**重新弹出 setup 页。

### 6.3 回到未初始化态（运维操作，慎用）

```sql
DELETE FROM settings WHERE code = 'init';
```

```bash
# 同时清缓存，否则后端仍认为已初始化
redis-cli -n <REDIS_DB> DEL init
```

- 用途只有两个：**整库重装**，或**确实要换管理员**。
- ⚠️ 执行后，任何能访问服务的人都能建成管理员 —— 必须在维护窗口内做，做完立刻 setup。
- ⚠️ **删用户不等于重置**：`init` 标记还在，删光用户也回不到 setup 页（这正是 4.6.1 的设计意图，防接管）。

### 6.4 `synchronize`

`dev`/`demo` 会自动建列，但**不会自动处理唯一索引的顺序问题**（空串仍会冲突），因此 `dev` 库建议直接重建表；`prod` 一律手工 SQL。

## 7. 实施顺序（每阶段可独立验证）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 | 常量 + `password.util.ts` + 单测 | `yarn test`（hash/verify/格式/盐随机） |
| P2 | 实体三列 + `users_logs.username` + SQL 脚本 | `tsc --noEmit`（dev 库 synchronize 或手工 SQL） |
| P3 | DTO + `UserService.login()` + `register()` 改写 | 单测：账号不存在/密码错/锁定/禁用/空密码/成功签发 |
| **P3b** | **初始化链路**：`SetupService` + `SetupGuard` + `/passport/init` `/passport/setup` + `app.module` 注册守卫（在 `TokenGuard` 前）+ `.env.example` 补两项 | 单测：未初始化时 login 返回 428、`init` 返回 false、setup 成功签发令牌、重复 setup 409、并发 setup 只有一个成功；`curl` 手工验证 403 闸门 |
| P4 | Controller 其余接口增删（login/check/reset，删 status/captcha/verify） | 编译 + curl 全流程（见下） |
| P5 | `password()` / `reset()` / `show()` 字段补齐 | 单测 + curl |
| P6 | 删除验证码登录代码、清理文案与文档 | `yarn lint`（0 错）、全仓 `captcha` 残留检查 |
| P7 | 手工验收 | `nest build api` + `node dist/apps/api/main.js`（配 `.env`）后跑 7 条 curl |

curl 验收脚本（P7 用，**放 `scripts/` 且不含明文密码**）：

```
0 空库启动 → GET /passport/init 应 {initialized:false} → POST /passport/setup 建 admin（拿 token）
1 登录成功（拿 token）→ 2 错误密码 ×5（第 5 次应 429）
3 等待/清锁后登录 → 4 改密（旧令牌仍可用、其它令牌失效）→ 5 用新密码登录
6 再调一次 /passport/setup 应 409
```

## 8. 测试计划

单测（`*.spec.ts`，mock `Repository` / `RedisService` / `EmailService`）：

- `password.util`：同一密码两次哈希不同（盐随机）、正确密码 `true`、错误密码 `false`、脏格式串不抛崩（返回 `false`）。
- `setup`：空库时 `ready()` 为 false；`setup()` 成功 → `settings` 有 `init` 行 + 用户 `roles=['admin']` + 返回令牌；**重复调用 409**；**并发两次只有一次成功**（用 `ON CONFLICT` 的 0 行分支断言）；缺 `SETUP_TOKEN` 且来源非内网 → 403；`SETUP_TOKEN` 配了但头不对 → 403。
- `SetupGuard`：未初始化时 `POST /passport/login` → 428；`GET /passport/init`、`POST /passport/setup` 放行；已初始化后一切放行；非 `/passport` 路径直接 return true（不查 Redis，断言语义上"零额外开销"）。
- `login`：不存在 → 401 且不泄露；密码错 → 计数 +1；第 5 次 → 429 且写入锁；锁定期间 → 429；禁用 → 403；`password=''` → 409；成功 → 清旧令牌 + 更新统计 + 返回令牌。
- `register`：`ALLOW_SIGNUP` 关闭 → 410；重名 409、并发冲突（`23505`）转 409、上限 20、密码策略不达标 400。
- `password`（改密）：旧密码错 401、新旧相同 400、成功后旧令牌（除当前）失效。
- `reset`：验证码错 5 次作废、邮箱不存在不发送但仍返回通用文案（防枚举）。

## 9. 前端契约影响（`atelierkit/web`，本期不动）

### 9.1 调用变更

| 旧调用 | 新调用 |
| --- | --- |
| `POST /passport/status` | `POST /passport/check` |
| `POST /passport/captcha` + `POST /passport/verify` | `POST /passport/login` |
| 注册表单（name/avatar/email） | 加 `username` / `password`，`email` 变可选（且默认不再开放自助注册，入口按 `ALLOW_SIGNUP` 决定显隐） |
| — | 新增「创建管理员」页（仅首次）、「修改密码」「忘记密码」页（或复用现有表单） |

### 9.2 首次部署强制初始化（本次新增）

**触发时机**：每次**整页加载**（app 启动）探测一次，不是每次路由切换。

```
app 启动
 └─ GET /passport/init（不带令牌）
     ├─ initialized === false
     │   ├─ 路由锁：只允许 /setup；其余任何目标地址（直接输 URL、刷新、前进/后退）一律重定向到 /setup
     │   ├─ 隐藏登录/注册入口（别显示"去登录"，否则用户会以为能登）
     │   └─ /setup 表单：username / password / 确认密码 /（可选 email、name）
     │        └─ 提交 POST /passport/setup → 令牌对象 → 存 token → 直接进首页
     ├─ initialized === true  → 正常流程（无 token 则去登录页）
     └─ 请求失败（网络 / 5xx）
         └─ 显示「服务暂不可用」+ 重试按钮（**不要**放行到登录页）
```

**三条不可违反的规则**

1. **「探测失败」不等于「已初始化」**：否则空库时会看到登录页，输什么都 401/428，像是「账号丢了」。
2. **setup 页不能有「跳过」**：这是硬闸门，不是首启引导。
3. **不要在客户端持久化 init 结果**（`localStorage` / `sessionStorage` 都不要）：库可能被重建，缓存会导致「该初始化却直接进登录页」。每次加载探一次，成本只有一个 GET。

**Angular 侧落地建议（参考，本期不写代码）**

- `InitService`：持有 `initialized` 的**内存态** + `loading` / `error` 状态，`ensureInit()` 幂等（并发调用共享同一个 Promise）。
- `/setup` 路由守卫：`initialized === true` ⇒ 重定向 `/`（防初始化后再进来）。
- 通配路由 `**` 与登录页守卫：`initialized === false` ⇒ 重定向 `/setup`。
- 用 `APP_INITIALIZER` 在首屏前探测，避免「先闪一下登录页再跳走」。

**状态码处理**：空库时除 `init` / `setup` 外的 passport 接口一律 `428`，业务接口仍是 `401`。现有「401 → 跳登录」的拦截器需要单独识别 `428`（跳 `/setup`），否则用户手敲接口只能看到无意义报错。

**setup 成功后**：后端直接返回令牌（等同登录完成），前端**不需要**再调 `/passport/login` —— 避免「刚设完密码又要输一遍」。

## 10. 未决问题（确认后我按推荐项落地）

1. 决策 1–4 的选择（见第 3 节）。
2. 用户名是否允许中文？推荐**不允许**（`[a-z0-9_-]{3,20}`），避免不同输入法/大小写带来的重名歧义。
3. 老数据的处理方式：批量设初始密码（脚本 + 首登强制改）还是逐个走「忘记密码」？
4. `POST /user/password` 改密后是「保留当前令牌」还是「全部作废、强制重新登录」？推荐前者。
5. **初始化闸门用哪种**（决策 5）：`SETUP_TOKEN` 环境变量（推荐，容器/反代下也可靠）还是「仅内网 IP」？建议**两者都实现、token 优先**，部署时按网络形态选。
6. **初始化后是否保留自助注册**（决策 2）：建议**默认关闭**（`ALLOW_SIGNUP=false`），需要时再开。若你希望「永远不要自助注册这个入口」，我把 `register` 接口整体删掉，只留管理员建号（管理端后续做）。

## 11. 实现差异与落地清单（2026-10-29）

代码已按「推荐」列落地，与前述设计的差异如下（都是实现时才发现的具体约束）：

| # | 设计里写的 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 1 | `/passport/reset` 两个步骤同一路径 | 拆成 `POST /passport/reset`（发码）与 `POST /passport/reset/confirm`（`{email, code, password}`） | 同一路径两步的入参形状不同，靠 DTO 无法同时约束；用 email 作缓存键也不需要再维护一层序列码 |
| 2 | 白名单只有 `init` / `setup` | 另加 `GET /passport/app`、`GET /passport/icp` | 纯展示配置，建号页要用它们渲染页头 |
| 3 | `users.email` 唯一索引不变 | 改为**可空列**（`users_logs.email` 同步） | 邮箱变可选后，多个用户都不填会存成多个空串，直接撞唯一索引；NULL 之间不冲突 |
| 4 | `/passport/check` 返回 `{exists, status?}` | 只返回 `{exists}` | 少给一个可用于探测「账号是否被禁用」的字段 |
| 5 | 日志里展示 `user.email` | 改为 `user.username`；`operate` / `req` 日志的「用户」列在邮箱为空时退回用户名 | 邮箱已非必填，用它当标识会出现空值 |
| 6 | 失败计数用 `del` 清空 | 与设计一致 | — |

新增文件：

| 文件 | 内容 |
| --- | --- |
| `shared/user/user.constant.ts` | 用户名/密码规则、scrypt 参数、登录失败与锁定阈值、重置验证码参数、用户上限 |
| `shared/user/password.util.ts` | `hashPassword` / `verifyPassword` / `DUMMY_HASH`（自描述格式 `scrypt$N$r$p$salt$hash`） |
| `shared/user/password.util.spec.ts` | 5 个用例：格式、盐随机、正确/错误、脏数据、DUMMY_HASH |
| `shared/setup/setup.constant.ts` | `SETUP_SETTING_CODE='init'`、缓存键、未初始化白名单 |
| `shared/setup/setup.dto.ts` | `SetupDto extends RegisterDto` |
| `shared/setup/setup.service.ts` | `ready()` / `setup()`；主键级并发闸门；`SETUP_TOKEN` 与内网 IP 双闸门 |
| `shared/setup/setup.guard.ts` | 未初始化时对 `/passport/*` 抛 428（白名单除外） |
| `shared/setup/setup.guard.spec.ts` | 4 个用例：428、白名单放行、已初始化放行、非 passport 路径不查缓存 |

改造文件：`user.entity.ts`（三列 + 唯一索引 + 邮箱可空）、`user.dto.ts`（全部重写）、`user.service.ts`（`login` / `password` / `reset` / `sendResetCode` / `check` / `register` 重写，抽出 `issueToken` 与 `purgeTokens`）、`passport.controller.ts`、`user.controller.ts`（+`POST /user/password`）、`token.guard.ts`（标识改用 username）、`shared.module.ts`、`index.ts`、`apps/api/app.module.ts`（守卫顺序）、`operate.service.ts` / `req.service.ts`（日志用户标识）、`.env.example`（`SETUP_TOKEN`、`ALLOW_SIGNUP`）。

验证状态：`tsc --noEmit` 通过、`nest build api` 通过、`yarn lint` 0 error / 2 warning（既有两处刻意 spread）、`yarn test` 9 passed。**P7 的 curl 全流程未跑** —— 需要真实 PostgreSQL + Redis 环境，且会在库里写数据，留给你在本地按第 7 节的 7 步执行。
