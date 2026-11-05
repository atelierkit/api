-- atelierkit · 远程连接模块
--
-- 执行角色：atelier（必须与其余表的 owner 一致 —— 用 postgres 建表会让应用连读写权限都没有）
-- 幂等：两表都带 IF NOT EXISTS，重复执行无副作用
-- 说明 1：列集合必须与实体严格一致（apps/api/cloud/remote/remote.entity.ts）。
--         `remotes_logs` **没有** create_* 两列 —— CommonService.addLog 按日志表的列做
--         INSERT ... SELECT，少一列或多一列都会让写操作后的日志搬运报错。
-- 说明 2：嵌入列的物理列名带前缀（`update_user_id`、`log_id`），不是实体里的 `_user_id` / `_id`。
-- 说明 3：docker / kubernetes 两个模块的 DDL 尚未进仓库（只存在于工控机的
--         `/data/scripts/atelierkit/api/` 下）—— 换机器部署时会漏表。
--
-- 应用方式：
--   docker exec -i main-postgres psql -U atelier -d atelier -v ON_ERROR_STOP=1 < remotes-module.ddl.sql

BEGIN;

CREATE TABLE IF NOT EXISTS remotes (
    name                text    NOT NULL DEFAULT '',
    description         text    NOT NULL DEFAULT '',
    host                text    NOT NULL DEFAULT '',
    port                integer NOT NULL DEFAULT 22,
    auth_type           text    NOT NULL DEFAULT 'password',
    username            text    NOT NULL DEFAULT '',
    password            text    NOT NULL DEFAULT '',
    private_key         text    NOT NULL DEFAULT '',
    passphrase          text    NOT NULL DEFAULT '',
    charset             text    NOT NULL DEFAULT 'utf-8',
    fingerprint         text    NOT NULL DEFAULT '',
    root_path           text    NOT NULL DEFAULT '',
    status              boolean NOT NULL DEFAULT true,
    id                  serial  NOT NULL,
    update_user_id      integer NOT NULL,
    update_operate      text    NOT NULL,
    update_operate_id   bigint  NOT NULL DEFAULT 0,
    update_req_id       bigint  NOT NULL DEFAULT 0,
    update_at           bigint  NOT NULL DEFAULT 0,
    create_user_id      integer NOT NULL,
    create_at           bigint  NOT NULL DEFAULT 0,
    CONSTRAINT "PK_remotes" PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS "IDX_remotes_update_operate_id"
    ON remotes (update_operate_id);

CREATE TABLE IF NOT EXISTS remotes_logs (
    name                text    NOT NULL DEFAULT '',
    description         text    NOT NULL DEFAULT '',
    host                text    NOT NULL DEFAULT '',
    port                integer NOT NULL DEFAULT 22,
    auth_type           text    NOT NULL DEFAULT 'password',
    username            text    NOT NULL DEFAULT '',
    password            text    NOT NULL DEFAULT '',
    private_key         text    NOT NULL DEFAULT '',
    passphrase          text    NOT NULL DEFAULT '',
    charset             text    NOT NULL DEFAULT 'utf-8',
    fingerprint         text    NOT NULL DEFAULT '',
    root_path           text    NOT NULL DEFAULT '',
    status              boolean NOT NULL DEFAULT true,
    id                  integer NOT NULL,
    update_user_id      integer NOT NULL,
    update_operate      text    NOT NULL,
    update_operate_id   bigint  NOT NULL DEFAULT 0,
    update_req_id       bigint  NOT NULL DEFAULT 0,
    update_at           bigint  NOT NULL DEFAULT 0,
    log_id              bigserial NOT NULL,
    CONSTRAINT "PK_remotes_logs" PRIMARY KEY (log_id)
);

CREATE INDEX IF NOT EXISTS "IDX_remotes_logs_id"
    ON remotes_logs (id);

CREATE INDEX IF NOT EXISTS "IDX_remotes_logs_update_operate_id"
    ON remotes_logs (update_operate_id);

COMMIT;
