#!/usr/bin/env bash
# 安卓出包工具链一键安装：JDK 17 + Android SDK（cmdline-tools）
# 目标目录刻意用短路径 D:\Android —— Windows 路径长度限制会咬安卓编译。
# 本脚本可重复执行，已装好的步骤会跳过。
set -u

LOG_TAG() { echo; echo "===== [$1] $(date '+%H:%M:%S') ====="; }

SDK_ROOT="/d/Android"
SDK_DIR="$SDK_ROOT/Sdk"
CMDLINE_DIR="$SDK_ROOT/cmdline-tools"
JDK_DIR="/c/Program Files/Eclipse Adoptium"

# ---------- 1. JDK 17 ----------
LOG_TAG "1/4 JDK 17"
if ls -d "$JDK_DIR"/jdk-17* >/dev/null 2>&1; then
  echo "已存在，跳过：$(ls -d "$JDK_DIR"/jdk-17*)"
else
  winget install --id EclipseAdoptium.Temurin.17.JDK --exact \
    --accept-source-agreements --accept-package-agreements \
    --disable-interactivity 2>&1 | tail -20
fi

JAVA_HOME_FOUND="$(ls -d "$JDK_DIR"/jdk-17* 2>/dev/null | head -1)"
if [ -z "$JAVA_HOME_FOUND" ]; then
  echo "!! JDK 安装失败，后续步骤无法继续"
  exit 1
fi
export JAVA_HOME="$JAVA_HOME_FOUND"
echo "JAVA_HOME=$JAVA_HOME"
"$JAVA_HOME/bin/java" -version 2>&1

# ---------- 2. Android cmdline-tools ----------
LOG_TAG "2/4 Android cmdline-tools"
mkdir -p "$CMDLINE_DIR"
if [ -x "$CMDLINE_DIR/latest/bin/sdkmanager.bat" ]; then
  echo "已存在，跳过"
else
  ZIP="$SDK_ROOT/cmdline-tools.zip"
  if [ ! -f "$ZIP" ]; then
    echo "下载 commandlinetools-win zip ..."
    curl -L --fail --retry 3 -o "$ZIP" \
      "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip"
  fi
  echo "解压 ..."
  unzip -q -o "$ZIP" -d "$SDK_ROOT/cmtmp"
  # 官方 zip 内层是 cmdline-tools/，sdkmanager 要求落在 <root>/cmdline-tools/latest/
  rm -rf "$CMDLINE_DIR/latest"
  mv "$SDK_ROOT/cmtmp/cmdline-tools" "$CMDLINE_DIR/latest"
  rmdir "$SDK_ROOT/cmtmp" 2>/dev/null
fi
ls "$CMDLINE_DIR/latest/bin/" | head

# ---------- 3. 安装 SDK 组件 ----------
LOG_TAG "3/4 SDK components"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
SDKM="$CMDLINE_DIR/latest/bin/sdkmanager.bat"

echo "接受许可 ..."
yes | "$SDKM" --sdk_root="$SDK_DIR" --licenses >/dev/null 2>&1
echo "许可已接受"

echo "安装 platform-tools / platforms;android-36 / build-tools;36.0.0 ..."
"$SDKM" --sdk_root="$SDK_DIR" \
  "platform-tools" "platforms;android-36" "build-tools;36.0.0" 2>&1 | tail -15

# ---------- 4. 验证 ----------
LOG_TAG "4/4 验证"
echo "--- SDK 目录 ---"
ls "$SDK_DIR" 2>&1
echo "--- adb ---"
"$SDK_DIR/platform-tools/adb.exe" version 2>&1 | head -2
echo "--- platforms ---"
ls "$SDK_DIR/platforms" 2>&1
echo "--- build-tools ---"
ls "$SDK_DIR/build-tools" 2>&1

echo
echo "===== 完成 ====="
echo "JAVA_HOME=$JAVA_HOME"
echo "ANDROID_HOME=$SDK_DIR"
