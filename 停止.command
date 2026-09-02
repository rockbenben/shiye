#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

# 按端口找，不按程序名：杀掉所有 node 会顺手带走编辑器和别的开发服务器。
PIDS=$(lsof -ti tcp:30035 2>/dev/null)
if [ -z "$PIDS" ]; then
  echo "没有在 30035 端口上找到在跑的服务。如果你在 .env 里把 PORT 改成了别的号，"
  echo "服务大概率还在那个端口上跑着——去找到它的窗口关掉就行，这个脚本只认 30035。"
else
  echo "$PIDS" | xargs kill -9
  echo "已经停掉了。"
fi
