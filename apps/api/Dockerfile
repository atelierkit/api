# syntax=docker/dockerfile:1
#
# api 服务镜像（Monorepo 下的子应用）
#
# ⚠️ 构建上下文必须是**仓库根目录**（需要 package.json / yarn.lock / tsconfig / libs），
#    不能直接 `docker build apps/api`，否则 COPY 会找不到文件：
#      docker build -f apps/api/Dockerfile -t atelierkit/api .
#    依赖排除规则读的是仓库根的 .dockerignore（Docker 只认「上下文根」那一份）。
#
# 后续 worker 上线后同样放 apps/worker/Dockerfile，共用同一个上下文与 .dockerignore。

# ---------- 构建阶段 ----------
FROM node:24-alpine AS builder

WORKDIR /app

# 先只拷依赖清单，命中缓存后依赖层不必随源码变动重建
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

# 再拷源码并编译（nest build 会把 @shared 别名改写成相对路径）
COPY . .
RUN yarn build:api

# ---------- 运行阶段 ----------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 注：alpine 默认不带 tzdata，不装的话 /etc/localtime 会是个悬空链接（容器内时间仍是 UTC）
RUN apk add --no-cache tzdata \
  && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# 只装生产依赖：编译产物运行时需要 node_modules，但不该带上 typescript / nest cli
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true --network-timeout 600000 \
  && yarn cache clean

# 只拷编译产物，源码与文档不进镜像
COPY --from=builder /app/dist ./dist

# 端口由 .env 的 PORT 决定，默认 3000
EXPOSE 3000

CMD ["node", "dist/apps/api/main.js"]
