# atelierkit · api

家用局域网服务器上的个人工具集合 —— 后端服务（**Monorepo**）。

基于 [NestJS](https://nestjs.com) 构建，为 `atelierkit` 各前端应用提供统一的 REST API，
并以 **NestJS 标准 Monorepo** 组织两类服务：API 接口服务 + 后台常驻服务。

## 项目简介

`atelierkit` 是一套部署在家庭局域网服务器上的自托管工具集合，所有数据仅在内网流转。
本仓库承载两类后端进程：

- **`apps/api`** —— HTTP 接口服务，承载数据存取、统一鉴权，为前端提供 REST API。
- **`apps/worker`** —— 后台常驻服务，不监听端口，用于定时任务、队列消费、长时异步任务（如下载引擎管理）。
- **`libs/`** —— 可复用 NestJS 库（当前为空，待两服务出现共享代码时拆分）。

## 功能

- 私有文件与数据管理：文件上传、下载、预览、分享，以及结构化数据的存取
- 服务器运维：系统状态、进程与服务管理
- 下载中心：网盘分享链接解析、断点续传、后台常驻下载，任务进度 / 暂停 / 限速管理
- 用户与权限：登录、角色、令牌与操作审计
- （规划中）家庭物联网：设备接入与状态管理

## 技术栈

- [NestJS](https://nestjs.com) 12 · [TypeScript](https://www.typescriptlang.org) 6
- [Vitest](https://vitest.dev) · ESM · [oxlint](https://oxc.rs)

## 快速开始

```bash
# 安装依赖
yarn install

# 开发模式（api 热重载）
yarn start:dev

# worker 常驻服务（开发 / 生产）
yarn start:worker:dev
yarn start:worker:prod

# 生产构建与运行（api）
yarn build
yarn start:prod

# 分别构建
yarn build:api
yarn build:worker
```

## 测试

```bash
# 单元测试
yarn test

# 端到端测试
yarn test:e2e

# 测试覆盖率
yarn test:cov
```

## 目录结构

```
apps/
├── api/                     # HTTP 接口服务
│   ├── src/  → 已合并到 apps/api 根（main.ts / app.module.ts / ...）
│   └── test/                # e2e 测试
└── worker/                  # 后台常驻服务（定时任务 / 队列消费）
    ├── main.ts
    └── worker.module.ts
libs/                        # 可复用 NestJS 库（nest g library <name>）
```

> 目录结构说明：Monorepo 下 `apps/api` 的源码直接位于其根目录（`apps/api/*.ts`），
> 不再有内层 `src/`；`apps/api/test/` 存放 e2e 测试。

## License

[MIT](./LICENSE)
