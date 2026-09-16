#!/bin/sh
# 构建安卓客户端（古四音乐 · Android）。
#
# 用法：
#   sh tools/build-android.sh            # 单测 + debug 包 + release 包
#   sh tools/build-android.sh test       # 只跑单测（纯逻辑用例，秒级）
#   sh tools/build-android.sh debug      # 只出 debug 包（可直接装手机）
#   sh tools/build-android.sh release    # 只出 release 包（有签名密钥则已签名）
#   sh tools/build-android.sh lint       # lint（报告落 app/build/reports/lint-results-debug.html）
#
# 环境变量可覆盖：JAVA_HOME / ANDROID_HOME / GRADLE_BIN
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ANDROID_DIR="$ROOT/android"

JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export JAVA_HOME ANDROID_HOME

# 优先用本机已有的 Gradle（省掉 wrapper 每次去官网下 130MB 发行版）
if [ -n "$GRADLE_BIN" ]; then
  :
elif [ -x /opt/gradle-8.7/bin/gradle ]; then
  GRADLE_BIN=/opt/gradle-8.7/bin/gradle
else
  GRADLE_BIN="$ANDROID_DIR/gradlew"
fi

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "找不到 JDK：$JAVA_HOME（用 JAVA_HOME=... 指定）" >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/platforms/android-34" ]; then
  echo "找不到 Android SDK platform 34：$ANDROID_HOME（用 ANDROID_HOME=... 指定）" >&2
  exit 1
fi
# local.properties 是 SDK 位置的本地声明（不入 git）；已存在则不动，尊重原有配置
if [ ! -f "$ANDROID_DIR/local.properties" ]; then
  printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$ANDROID_DIR/local.properties"
fi

TASK="${1:-all}"
case "$TASK" in
  all | "")
    TASKS="testDebugUnitTest assembleDebug assembleRelease"
    ;;
  test)
    TASKS="testDebugUnitTest"
    ;;
  debug)
    TASKS="assembleDebug"
    ;;
  release)
    if [ ! -f "$ANDROID_DIR/keystore/keystore.properties" ]; then
      echo "提醒：没有 android/keystore/keystore.properties。"
      echo "      release 包会是**未签名**状态，装不上手机。生成方式见 android/README.md 第 4 节。"
      echo
    fi
    TASKS="assembleRelease"
    ;;
  lint)
    TASKS="lintDebug"
    ;;
  *)
    echo "未知任务：$TASK（可用：all | test | debug | release | lint）" >&2
    exit 2
    ;;
esac

cd "$ANDROID_DIR"
# shellcheck disable=SC2086  # TASKS 需要按空格拆成多个参数
"$GRADLE_BIN" -p . $TASKS --console=plain

echo
echo "=== 产物 ==="
find "$ANDROID_DIR/app/build/outputs/apk" -name '*.apk' -printf '%p  %s bytes\n' 2>/dev/null | sort
if [ "$TASK" = "lint" ]; then
  echo "lint 报告：$ANDROID_DIR/app/build/reports/lint-results-debug.html"
fi
