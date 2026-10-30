# AGENTS.md

## Monorepo 结构（NestJS 标准模式）

本仓库采用 NestJS 标准 Monorepo，用 `nest build <project>` / `nest start <project>` 按项目构建与启动：

| 项目 | 类型 | 说明 |
| --- | --- | --- |
| `apps/api` | application | HTTP 接口服务，监听端口（默认 3000）；`apps/api/shared/` 为共用领域模块 |
| `apps/worker` | application | 后台常驻服务，**不监听端口**，用于定时任务 / 队列消费 / 长时异步任务 |
| `libs/` | library | 可复用库（`nest g library <name>`），当前为空 |

约定：

- **新增服务**：`nest g app <name>`（生成到 `apps/`），并手动登记到根 `nest-cli.json` 的 `projects` 与根 `tsconfig.json` 的 `references`。
- **共享代码**：跨 `api` / `worker` 复用的模块下沉到 `libs/`（`nest g library <name>`），通过 tsconfig 路径别名引用。
- 每个 `apps/*/tsconfig.app.json` 必须保留 `"composite": true`（project references 依赖它，移除会导致 `lint` 报 tsconfig-error）。
- 生产产物落在 `dist/apps/<project>/`；入口为 `dist/apps/api/main.js` 与 `dist/apps/worker/main.js`。
- **再建库时**：`nest g lib <name>` 会顺手加 `"builder": "rspack"` 与 4 个 webpack 系 devDep，如无需要记得回退；且 TS 6 起
  `libs/*/tsconfig.lib.json` **必须显式 `rootDir`**（TS5011），写 `"rootDir": "./src"` 才能得到 `dist/libs/<name>/index.js` 而非多套一层的路径。
- **`apps/api/shared`**：自旧私有项目 `marbleqi/api` 的 `src/shared` 迁入的共用领域模块（`SharedModule`：用户 / 角色 / 令牌 / 配置 /
  操作·请求日志 / 缓存 / 队列 / 邮件 / 监控）。它随 `apps/api` 一起构建（产物 `dist/apps/api/shared/`），当前**只有 api 使用**。
  两条不受「库还是目录」影响的 ESM 铁律：内部相对导入**必须带 `.js`**；**不用桶文件（`index.ts`）互相导入**
  （ESM 下会因 TDZ 抛 `Cannot access 'X' before initialization`），一律按文件具名导入 —— `shared/index.ts` 只对外聚合，内部不反向引用它。
- **`@shared` 路径别名**：根 `tsconfig.json` 的 `paths` 声明 `@shared` → `apps/api/shared/index.ts`、`@shared/*` → `apps/api/shared/*`。
  `shared/` **之外**的代码（`app.module.ts` 等）用 `import { SharedModule } from '@shared'` 或 `@shared/<目录>/<文件>.js`；
  `shared/` **内部**仍用相对路径（保持目录可整体搬迁，也不引入循环依赖风险）。
  `nest build` / `nest start` 由 `@nestjs/cli` 12 的 tsconfig-paths 钩子在**编译期把别名改写成相对路径**（产物里看到的是 `./shared/index.js`），
  所以运行时**不需要** `tsconfig-paths/register`（旧私有项目的 CJS 做法在本仓库用不上）；`vitest` 靠 `resolve.tsconfigPaths` 解析。
  ⚠️ `apps/worker` **暂时不能用 `@shared`**：`apps/api/shared/**` 不在 worker 的 project file list 里（报 TS6307 + rootDir 越界），
  真正的跨 app 复用要回到 `libs/` 方案；别把别名当成已解决跨 app 共享。
- ⚠️ **源码目录里不该出现 `.js` / `.js.map` / `.d.ts`**：`dist/` 之外出现它们，说明有文件被 tsc 在 rootDir 之外**就地 emit** 了
  （典型触发：给 `apps/worker` 加一条 `@shared` 导入去「试一下」，会连带把 `apps/api/shared` 整棵树的三种产物吐回源码目录）。
  这些是构建垃圾，`git status` 核对后直接删；提交前务必扫一眼（本项目 `declaration: true` + `composite: true`，产物正常只落在 `dist/apps/<project>/`）。

## Production data: NestJS Observe

This app's production telemetry - traces, errors, logs and metrics - goes to [NestJS Observe](https://observe.nestjs.com). Until `ObserveModule` is registered in `apps/api/app.module.ts`, nothing is sent: `npx @nestjs/observe link` sets it up in one step - it installs `@nestjs/observe`, wires it into the app, and writes the key pair (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`) to `.env`.

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.
