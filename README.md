# atelierkit · api

家用局域网服务器上的个人工具集合 —— 后端服务。

基于 [NestJS](https://nestjs.com) 构建，为 `atelierkit` 各前端应用提供统一的 REST API。

## 项目简介

`atelierkit` 是一套部署在家庭局域网服务器上的自托管工具集合，所有数据仅在内网流转。
`api` 是其中的后端服务，承载数据存取、任务调度与统一鉴权。

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

# 开发模式（热重载）
yarn start:dev

# 生产构建与运行
yarn build
yarn start:prod
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
src/
├── app.module.ts
├── app.controller.ts
├── app.service.ts
└── main.ts
```

## License

[MIT](./LICENSE)
