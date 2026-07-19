#!/usr/bin/env bash
# inference-sla 一键启动脚本：h200-2 PD 分离（prefill + decode）监控
#
# 原理：通过 SSH 把 h200-2 的 prefill(8001)/decode(8002) metrics 端口转发到本地，
#       再用 bun 启动双端点仪表盘，自动识别为 [PD-DISAGG] 合并视图。
#       退出（q/Esc/Ctrl+C）时自动清理 SSH 转发。
#
# 用法: ./start-h200-2-pd.sh [refresh_ms]
#   或:  SGLANG_REFRESH_MS=1000 ./start-h200-2-pd.sh
#
# 可调环境变量:
#   SSH_HOST       SSH 别名或地址 (默认 h200-2)
#   REMOTE_PF      远端 prefill metrics 端口 (默认 8001)
#   REMOTE_DC      远端 decode  metrics 端口 (默认 8002)
#   LOCAL_PF       本地映射 prefill 端口 (默认 18001)
#   LOCAL_DC       本地映射 decode  端口 (默认 18002)
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

BUN_BIN="${BUN:-$HOME/.bun/bin/bun}"

SSH_HOST="${SSH_HOST:-h200-2}"
REMOTE_PF="${REMOTE_PF:-8001}"
REMOTE_DC="${REMOTE_DC:-8002}"
LOCAL_PF="${LOCAL_PF:-18001}"
LOCAL_DC="${LOCAL_DC:-18002}"
MS="${1:-${SGLANG_REFRESH_MS:-1000}}"

# ---------- 1) 确保 bun 可用 ----------
if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
  echo "[setup] bun 未安装，正在从 npm registry 安装到 ~/.bun ..."
  mkdir -p "$HOME/.bun/bin"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  curl -fsSL -o "$tmpdir/bun.tgz" \
    https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.3.14.tgz
  tar -xzf "$tmpdir/bun.tgz" -C "$tmpdir"
  cp "$tmpdir/package/bin/bun" "$HOME/.bun/bin/bun"
  chmod +x "$HOME/.bun/bin/bun"
  echo "[setup] bun 安装完成"
fi

# ---------- 2) 确保依赖已安装 ----------
if [ ! -d node_modules/@opentui ]; then
  echo "[setup] 安装依赖 ..."
  "$BUN_BIN" install >/dev/null
  echo "[setup] 依赖就绪"
fi

# ---------- 3) SSH 端口转发 ----------
SSH_PID=""
cleanup() {
  if [ -n "$SSH_PID" ]; then
    kill "$SSH_PID" >/dev/null 2>&1 || true
    wait "$SSH_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[ssh] 建立 $SSH_HOST 端口转发 (prefill $REMOTE_PF→local $LOCAL_PF, decode $REMOTE_DC→local $LOCAL_DC) ..."
# 后台运行 ssh 转发；-N 无命令、-o 保活防卡死
ssh -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes -N \
    -L "$LOCAL_PF:localhost:$REMOTE_PF" -L "$LOCAL_DC:localhost:$REMOTE_DC" \
    "$SSH_HOST" &
SSH_PID=$!

# ---------- 4) 等待 metrics 端点就绪 ----------
code1=000
code2=000
for i in $(seq 1 30); do
  if ! kill -0 "$SSH_PID" 2>/dev/null; then
    echo "[err] ssh 转发进程已退出（可能是端口被占用或远端不可达）"
    exit 1
  fi
  code1=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://localhost:$LOCAL_PF/metrics" 2>/dev/null || echo 000)
  code2=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://localhost:$LOCAL_DC/metrics" 2>/dev/null || echo 000)
  if [ "$code1" = "200" ]; then
    # prefill 就绪即可；decode 可选（未起则降级为单端点监控）
    break
  fi
  sleep 0.4
done

if [ "$code1" != "200" ]; then
  echo "[err] prefill metrics 端点未就绪 (HTTP $code1)"
  echo "      检查: ssh $SSH_HOST 连通性 / sglang 是否以 --enable-metrics 启动 / 端口 $REMOTE_PF"
  exit 1
fi

DEGRADE=0
if [ "$code2" != "200" ]; then
  DEGRADE=1
  echo "[warn] decode metrics 端口 $REMOTE_DC 未就绪 (HTTP $code2) — 降级为单端点 [PREFILL] 监控"
  echo "       decode 恢复后重新执行本脚本即自动回到 [PD-DISAGG] 合并视图"
else
  echo "[ssh] 转发就绪 (prefill HTTP $code1, decode HTTP $code2)"
fi

# ---------- 5) 启动仪表盘 ----------
if [ "$DEGRADE" = "1" ]; then
  URL="http://localhost:$LOCAL_PF/metrics"
else
  URL="http://localhost:$LOCAL_PF/metrics,http://localhost:$LOCAL_DC/metrics"
fi
echo "[run] endpoints=$URL"
echo "[run] refresh=${MS}ms  (q/Esc/Ctrl+C 退出，自动清理 ssh)"
# 不用 exec：让 trap 在 bun 退出后仍能清理 SSH
"$BUN_BIN" src/main.ts --endpoint "$URL" "$MS"
