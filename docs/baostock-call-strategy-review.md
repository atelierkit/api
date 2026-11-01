# 证券宝接口调用策略对照审计（开源 `api` ← 私有 `api`）

> 对照对象：私有 `D:\github\marbleqi\api\src\data\api\api.service.ts`（660 行单类）与
> 开源 `apps/api/data/source/*` + `apps/api/data/sync/*`。
> 结论一句话：**开源侧的协议层实现确实优于私有侧，不必回退；但连接生命周期、重试覆盖面、
> 运行编排三处出现倒退或缺失，共 10 项可优化，其中 4 项是确定性缺陷。**
>
> **2026-11-01 已按本报告落地 P0 全部 4 项 + P1 的 4 项（P1-3/4/5/6）+ P2 的 4 项**，落地清单见文末「七」。
> 仍未做的是 P1-1（定时调度）与 P1-2（卡死看门狗），二者需要单独立项（要新增调度模块与心跳字段）。

---

## 一、开源侧已优于私有侧（保持，不要回退）

| 维度 | 私有侧 | 开源侧 |
| --- | --- | --- |
| 代码分层 | 单类 660 行，协议/查询/解析/连接全混在一起 | `protocol`（纯函数帧编解码）/ `query`（请求构造）/ `record`（解析）/ `schema`（常量）/ `client`（IO） |
| 记录位 / 列名位 | 全局常量 `RECORD_FIELD_INDEX = 6`，调用处手传 `4/5/8/9/10`，注释自陈「传错不报错，只拿到空数组或错值」 | 逐查询携带（`BaostockQuery.recordIndex / fieldIndex`），由 `BaostockQueries.xxx()` 一次性定死 |
| 列名校验 | **完全没有**，字段名错位只会静默取到空串 | `daily-batch.ts:179 ensureRequiredFields`，首日首条记录校验列名齐全，缺失即抛 |
| 异常类型 | 纯 `Error` + 文案 | `BaostockException` + 6 种 code，`isRetryable` 可判定 |
| 会话过期 | 靠 10 分钟空闲计时器**预防**，真撞上 `10001001` 只报错 | `client.ts:90-102` 识别 `NO_LOGIN` → 重登 → 重试一次 |
| 压缩响应 | `subarray` + `inflateSync`，无边界校验 | `protocol.ts:64-72` 先校验声明长度与实际字节，再解压 |
| TCP 细节 | 未设 `setNoDelay` | `client.ts:151` 已设 |

以上都属于「开源侧做得更对」的部分，不在优化清单内。

---

## 二、确定性缺陷（P0，建议尽快修）

### P0-1 空闲期 socket 上没有 `error` 监听 —— 可能直接打挂进程  ✅ 已修

- 现状：`client.ts:164` 建连时挂 `once('error', reject)`，成功后在 `:166` 立刻
  `removeListener('error', reject)`；`sendOnce` 的 `cleanup()`（`:227-231`）又在每次请求结束时
  移除 `onError`。⇒ **两次请求之间这条 socket 上零个 `error` 监听者**。
- 后果：Node 对无监听者的 `'error'` 事件抛未捕获异常 ⇒ 进程终止。服务端空闲 RST、
  网络设备中途断开都会落到这条路径上，表现是「进程莫名重启」，日志里没有任何业务线索。
- 私有侧做法：`api.service.ts:238-253` 挂**常驻** error 监听，注释写明「避免无 error 监听者的
  Socket 把进程打挂」。
- 建议：`connect()` 成功后挂一个持久的 `socket.on('error', onSocketError)`，只做
  「记录 + `dropConnection()`」，不 reject（当前请求由 `sendOnce` 自己的监听负责）。

### P0-2 连接阶段失败不重试，且首次登录零重试  ✅ 已修

- 现状 A：`connect()` 超时抛 `BaostockException(CONNECT_FAILED)`（`:156-161`），而
  `isRetryable`（`:318-323`）只认 `TIMEOUT` ⇒ 直接抛出，一次都不重试。同样属于「建连失败」的
  `ECONNREFUSED` 抛的是裸 `Error`，反而会重试 —— **同一类故障两种待遇**，且与类头注释
  「只重试连接 / 收发阶段的失败（含建连失败）」自相矛盾。
- 现状 B：`query()` 的首次 `await this.ensureLogin()`（`:87`）在重试循环**之外** ⇒ 进程冷启动
  时的第一次建连或登录失败直接让整段同步失败。
- 私有侧做法：`api.service.ts:445-480 requestWithRetry` 把 `ensureConnected()` 放进循环内，
  建连、登录、收发一起享受 4 次尝试 + 1/2/3 秒线性退避。
- 建议：`CONNECT_FAILED` 并入可重试集合；把 `ensureLogin()` 移进 `sendWithRetry` 的重试体。

### P0-3 `pause()` 不生效，跑完还会把状态覆盖成「成功」  ✅ 已修

- 现状：`sync.service.ts:443-454` 只把 `sync_runs.state` 改成 `PAUSED`；`runDailyBatch`
  （`daily-batch.ts:121-165`）的循环里**没有任何取消检查**，`stopping` 只用于进程停机。
  ⇒ 暂停后同步照常跑到区间末尾，`finishRun`（`:275-297`）再无条件写入 `SUCCEEDED`，
  台账也已推进到末端。
- 私有侧做法：`sync.constant.ts` 定义 `STALL_TIMEOUT` / `RUNNER_RETRY`，域服务在批次边界
  检查状态；`k.service.ts:279-307` 逐日循环内可中断。
- 建议：给 `DailyBatchDeps` 加 `shouldAbort(): Promise<boolean>`，每天结束检查一次；
  命中则返回 `{ ok: true, stage: '已暂停' }`；`finishRun` 改为条件更新
  （`WHERE state = RUNNING`），避免覆盖 `PAUSED`。

### P0-4 `warnOnCountDrop` 哨兵是空块  ✅ 已修

- 现状：`daily-batch.ts:141-147` 条件成立后块内只有一行注释，**没有日志、没有回调**。
  注释宣称「只告警不阻塞」，实际什么都没做。
- 后果：当日条数骤降（数据源发布不完整 / 列名错位导致部分行被丢弃）时无任何提示，
  只能事后靠 `bars` 表的缺口发现。
- 建议：补 `logger.warn`（`client` 或 `progress` 侧注入一个 warn 通道），文案带日期、上日条数、今日条数。

---

## 三、策略缺失（P1，私有有、开源没有）

### P1-1 完全没有定时调度  ⏳ 未做（需单独立项）

`grep Cron` 在 `apps/api` 下零命中。私有侧的自动更新是完整一套：
18:30 主窗口（对齐数据源 17:30 日 K / 18:00 复权因子入库口径）+ 21:30 补偿窗口
（只补当日失败任务，或整批漏跑）+ 启动补跑（进程整天不在运行时）+ **计划日幂等闸门**
（重启多少次只产生一批）。开源侧目前只能靠控制器手动触发，这是日常可用性上最大的差距。

### P1-2 没有卡死看门狗  ⏳ 未做（需单独立项）

私有 `SYNC.STALL_TIMEOUT = 5 分钟`：超过该时长一次进度都没上报即判定卡死并失败退出，
阈值是按「30s 超时 × 4 次 + 6s 退避 ≈ 2 分钟」推出来的。开源侧 `makeProgress`
（`sync.service.ts:256-272`）只写 `stage/done/total`，不写心跳时间，也没有任何监管者，
卡死与正常执行在界面上完全一样。

### P1-3 没有空闲断连  ✅ 已修

私有 `api.service.ts:92-93 / 192-198`：每次请求后重置 10 分钟计时器，超时主动 `logout()`。
开源侧连接一直挂到进程结束 —— 既长期占用服务端匿名会话，也让 P0-1 的空闲窗口无限长。

### P1-4 进度写库无节流、且并发无序  ✅ 已修（改为串行，未加节流）

`sync.service.ts:259-269` 用 `void this.runRepo.update(...)` 直接发出去、不排队。连续两次
上报的 UPDATE 到达顺序无保证 ⇒ 进度条可能回退；分页通道页数多时还会并发多条 UPDATE。
私有侧 `PROGRESS_THROTTLE = 300ms` 节流 + 域层顺序 `await`。

### P1-5 证券卡的台账永远是空的  ✅ 已修

`syncSecurities`（`security.syncer.ts:33-79`）只调 `upsertSecurities`，**从不写 watermark**；
全仓只有 `calendar.syncer` 与 `daily-batch` 调 `saveWatermark`。⇒ `cardOf(SECURITY)` 读
`scope='security'/dataset='*'` 恒为空，卡片上 `lastDate` 永远 `null`、`recordCount` 永远 0，
即使库里已写入几千条。私有侧用 `refreshAllCounts()` 一条 SQL 重算后回写。

### P1-6 台账 `rows` 累加的是「尝试写入数」而不是净行数  ✅ 已修

`advanceWatermark(current, day, writtenToday)` 用的 `writtenToday` 是 `upsert` 返回的
`identifiers.length`（= 提交的行数，不是新增行数）。显式指定 `from/to` 重跑同一区间会
重复累加 ⇒ 卡片记录数持续虚高。私有侧以 `MAX(date)` + 重算计数为权威。

---

## 四、微优化（P2，状态逐条标注）

1. ✅ **`endsWithEndMark` 每块都全量 `Buffer.concat`**（`client.ts:243` + `protocol.ts:98-105`）。
   0.35 MB 响应按 16 KB 分块约 22 次拷贝，总拷贝量约 4 MB。改为只保留尾部 13 字节做比对即可。
2. ⏳ **日历每次都重拉约一年**：`calendar.syncer.ts:53-59` 起点直接用 `watermark.lastDate`（没 +1），
   上界恒为「次年年底」⇒ 每次运行至少拉一年日历（1~2 页）。私有侧先用一页探测
   `MAX(calendar_date)` 附近有没有新数据，没有就直接收尾。
3. ✅ **每页都全表 COUNT**：`calendar.syncer.ts:89` 在分页循环内 `countCalendar()`，
   应移到收尾时算一次。
4. ⏳ **`'anonymous'` 硬编码 4 处**（刻意不做：匿名登录是唯一模式，改成 `getUserId()` 只是多一层耦合）（`security.syncer:44`、`calendar.syncer:74`、
   `bar-by-date.syncer:74`、`adjust-factor.syncer:47`），而 `client.getUserId()` 存在却只在
   spec 里被调用。一旦改成实名登录，请求体回显的用户与登录会话就不一致了（私有侧统一用 `this.userId`）。
5. ✅ **`logout()` 不走 Gate**（`client.ts:108-119`）——停机时可能与进行中的请求抢同一个 socket
   （私有侧同样有此问题，属双方共有的待修点）。
6. ✅ **`isRetryable` 用 `err instanceof Error` 兜底**（已显式列举可重试 code，裸 `Error` 作为传输层兜底保留）（`client.ts:322`）——语义上是「除了超时，
   任何 Error 都重试」，把「尚未连接」这类不该重试的也纳入了；建议显式列举可重试 code。

---

## 五、不建议照搬私有侧的部分

- `sendMessage(msgType, msgAry, fieldIndex, recordIndex)` 的位置参数风格 —— 开源侧的具名
  `BaostockQuery` 已经解决了同一个易错点，不要回退成位置参数。
- 「以 `MAX(date)` 推起点」—— 开源侧的 `data_coverage` 台账表能分别表达「日 K 覆盖到哪天」与
  「复权因子覆盖到哪天」，信息量更大；只需把 P1-5 / P1-6 的写入补齐。
- 单类 660 行的组织方式 —— 与开源侧「纯函数协议层可独立测试」的方向相反。

---

## 六、建议的落地顺序

1. **P0-1 / P0-2**（连接生命周期与重试覆盖面）—— 各约 10~20 行，风险低，直接消除进程级隐患。
2. **P0-4 / P1-5 / P1-6**（哨兵 + 台账写入）—— 影响的是「能不能看见问题」与界面数字是否正确。
3. **P0-3**（取消令牌）—— 需要给 `DailyBatchDeps` 加接口，改 3 个 syncer 的签名，中等工作量。
4. **P1-1 / P1-2 / P1-3**（定时窗口 + 看门狗 + 空闲断连）—— 独立一块，建议单独立项。

每项改动都必须同步补测试（仓库门禁要求）：P0-1 用 `node:net` 替身断言「请求间隙仍有 error
监听」；P0-2 断言 `CONNECT_FAILED` 进入重试；P0-3 断言暂停后不写 `SUCCEEDED`。

---

_最后更新：2026-11-01_

---

## 七、落地记录（2026-11-01）

### 代码改动

| 文件 | 改了什么 |
| --- | --- |
| `data/source/baostock.client.ts` | 建连后挂**常驻 `error` 监听**（P0-1）；用 `BaostockClientOptions` 把 attempts / backoff / timeout / idle 抽成可注入参数；`ensureLogin()` 移进重试体、`CONNECT_FAILED` 与新增的 `LOGIN_FAILED` 并入可重试集合（P0-2）；空闲 `IDLE_TIMEOUT_MS` 到点经 gate 排队登出（P1-3）；`logout()` 走 gate、内部拆出不走 gate 的 `closeSession()`（P2-5）；结束标记改为只维护 13 字节尾部窗口，不再每块全量 `concat`（P2-1） |
| `data/sync/daily-batch.ts` | `warnOnCountDrop` 真正调 `deps.warn`（P0-4）；新增 `deps.shouldAbort` 每天边界检查、`SyncResult.aborted`（P0-3）；新增 `deps.countRows` 在收尾/中断时以库为准校正台账条数（P1-6） |
| `data/sync/security.syncer.ts` | 补台账写入（`scope=security` / `dataset='*'` / `lastDate=同步日`，P1-5）；`countSecurities` 校正条数；每页结束检查取消 |
| `data/sync/calendar.syncer.ts` | 整份日历的 `COUNT` 从「每页一次」改为「收尾一次」（P2-3） |
| `data/sync.service.ts` | `finishRun` 改为**条件更新**（`WHERE state = RUNNING`），0 行被改则不广播 `finish`（P0-3）；新增 `isAborted(runId)` 回读状态；`makeProgress` 改串行 Promise 链（P1-4）；`makeDailyDeps(runId, countRows)` 接线取消 / 校正 / 告警；证券同步器补 `saveWatermark` / `today` / `countSecurities` |

### 测试（净增 11 个用例，617 全绿）

- `baostock.client.spec.ts`：socket 替身按 Node 语义重写（`once` 自动移除、`emit('error')` 无监听者时抛错），
  新增「两次请求之间仍有 error 监听者」「建连超时可重试」「登录失败可重试」「空闲到点自动登出」四个用例。
- `daily-batch.spec.ts`：新增「`shouldAbort` 在日边界停」「`countRows` 校正台账」「条数骤降调 warn」「未开启时不告警」。
- `syncers.spec.ts`：证券同步器补「台账落库」「以库为准的条数」「`shouldAbort` 中止」「空结果不写台账」。
- `sync.service.spec.ts`：新增「收尾时已被暂停不覆盖、不广播」「执行中检测到暂停即在日边界停止」。

### 门禁

`yarn lint` 0 error（2 条既有 warning，与本模块无关）→ `yarn test` 93 文件 / 617 用例全绿 →
`yarn test:cov` 语句 92.36% / 分支 83.6% / 函数 90.7% / 行 92.91%（门槛 88/83/88/89，均过）→ `yarn build:api` 通过。

### 仍未做

- **P1-1 定时调度**：需要新增调度模块（主窗口 / 补偿窗口 / 启动补跑 / 计划日幂等），并决定是否放 `apps/worker`。属功能新增，不在「优化」范围。
- **P1-2 卡死看门狗**：需要给 `sync_runs` 加心跳时间字段（DDL 变更由用户执行，遵守「不直接改库」）。
- **P2-2 日历每次重拉约一年**：每次只多 1 个请求（1 页），收益太小，暂不动。

_落地更新：2026-11-01_
