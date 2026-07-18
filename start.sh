#!/usr/bin/env bash
# sglang-sla 一键启动脚本
# 用法: ./start.sh [metrics_url] [refresh_ms]
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

BUN_BIN="${BUN:-$HOME/.bun/bin/bun}"

# 确保 bun 可用
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
  echo "[setup] bun $(\"$BUN_BIN\" --version 2>/dev/null || echo installed) 安装完成"
fi

# 确保依赖已安装
if [ ! -d node_modules/@opentui ]; then
  echo "[setup] 安装依赖 ..."
  "$BUN_BIN" install >/dev/null
  echo "[setup] 依赖就绪"
fi

# 默认参数
URL="${1:-${SGLANG_METRICS:-http://localhost:8001/metrics}}"
MS="${2:-${SGLANG_REFRESH_MS:-1000}}"

echo "[run] endpoint=$URL  refresh=${MS}ms  (q/Esc/Ctrl+C 退出)"
exec "$BUN_BIN" src/main.ts "$URL" "$MS"
