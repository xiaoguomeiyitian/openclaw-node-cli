#!/usr/bin/env bash
# cli.sh — 交互式节点终端选择器主入口(通道 B:网关侧完整 PTY)
# 可移植:与本目录其他文件放在一起;整目录拷到任意位置即可运行。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node)" || { echo "未找到 node 命令"; exit 1; }

# 调用同目录的 node-term.mjs(真正的逻辑);透传全部参数(如 --gateway)
exec "$NODE_BIN" "$DIR/node-term.mjs" "$@"
