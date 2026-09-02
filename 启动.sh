#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

cat scripts/msg/banner.txt

if ! command -v node >/dev/null 2>&1; then
  cat scripts/msg/no-node.txt
  exit 1
fi

# 构建产物会过期：双击启动不会自动 npm run build，git pull 改了
# server/src 之后，server/dist/index.js 还在（下面单纯的「存不存在」判断会
# 判成「已经构建过」），内容却是旧代码。用 -newer 比一下 mtime，源码比构建
# 产物新就当没构建过处理，不只看文件在不在。
#
# 「从没构建过」和「构建产物过期」不是同一句话——一个从没跑过 npm run go 的人
# 被告知「代码比上次构建的版本新」没有意义，他根本没有「上次」。跟启动.cmd
# 共用同一对文案（scripts/msg/first-run.txt / rebuild.txt），不各写一份。
if [ ! -f server/dist/index.js ]; then
  cat scripts/msg/first-run.txt
  npm run go
elif [ -n "$(find server/src -newer server/dist/index.js -type f -print | head -n 1)" ]; then
  cat scripts/msg/rebuild.txt
  npm run go
else
  npm start
fi
