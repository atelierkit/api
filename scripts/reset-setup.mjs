#!/usr/bin/env node
/**
 * 把开发环境重置回「首次部署」状态，便于反复验证创建管理员流程
 *
 * 做的事：
 * 1. 备份将被删除的 users 与 settings(code='init') 行到系统临时目录（JSON）
 * 2. 删除全部用户与会话令牌
 * 3. 删除初始化标记（数据库 settings 行 + Redis 缓存键 init）
 *
 * 安全约束：仅允许 NODE_ENV=dev，其它环境直接拒绝执行
 *
 * 用法：
 *   yarn reset:setup
 *   node scripts/reset-setup.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Redis } from 'ioredis';

/** 仓库根目录 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 初始化标记在 settings 表中的编码 */
const INIT_CODE = 'init';

/**
 * 读取 .env（不依赖 dotenv，保持脚本可独立运行）
 *
 * @returns 环境变量键值对
 */
function readEnv() {
  /** .env 路径 */
  const file = join(ROOT, '.env');
  /** .env 文本 */
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`拒绝执行：找不到 ${file}，请先从 .env.example 复制并填写数据库与缓存参数`);
    process.exit(1);
  }
  /** 键值对 */
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf('=');
    if (index <= 0) {
      continue;
    }
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

/**
 * 创建数据库连接
 *
 * @param env 环境变量
 * @returns 数据库客户端
 */
async function openDb(env) {
  const client = new pg.Client({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT || 5432),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PSW,
  });
  await client.connect();
  return client;
}

/**
 * 创建缓存连接
 *
 * @param env 环境变量
 * @returns 缓存客户端
 */
function openRedis(env) {
  return new Redis({
    host: env.REDIS_HOST,
    port: Number(env.REDIS_PORT || 6379),
    db: Number(env.REDIS_DB || 0),
    password: env.REDIS_PSW || undefined,
  });
}

async function main() {
  /** 环境变量 */
  const env = readEnv();
  if (env.NODE_ENV !== 'dev') {
    console.error(`拒绝执行：当前 NODE_ENV=${env.NODE_ENV ?? '未设置'}，本脚本只允许在 dev 环境使用`);
    process.exit(1);
  }

  /** 数据库 */
  const db = await openDb(env);
  /** 缓存 */
  const redis = openRedis(env);
  try {
    /** 待删除数据 */
    const users = (await db.query('SELECT * FROM users')).rows;
    /** 初始化标记 */
    const init = (await db.query('SELECT * FROM settings WHERE code = $1', [INIT_CODE])).rows;

    // 先备份，再删除
    /** 备份文件路径 */
    const backup = join(tmpdir(), `atelierkit-reset-setup-${Date.now()}.json`);
    writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), users, init }, null, 2), 'utf8');
    console.log(`已备份 -> ${backup}`);
    console.log(`  待删 users  ${users.length} 行：${users.map((u) => u.username).join(', ') || '（空）'}`);

    await db.query('BEGIN');
    const deletedUsers = await db.query('DELETE FROM users');
    const deletedInit = await db.query('DELETE FROM settings WHERE code = $1', [INIT_CODE]);
    await db.query('COMMIT');

    /** 残留令牌键 */
    const tokens = await redis.keys('token:*');
    if (tokens.length) {
      await redis.del(...tokens);
    }
    /** 初始化缓存键删除数 */
    const deletedCache = await redis.del(INIT_CODE);

    console.log(
      `已清理：users ${deletedUsers.rowCount} 行 / init 标记 ${deletedInit.rowCount} 行 / 令牌 ${tokens.length} 个 / 缓存 init ${deletedCache} 个`,
    );

    // 复核
    /** 复核结果 */
    const after = await db.query(
      `SELECT (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM settings WHERE code = $1)::int AS init`,
      [INIT_CODE],
    );
    console.log(
      `复核：users=${after.rows[0].users} init=${after.rows[0].init} redis_init=${(await redis.get(INIT_CODE)) ?? 'null'}`,
    );
    console.log('已回到「首次部署」状态，重启或直接访问前端即可重新创建管理员。');
  } finally {
    await redis.quit();
    await db.end();
  }
}

main().catch((error) => {
  console.error('重置失败：', error);
  process.exit(1);
});
