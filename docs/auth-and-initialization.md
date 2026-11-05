# 登录、初始化与会话（实现说明）

> 范围：`apps/api` 的 `passport` / `user` / `token` / `setup` 模块，以及前端 `atelierkit/web` 需要遵守的契约。
> 本文描述的是**当前生效的实现**；代码与本文不一致时以代码为准，并同步修正本文。

## 1. 认证模型

- 凭据是**用户名 + 密码**，单步登录，不依赖 SMTP（邮件只用于重置密码与更换邮箱）。
- 密码只以 **scrypt 加盐哈希**落库；任何接口、日志、操作记录都不出现明文与哈希。
- 会话仍是 Redis 里的令牌：请求头 `token: <用户ID>:<随机码>`，有效期档位（60 / 1440 / 10080 / 43200 / 0 分钟）由用户自己的 `token_valid` 决定。
- 同一账号可在多台设备同时在线，**每台设备只保留一个令牌**（见第 7 节）。
- 账号来源只有两个：首次部署的 `setup`，以及管理员在「用户管理」里创建。自助注册默认关闭。

## 2. 数据模型

`users` 表在基础字段之外有三列与登录相关：

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `username` | `text` | `NOT NULL DEFAULT ''`，唯一索引 | 登录名，入库前归一化 |
| `password` | `text` | `NOT NULL DEFAULT ''`，实体上 `select: false` | scrypt 哈希串；空串表示尚未设密 |
| `password_at` | `bigint` | `NOT NULL DEFAULT 0` | 密码最后修改时间（毫秒） |

- `users_logs` 同步带 `username` 列，保持日志表与主表字段对齐。
- `email` 是**可空列**：邮箱降级为可选资料后，多个用户都不填会都存成空串而撞上唯一索引（PostgreSQL 的唯一索引不限制多个 `NULL`，但限制多个空串）。`users_logs.email` 同为可空。
- `password` 上的 `select: false` 很关键：`show()` / `index()` 用的是 select 白名单，任何 `find()` 全字段查询也不会带上哈希，比逐个方法补字段安全。

`production` 下 `synchronize` 不生效，建库 / 加列必须手工执行：

```sql
ALTER TABLE users      ADD COLUMN IF NOT EXISTS username    text   NOT NULL DEFAULT '';
ALTER TABLE users      ADD COLUMN IF NOT EXISTS password    text   NOT NULL DEFAULT '';
ALTER TABLE users      ADD COLUMN IF NOT EXISTS password_at bigint NOT NULL DEFAULT 0;
ALTER TABLE users      ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users_logs ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users_logs ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT '';

-- 已有数据先填占位用户名，再建唯一索引（空串会在第二行就撞索引）
UPDATE users SET username = 'u' || id WHERE username = '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);
```

## 3. 用户名与密码规则

- **用户名**：`trim()` + `toLowerCase()` 后必须匹配 `^[a-z0-9_-]{3,20}$`；不使用保留字机制（`admin` 是否管理员由角色决定，与名字无关）。
- **密码**：长度 8–64，必须同时含字母与数字，不得与用户名相同（大小写不敏感）。不强制符号与大写，避免个人工具记不住。
- **哈希格式**（自描述，便于以后升级参数）：

```
scrypt$N$r$p$<saltBase64>$<hashBase64>
参数：N=16384, r=8, p=1, keylen=64, salt=16B, maxmem=64MB
```

校验用 `crypto.timingSafeEqual`。工具在 `shared/user/password.util.ts`（纯函数，可单测）：

```ts
export function hashPassword(plain: string): Promise<string>;
export function verifyPassword(plain: string, stored: string): Promise<boolean>;
```

常量集中在 `shared/user/user.constant.ts`：`USERNAME_RE`、`PASSWORD_MIN/MAX`、`SCRYPT_*`、`LOGIN_FAIL_MAX=5`、`LOGIN_FAIL_TTL=600`、`LOGIN_LOCK_TTL=300`、`LOGIN_LIMIT_PER_MINUTE=10`、`CHECK_LIMIT_PER_MINUTE=3`、`RESET_VALID_MINUTES=2`、`RESET_FAIL_MAX=5`、`EMAIL_CHANGE_VALID_MINUTES=2`、`EMAIL_CHANGE_FAIL_MAX=5`、`USER_MAX=20`。

## 4. 接口清单

### 4.1 免登录（`/passport`）

| 方法 | 路径 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/passport/init` | — | `{initialized: boolean}` | 前端整页加载时探测一次 |
| POST | `/passport/setup` | `{username, password, email?, name?, avatar?, deviceId?}` + 头 `X-Setup-Token`（可选） | 令牌对象 | 只在未初始化时可用，成功即登录 |
| POST | `/passport/login` | `{username, password, deviceId?}` | 令牌对象 | 用户名密码登录 |
| POST | `/passport/check` | `{username}` | `{exists: boolean}` | 初始化页查重，IP 限流 |
| POST | `/passport/reset` | `{email}` | `{code, msg}` | 发重置密码验证码（6 位，2 分钟有效） |
| POST | `/passport/reset/confirm` | `{email, code, password}` | `{code, msg}` | 校验验证码并改密 |
| POST | `/passport/register` | `{username, password, name?, avatar?, email?}` | 用户ID | 仅 `ALLOW_SIGNUP=true` 时可用，否则 `410` |
| GET | `/passport/app`、`/passport/icp` | — | 展示配置 | 建号页与页头渲染用 |

### 4.2 登录后（`/user`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/user/password` | 改密：校验旧密码，保留当前令牌、作废其它令牌 |
| POST | `/user/email` | 向**新邮箱**发 6 位验证码，此时尚未改绑 |
| POST | `/user/email/confirm` | 校验验证码后才落库 |
| POST | `/user/refresh`、`/user/valid`、`DELETE /user/logout` | 令牌续期、档位调整、登出（与登录方式无关） |

前端页面只需要 `passport` 与上述 `user` 接口，没有「激活链接」类回调页。

## 5. 首次部署初始化

### 5.1 状态判定与存储

**不用「users 表是否为空」判定** —— 那会留下接管漏洞：管理员被误删 ⇒ 系统回到未初始化 ⇒ 任何人都能重新建成管理员。改为一次性标记：

`settings` 表加一行 `code='init'`，`value = { at, username, version }`：

- 存在 ⇒ 已初始化；不存在 ⇒ 未初始化。
- 标记**只由 `setup` 写入，任何业务流程都不删它**。删光用户也仍然是「已初始化」，回到未初始化只能由运维显式执行（第 9 节）。

读取路径：Redis 键 `init`（无 TTL）→ 未命中查 `settings` → 命中后回填。**只缓存正向结果**：未初始化只存在于极短窗口，缓存它反而拖慢首次 setup。

### 5.2 闸门顺序

`POST /passport/setup` 按下列顺序校验，任何一步失败即返回：

```
1. 已初始化？(Redis → settings)                        → 409「系统已完成初始化」
2. 防护闸门
   ├ 配了 SETUP_TOKEN ⇒ 校验 X-Setup-Token（定长时间比较） → 403
   └ 没配 ⇒ 校验 socket 对端地址 ∈ 回环/内网              → 403
3. IP 限流（5 次/分钟）                                 → 429 + Retry-After
4. 用户名 / 密码策略、邮箱归一化                          → 400
5. 事务：INSERT settings(code='init') ON CONFLICT DO NOTHING
   ├ 影响 0 行 ⇒ 并发中被抢先                            → 409
   └ 插入管理员（roles=['admin'], status=true）
6. 出事务：回填 Redis → 写操作日志（operate: 'setup'）→ 签发令牌返回
```

- 密码哈希在事务外算（scrypt 约 50–100ms），不长时间占用事务。
- **并发正确性完全押在 `settings.code` 主键上**：两个请求同时进来只有一个能拿到 `RETURNING` 行，另一个 409，不需要分布式锁。
- ⚠️ 闸门读的是 `req.socket.remoteAddress`，**不能用 `getClientIp()`**：后者无条件采信 `X-Forwarded-For` / `X-Real-IP`（见 `req.decorator.ts`），客户端自填一个内网地址就能过闸。
- ⚠️ 反代（nginx / Kong）部署下对端地址恒为网关 ⇒ IP 闸门等价于「放行所有人」。**反代部署必须配 `SETUP_TOKEN`**，IP 分支只服务「本机直连首次启动」。

### 5.3 守卫

`SetupGuard` 注册为**第一个** `APP_GUARD`（Nest 按 providers 数组顺序执行，必须排在 `TokenGuard` 之前）：

```
path = req.path
if (!path.startsWith('/passport')) return true        // 其余路径由令牌守卫把关，空库发不出令牌
if (白名单：GET /passport/init、POST /passport/setup、
          GET /passport/app、GET /passport/icp) return true
if (await setupSrv.ready()) return true
throw new HttpException('系统尚未初始化，请先创建管理员账号！', 428)
```

- 只查 `/passport` 前缀，正常业务请求零额外开销（不增加 Redis 往返）。
- 用 `428` 而不是 `403`：语义是「缺前置条件」，前端可按状态码专跳初始化页，不与「用户被禁用」的 `403` 混淆。Nest 12 没有 `PreconditionRequiredException` 类，只能 `new HttpException(msg, HttpStatus.PRECONDITION_REQUIRED)`。

### 5.4 自助注册开关

| `ALLOW_SIGNUP` | `POST /passport/register` |
| --- | --- |
| 未设置 / `false` | `410`「系统已关闭自助注册！」 |
| `true` | 可用，仍受 `USER_MAX=20` 限制 |

`setup` 创建的管理员不计入上限判断（它是唯一入口、必然只有一次）。

## 6. 登录、改密、重置、改邮箱

### 6.1 登录

```
POST /passport/login {username, password, deviceId?}
  ├─ 1. IP 限流（10 次/分钟，login）                     → 429
  ├─ 2. 账号冷却：存在 loginLock:<username>?              → 429（带剩余秒数）
  ├─ 3. 归一化 username，查用户（含 password）
  │     └─ 未命中：仍跑一次 dummy 哈希校验（对齐耗时）    → 401
  ├─ 4. status=false                                     → 403
  ├─ 5. password 为空串                                   → 409（引导去重置）
  ├─ 6. verifyPassword
  │     ├─ 失败：incr loginFail:<username>（TTL 600s）
  │     │        ≥5 次 → set loginLock:<username>（TTL 300s）→ 429
  │     │        否则 401
  │     └─ 成功：del loginFail:<username>
  ├─ 7. 清理该设备上一次的令牌
  ├─ 8. 写登录统计 + 操作日志（operate: 'login'）
  └─ 9. 签发令牌并返回
```

第 3 步的 dummy 校验：账号不存在时也跑一次 `verifyPassword(password, 固定假哈希)`，让两种失败耗时接近（scrypt 单次 50–100ms，差异足够被看出）。

### 6.2 改密

登录态调用 `POST /user/password`：校验 `oldPassword` → 校验新密码策略且不得与旧密码相同 → 更新 `password` / `password_at` → 保留当前令牌、作废该用户其它设备的令牌。

### 6.3 重置密码

`POST /passport/reset` 发 6 位验证码到邮箱（IP 限流 + 邮箱 1/min，2 分钟有效），`POST /passport/reset/confirm` 校验验证码（错 5 次作废）→ 改密 → 作废该用户**全部**令牌。邮箱不存在时同样返回通用文案且不发信，避免枚举。

### 6.4 更换邮箱

`POST /user/email` 把验证码发到**新邮箱**，`POST /user/email/confirm` 校验通过后才写入 `users.email`。安全前提是「能收到新邮箱的信件才算拥有它」，因此流程不产生任何链接，也不需要前端回调页。

库里密码为空串的账号（手工导入或早期建号）登录会返回 `409`，由用户走重置密码设密。

## 7. 令牌与多设备

- 缓存键 `token:<用户ID>:<随机码>`（哈希结构），设备标识作为哈希字段 `device` 保存；请求头、令牌守卫、续期、登出都不区分设备。
- 设备标识由前端生成并持久化（`localStorage` 的 `atelierkit.device`），登录 / 初始化时随请求体 `deviceId` 上报。格式 `^[A-Za-z0-9_-]{8,64}$`，缺失或非法归入统一分组 `unreported`（等价于「所有未上报设备共用一个会话」），保证 curl、脚本与旧客户端仍能登录。
- 单账号最多 20 个并发设备（`TOKEN_DEVICE_MAX`），超出按令牌创建时间淘汰最旧的会话。
- 库里没有 `device` 字段的历史令牌无法归属到具体设备，一律视为可被本次登录清理，避免新旧会话并存。

## 8. 状态码与文案

| 场景 | 状态码 | 文案 |
| --- | --- | --- |
| 未初始化时访问除白名单外的 passport 接口 | `428` | 系统尚未初始化，请先创建管理员账号！ |
| 重复初始化 | `409` | 系统已完成初始化，无法重复创建管理员！ |
| 初始化凭据缺失/错误 | `403` | 初始化凭据无效或来源不被允许！ |
| 用户名或密码错误 / 账号不存在 | `401` | 用户名或密码不正确！（两者同一文案，防枚举） |
| 用户被禁用 | `403` | 用户已被禁用！ |
| 账号尚未设密 | `409` | 该账号尚未设置密码，请先通过邮箱重置密码！ |
| 失败超限 / 频控 | `429` + `Retry-After` | 密码错误次数过多，请 N 秒后再试！ |
| 注册重名 | `409` | 用户名 xxx 已被占用！ |
| 注册超上限 / 已关闭 | `409` / `410` | 当前系统限制最大用户数为 20，已关闭注册！ / 系统已关闭自助注册！ |

## 9. 运维：把系统放回未初始化态

只在整库重装或确实要换管理员时使用：

```sql
DELETE FROM settings WHERE code = 'init';
```

```bash
# 同步清缓存，否则后端仍认为已初始化
redis-cli -n <REDIS_DB> DEL init
```

- ⚠️ 执行后任何能访问服务的人都能建成管理员 —— 必须在维护窗口内做，做完立刻 `setup`。
- ⚠️ **删用户不等于重置**：`init` 标记还在，删光用户也回不到初始化页，这正是防接管的设计意图。
- 开发环境反复验证首次部署流程时，用 `yarn reset:setup`（仅 `NODE_ENV=dev`）一次清掉用户、令牌与标记。

## 10. 前端契约

- **每次整页加载**探测一次 `GET /passport/init`，不是每次路由切换。
- `initialized === false` ⇒ 路由锁：只允许初始化页，其余目标地址（直接输 URL、刷新、前进后退）一律重定向；同时隐藏登录入口。
- **探测失败不等于已初始化**：网络 / 5xx 要显示「服务暂不可用」+ 重试，放行到登录页会让用户以为「账号丢了」。
- **不要在客户端持久化 init 结果**（`localStorage` / `sessionStorage` 都不要）：库可能被重建，缓存会导致该初始化却直接进登录页。
- 初始化页不能有「跳过」：这是硬闸门，不是首启引导。成功后后端已返回令牌，前端不需要再调登录。
- 业务接口的 `401` 与初始化态的 `428` 要分开处理：`428` 跳初始化页，`401` 回登录页。

## 11. 测试口径

单测（`*.spec.ts`，用替身隔开 `Repository` / `RedisService` / `EmailService`）：

- `password.util`：盐随机（同密码两次哈希不同）、正确/错误密码、脏格式串不抛崩（返回 `false`）、`DUMMY_HASH` 可校验。
- `setup`：空库 `ready()` 为 false；`setup()` 成功写入 `init` 行 + `roles=['admin']` + 返回令牌；重复调用 409；并发两次只有一次成功（断言 `ON CONFLICT` 的 0 行分支）；缺 `SETUP_TOKEN` 且来源非内网 403；`SETUP_TOKEN` 配了但头不对 403。
- `SetupGuard`：未初始化时 `POST /passport/login` 428；白名单放行；已初始化后全部放行；非 `/passport` 路径不查缓存。
- `login`：不存在 → 401 且不泄露；密码错 → 计数 +1；第 5 次 429 并写入锁；锁定期间 429；禁用 403；`password=''` 409；成功 → 清同设备旧令牌 + 更新统计 + 返回令牌。
- `register`：`ALLOW_SIGNUP` 关闭 410；重名 409；`23505` 冲突转 409；上限 20；密码策略不达标 400。
- `password`（改密）：旧密码错 401、新旧相同 400、成功后其它令牌失效。
- `reset`：验证码错 5 次作废；邮箱不存在不发送但仍返回通用文案。
