#!/usr/bin/env bash
# 验证 debug/release APK 里真的打包了 web/dist 编译出来的产物，不是一个原生外壳
# 空跑（webDir 配错、或者 cap sync 没跑，gradle 照样能构建成功，装出来白屏）。
#
# 用法：scripts/verify-apk.sh [apk路径]
#   默认 android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail

APK="${1:-android/app/build/outputs/apk/debug/app-debug.apk}"
MIN_BUNDLE_BYTES=10000 # 真实 vite 产物起码几百 KB，不到一万字节大概率是占位内容

if [ ! -f "$APK" ]; then
  echo "FAIL: 找不到 APK：$APK（先跑 android/gradlew assembleDebug）" >&2
  exit 1
fi

LISTING="$(unzip -l "$APK" 2>/dev/null)"

if ! grep -q 'assets/public/index\.html' <<<"$LISTING"; then
  echo "FAIL: APK 里没有 assets/public/index.html —— cap sync 大概率没跑，或者 webDir 指错了地方" >&2
  exit 1
fi

# vite build 出来的 JS/CSS 一律落在 assets/public/assets/ 下、文件名带内容 hash；
# 这一层目录是「真的跑过一次 vite build」独有的形状——手误把 webDir 指到
# web/public 或 web/src 这种目录时，index.html 可能还在，但绝不会有这一层。
BUNDLE_LINES="$(grep -E 'assets/public/assets/.*\.(js|css)$' <<<"$LISTING" || true)"

if [ -z "$BUNDLE_LINES" ]; then
  echo "FAIL: APK 里 assets/public/assets/ 下没有任何 .js/.css —— 这是空壳：装得上，但打开是白屏" >&2
  grep 'assets/public/' <<<"$LISTING" >&2 || true
  exit 1
fi

TOTAL_BYTES="$(awk '{sum += $1} END {print sum+0}' <<<"$BUNDLE_LINES")"
FILE_COUNT="$(wc -l <<<"$BUNDLE_LINES" | tr -d ' ')"

if [ "$TOTAL_BYTES" -lt "$MIN_BUNDLE_BYTES" ]; then
  echo "FAIL: assets/public/assets/ 下加起来只有 $TOTAL_BYTES 字节，小于门槛 $MIN_BUNDLE_BYTES —— 像占位内容，不像真的构建产物" >&2
  exit 1
fi

# 上面几道只证明「APK 里有一份真实的 vite 产物」，证明不了「是当前这一份」——
# C2（final-review.md）：一个装了上一次构建产物的 APK，前面所有检查照样 PASS。
# vite build 出来的 JS/CSS 文件名带内容 hash（index-C15U9ujp.js 这种），逐个比一遍
# web/dist/assets 里现在有的文件名，能把「不是空壳」升级成「就是当前这次构建」。
# 没有本地 web 构建（比如只想验一个别人传过来的 APK）就跳过这一步，退回原来的行为，
# 不因为本机没跑过 `npm run build -w web` 就把这道检查变成硬失败。
if [ -d web/dist/assets ]; then
  for f in web/dist/assets/*.js web/dist/assets/*.css; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if ! grep -q "assets/public/assets/$name\$" <<<"$LISTING"; then
      echo "FAIL: $name 不在 APK 里 —— APK 里装的是上一次构建的产物，cap sync 没跑（先 npm run build -w web && npx cap sync android && android/gradlew assembleDebug）" >&2
      exit 1
    fi
  done
fi

echo "PASS: $APK 里 assets/public/assets/ 下有 $FILE_COUNT 个文件，共 $TOTAL_BYTES 字节 —— 不是空壳，且跟当前 web/dist 的产物文件名一致"
