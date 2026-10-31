# 行情数据表 DDL（atelierkit/api 的 public schema）

> 来源：照 almanac 桌面端 `SchemaInitializer.cs` 的权威 schema 建表（**不沿用旧 api 的 `ks/days/stocks` 表名**）。
> 本文件由迁移方案产出，**由用户在库上手工执行**（遵守「不直接改库」纪律）。
>
> ⚠️ TypeORM `synchronize` 生成不了「部分唯一索引」，因此最后两条（`IDX_sync_runs_plan` / `IDX_sync_runs_active`）
> **必须手工执行**；开发库若开了 synchronize，它会建表但不会建这两条索引，联调时「重复入队没被挡住」就是这个原因。

## 一、业务表（4 张）

```sql
-- 证券基础信息
CREATE TABLE IF NOT EXISTS securities (
    code        text        NOT NULL,
    name        text        NOT NULL,
    type        text        NOT NULL,          -- 枚举名：Stock / Index / Bond / Fund
    market      text        NOT NULL,          -- 枚举名：SH / SZ / BJ
    list_date   date        NULL,
    delist_date date        NULL,
    status      text        NOT NULL,          -- 枚举名：Listed / Delisted
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_securities PRIMARY KEY (code)
);
CREATE INDEX IF NOT EXISTS ix_securities_market_type ON securities (market, type);

-- 交易日历（只存「日期 + 是否开市」两列）
CREATE TABLE IF NOT EXISTS trade_calendar (
    calendar_date date        NOT NULL,
    is_open       boolean     NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_trade_calendar PRIMARY KEY (calendar_date)
);

-- 日 K 线（原始、不复权）
CREATE TABLE IF NOT EXISTS bars (
    code           text          NOT NULL,
    date           date          NOT NULL,
    open           numeric(20,6) NULL,
    high           numeric(20,6) NULL,
    low            numeric(20,6) NULL,
    close          numeric(20,6) NULL,
    pre_close      numeric(20,6) NULL,
    volume         bigint        NOT NULL DEFAULT 0,
    amount         numeric(20,6) NULL,
    turnover_rate  numeric(20,6) NULL,
    change_percent numeric(20,6) NULL,
    pe_ttm         numeric(20,6) NULL,        -- 空串落 NULL（不许落 0）
    pb_mrq         numeric(20,6) NULL,
    ps_ttm         numeric(20,6) NULL,
    pcf_ncf_ttm    numeric(20,6) NULL,
    trade_status   text          NOT NULL DEFAULT 'Unknown',  -- Normal / Suspended / Unknown
    is_st          boolean       NOT NULL DEFAULT false,
    updated_at     timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_bars PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS "IDX_bars_date_code" ON bars (date, code);

-- 累计复权因子（只有 back_factor 一列因子，物理防呆）
CREATE TABLE IF NOT EXISTS adjust_factors (
    code           text           NOT NULL,
    operate_date   date           NOT NULL,
    back_factor    numeric(20,10) NOT NULL,
    updated_at     timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT pk_adjust_factors PRIMARY KEY (code, operate_date)
);
CREATE INDEX IF NOT EXISTS "IDX_adjust_factors_date" ON adjust_factors (operate_date, code);
```

## 二、同步台账表（3 张）

```sql
-- 数据覆盖度（同步台账）：每 (scope, dataset, parameters) 一行
CREATE TABLE IF NOT EXISTS data_coverage (
    scope        text        NOT NULL,
    dataset      text        NOT NULL,
    parameters   text        NOT NULL DEFAULT '',
    last_date    date        NULL,
    record_count bigint      NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_data_coverage PRIMARY KEY (scope, dataset, parameters)
);

-- 同步任务（一个同步目标恒一行）
CREATE TABLE IF NOT EXISTS sync_tasks (
    id         bigserial   NOT NULL,
    target     text        NOT NULL,          -- Security / Calendar / BarByDate / AdjustFactor
    code       text        NOT NULL DEFAULT '',  -- 空串 = 整份数据（不是 NULL）
    enabled    boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_sync_tasks PRIMARY KEY (id),
    CONSTRAINT uq_sync_tasks_target_code UNIQUE (target, code)
);

-- 同步执行流水（跑一次一行；活跃行同时就是队列）
CREATE TABLE IF NOT EXISTS sync_runs (
    id           bigserial   NOT NULL,
    task_id      bigint      NOT NULL,
    target       text        NOT NULL,        -- 冗余快照
    code         text        NOT NULL DEFAULT '',  -- 冗余快照
    state        smallint    NOT NULL DEFAULT 1,   -- 0 Draft / 1 Queued / 2 Running / 3 Succeeded / 4 Failed / 5 Skipped / 6 Paused
    source       text        NOT NULL DEFAULT 'manual',
    plan_date    text        NOT NULL DEFAULT '',
    from_date    date        NULL,
    to_date      date        NULL,
    done         bigint      NOT NULL DEFAULT 0,
    total        bigint      NOT NULL DEFAULT 0,
    rows_written bigint      NOT NULL DEFAULT 0,
    stage        text        NOT NULL DEFAULT '',
    message      text        NULL,
    attempts     integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz NULL,
    finished_at  timestamptz NULL,
    CONSTRAINT pk_sync_runs PRIMARY KEY (id),
    CONSTRAINT fk_sync_runs_task FOREIGN KEY (task_id) REFERENCES sync_tasks (id)
);
CREATE INDEX IF NOT EXISTS "IDX_sync_runs_state_id" ON sync_runs (state, id);
CREATE INDEX IF NOT EXISTS "IDX_sync_runs_task" ON sync_runs (task_id, id DESC);
```

## 三、两条部分唯一索引（★ 必须手工执行，synchronize 不会生成）

```sql
-- ① 同一任务同一天只被自动排一次（手工执行的 plan_date = '' 不受约束）
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sync_runs_plan"
    ON sync_runs (task_id, plan_date) WHERE plan_date <> '';

-- ② 同一任务同时最多一条活跃执行 —— 幂等的唯一依据，替掉应用层检查
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sync_runs_active"
    ON sync_runs (task_id) WHERE state IN (1, 2);
```

> 注意：`IDX_sync_runs_active` 的谓词里活跃状态集合 `IN (1, 2)` 需与代码里的 `SyncStates.active`
> 保持一致。本方案状态值沿用 almanac：`1 Queued / 2 Running` 为活跃态。
