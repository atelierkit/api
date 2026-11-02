#!/usr/bin/env bash
#
# atelierkit/api —— 生产环境启动脚本（通用模板）
#
# 用途：拉镜像 → 以固定身份重建容器 → 校验是否真的跑起来。
#
# 用法：
#   bash deploy/start-api.sh                 # 拉取 latest 并重建容器
#   bash deploy/start-api.sh sha-1a2b3c4     # 拉取指定标签（回滚 / 灰度用）
#   TAG=v1.2.0 bash deploy/start-api.sh      # 同上，用环境变量传
#
# 站点相关参数全部外部化，默认值只是通用占位。两种覆盖方式（后者优先）：
#   1. 写进 deploy/deploy.env（已在 .gitignore 里，不进版本库）；
#   2. 直接当环境变量传：IP=172.20.0.8 NETWORK=my-net bash deploy/start-api.sh
#
# 可覆盖的变量：
#   CONTAINER      容器名（默认 atelierkit-api）
#   NETWORK        自定义网络名（默认 atelierkit-net；置空则用默认 bridge）
#   IP             固定 IPv4（默认空 = 不固定；反代按 IP 转发时才需要）
#   PORT           容器内监听端口（默认 3000；反代按 IP:PORT 转发时两边必须一致）
#   PUBLISH        宿主机端口映射（默认空 = 不映射；给值则 -p PUBLISH:PORT）
#   DEPENDS        启动前顺带检查是否在跑的依赖容器（空格分隔，仅告警不阻断）
#   ENV_FILE       运行时配置（默认 ./.env，建议 chmod 600）
#   GHCR_USER / GHCR_PAT_FILE   私有包的登录凭据（默认空，公开包不需要）
#
# 三条设计取舍（都是踩过的坑）：
#   1. 配置全部由 --env-file 注入，脚本里不出现任何口令。
#   2. 先 pull 成功、再删旧容器：pull 失败时站点不受影响（旧写法会先 rm 再失败，站点直接下线）。
#   3. 启动后校验容器是否仍活着，异常时打印最近日志，避免「回显成功但已退出」。
#
# 依赖：docker

set -euo pipefail

# ---------- 站点参数（可被 deploy.env / 环境变量覆盖） ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/deploy.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SCRIPT_DIR/deploy.env"
  set +a
fi

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/atelierkit/api}"
CONTAINER="${CONTAINER:-atelierkit-api}"
NETWORK="${NETWORK:-atelierkit-net}"
IP="${IP:-}"
PORT="${PORT:-3000}"
PUBLISH="${PUBLISH-}"
DEPENDS="${DEPENDS:-}"
ENV_FILE="${ENV_FILE:-.env}"
GHCR_USER="${GHCR_USER:-}"
GHCR_PAT_FILE="${GHCR_PAT_FILE:-}"

# 镜像标签：命令行参数 > 环境变量 TAG > latest
TAG="${1:-${TAG:-latest}}"
IMAGE="${IMAGE_REPO}:${TAG}"

# 必须出现在 env 文件里的键（缺失时应用会直接抛异常退出，先在这里拦一道）
REQUIRED_KEYS=(POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PSW REDIS_HOST REDIS_PORT)

log() { printf '\033[36m→\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 前置检查 ----------
command -v docker >/dev/null 2>&1 || die '未找到 docker，请确认本机已安装 Docker Engine'
docker info >/dev/null 2>&1 || die 'docker 守护进程不可用（systemctl status docker）'

[[ -f "$ENV_FILE" ]] || die "配置文件不存在：$ENV_FILE
  首次部署请先生成：cp .env.example $ENV_FILE && chmod 600 $ENV_FILE"
[[ -r "$ENV_FILE" ]] || die "配置文件不可读：$ENV_FILE"

# CRLF 会让 --env-file 的值带上不可见回车（口令变成错的），提前拦掉
if grep -q $'\r' "$ENV_FILE"; then
  die "$ENV_FILE 含 Windows 换行（CRLF），docker 会把 \\r 一起读进变量值：
  请先执行 sed -i 's/\\r$//' $ENV_FILE"
fi

missing=()
for key in "${REQUIRED_KEYS[@]}"; do
  grep -qE "^[[:space:]]*${key}=" "$ENV_FILE" || missing+=("$key")
done
((${#missing[@]} == 0)) || die "$ENV_FILE 缺少必需项：${missing[*]}"

# 网络不存在时补建（不指定子网，交给 docker 自动分配；需要固定 IP 时再显式给 --subnet）
if [[ -n "$NETWORK" ]] && ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  log "网络 $NETWORK 不存在，创建"
  docker network create "$NETWORK" >/dev/null
fi

# 依赖容器只做提示，不阻断（可能是首次按顺序启动）
read -r -a dep_list <<< "$DEPENDS"
for dep in "${dep_list[@]}"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$dep" 2>/dev/null || echo false)" == 'true' ]] \
    || warn "依赖容器 $dep 未运行，api 启动后可能连不上数据库 / 缓存"
done

# PORT 在 env 文件里若填了别的值，明确告知被覆盖（否则会静默 502）
env_port="$(grep -E '^[[:space:]]*PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d ' "' || true)"
if [[ -n "$env_port" && "$env_port" != "$PORT" ]]; then
  warn "$ENV_FILE 里 PORT=$env_port，已被脚本的 -e PORT=$PORT 覆盖"
fi

# ---------- 拉取镜像 ----------
# 私有包直接 pull 会 401/denied，此时用 PAT 登录后重试；包若已公开则全程无需凭据
pull_image() {
  local image="$1"
  if docker pull "$image"; then
    return 0
  fi
  if [[ -z "$GHCR_PAT_FILE" || ! -f "$GHCR_PAT_FILE" ]]; then
    die "拉取 $image 失败，且未配置 GHCR_PAT_FILE（私有包需先 docker login ghcr.io）"
  fi
  log "拉取失败，尝试用 PAT 登录 ghcr.io（${GHCR_USER:-<未指定用户>}）"
  tr -d '\r\n' <"$GHCR_PAT_FILE" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  docker pull "$image"
}

log "拉取镜像 $IMAGE"
pull_image "$IMAGE" || die "拉取 $IMAGE 失败，旧容器保持运行（未做任何删除）"

# ---------- 重建容器 ----------
# 固定 IP 决定只能「先删后建」，因此上面把 pull 放在删之前，pull 失败时站点不受影响
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  log "移除旧容器 $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null
fi

run_args=(
  -dit
  --restart always
  --name "$CONTAINER"
  --hostname "$CONTAINER"
  --env-file "$ENV_FILE"
  -e PORT="$PORT"
  -e TZ=Asia/Shanghai
)
[[ -n "$NETWORK" ]] && run_args+=(--network "$NETWORK")
# 只有显式给了 PUBLISH 才映射宿主机端口（反代按容器 IP 转发时不需要）
[[ -n "$PUBLISH" ]] && run_args+=(-p "${PUBLISH}:${PORT}")
if [[ -n "$IP" ]]; then
  run_args+=(--ip "$IP")
  log "启动 $CONTAINER（固定 IP $IP:$PORT，网络 $NETWORK）"
else
  log "启动 $CONTAINER（网络 ${NETWORK:-bridge}，端口 $PORT，未固定 IP）"
fi

# 注：api 镜像没有 HEALTHCHECK，也没有公开的 /health 端点（根路径返回 404），
# 所以健康判定放在下面的启动校验里 —— 看 Nest 是否打印了启动完成。
docker run "${run_args[@]}" "$IMAGE" >/dev/null

# ---------- 启动校验 ----------
sleep 2
if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != 'true' ]]; then
  printf '\033[31m✗\033[0m %s\n' "$CONTAINER 已退出，最近日志：" >&2
  docker logs --tail 50 "$CONTAINER" >&2 || true
  exit 1
fi

# Nest 就绪标志；数据库冷连接较慢，最多等 30 秒，超时只警告不判失败
started=0
printf '  等待应用就绪'
for _ in $(seq 1 30); do
  # 用变量接住日志、不要写 `docker logs ... | grep -q`：grep -q 命中后立即退出会让
  # docker logs 吃到 SIGPIPE（141），配合 pipefail 会把「已就绪」误判成失败
  logs="$(docker logs "$CONTAINER" 2>&1 || true)"
  if [[ "$logs" == *'successfully started'* ]]; then
    started=1
    break
  fi
  printf '.'
  sleep 1
done
printf '\n'

if ((started == 1)); then
  log "启动完成：$CONTAINER ($IMAGE)"
else
  warn "30 秒内未见 'Nest application successfully started'，可能仍在连数据库，请抽查日志：
  docker logs --tail 80 $CONTAINER"
fi

docker ps --filter "name=^${CONTAINER}$" --format '  {{.Names}}  {{.Image}}  {{.Status}}'
log "容器内监听 $PORT；反代目标：http://${IP:-<容器 IP>}:$PORT"
