#!/usr/bin/env bash
# 生成个人自签名的 Android release keystore。一次性操作，不是每次构建都要跑
# ——生成一次之后这个文件和 ANDROID_KEYSTORE_PASSWORD 就一直用同一份。
#
# 口令只从环境变量 ANDROID_KEYSTORE_PASSWORD 读，不接受命令行参数：命令行参数
# 会留在 shell 历史文件里，环境变量不会。
#
# 用法：ANDROID_KEYSTORE_PASSWORD=你的口令 scripts/gen-android-keystore.sh
#
# 产物落在 android/release.keystore——android/.gitignore 里 *.keystore 这条
# 已经排除了它，不会被提交。口令你自己记住，不会被这个脚本写进任何文件。
set -euo pipefail

OUT="${1:-android/release.keystore}"
ALIAS="todo"
VALIDITY_DAYS=10000   # 大约 27 年，个人自用不用年年续

if [ -z "${ANDROID_KEYSTORE_PASSWORD:-}" ]; then
  echo "先设 ANDROID_KEYSTORE_PASSWORD 环境变量再跑这个脚本" >&2
  echo "（这是 keystore 和签名私钥共用的口令，自己记住——它不会被写进任何文件，" >&2
  echo "  只在你构建 release APK 时再设一次同一个环境变量）" >&2
  exit 1
fi

if [ -f "$OUT" ]; then
  echo "已经有 $OUT 了，不覆盖——真要重新生成先手动删掉它（删了之后已经装出去的" >&2
  echo "release APK 就再也没法覆盖安装，只能先卸载旧版本）" >&2
  exit 1
fi

keytool -genkeypair \
  -v \
  -keystore "$OUT" \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 2048 \
  -validity "$VALIDITY_DAYS" \
  -storepass "$ANDROID_KEYSTORE_PASSWORD" \
  -keypass "$ANDROID_KEYSTORE_PASSWORD" \
  -dname "CN=todo, OU=personal, O=personal, L=NA, ST=NA, C=CN"

echo ""
echo "生成好了：$OUT"
echo "构建 release APK 时把同一个 ANDROID_KEYSTORE_PASSWORD 设到环境变量里，"
echo "android/app/build.gradle 会自动读取并用它签名；不设的话会退回 debug 签名"
echo "（能装，但覆盖安装要先卸载）。"
