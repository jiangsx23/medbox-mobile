#!/usr/bin/env bash
# 把 android/app/build.gradle 的 release 签名改成用 keys/ 里那把固定的密钥，
# 并把 APK 限制成两种 ARM ABI。**可以重复执行**，已改过就跳过。
#
# 用法：npx expo prebuild --platform android 之后跑一次
#       bash scripts/android-signing.sh
#
# ── 为什么必须有这个脚本 ───────────────────────────────────────────────
# expo prebuild 生成的 build.gradle 里，release 用的是 `signingConfigs.debug`，
# 也就是 android/app/debug.keystore —— 而这个文件在 `android/` 里面，
# 而 `android/` 是 **git 忽略的、每次 prebuild --clean 都会被重新生成**。
#
# 一旦签名变了，安卓会**拒绝覆盖安装**（签名不一致），唯一的办法是先卸载 ——
# **卸载会连本地数据库一起删掉**。这个 App 的数据只存在手机本地、没有云端，
# 删了就真没了。而 M1 到 M7 之间要反复重新出包，撞上这件事只是时间问题。
#
# 所以签名密钥放在 `keys/`（不在 android/ 里，prebuild 不会碰），
# 再用这个脚本把生成的 build.gradle 重新指过去。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE="$ROOT/android/app/build.gradle"
KS="$ROOT/keys/medbox-release.keystore"

if [ ! -f "$GRADLE" ]; then
  echo "!! 找不到 $GRADLE —— 先跑 npx expo prebuild --platform android"
  exit 1
fi
if [ ! -f "$KS" ]; then
  echo "!! 找不到签名密钥 $KS"
  echo "   重新生成一把（注意：新密钥签的包装不进已装的旧 App，必须卸载重装，数据会丢）："
  echo "   keytool -genkeypair -v -storetype PKCS12 -keystore keys/medbox-release.keystore \\"
  echo "     -alias medbox -keyalg RSA -keysize 2048 -validity 10000 \\"
  echo "     -storepass REDACTED -keypass REDACTED -dname \"CN=medbox, OU=family, O=medbox, C=CN\""
  exit 1
fi

# ── 1. 签名配置 ────────────────────────────────────────────────────────
# 用 .bak 判断「是否已经改过」不够可靠（二次 prebuild 会重置），所以直接查标记行。
if grep -q "medbox-release" "$GRADLE"; then
  echo "签名已配置过，跳过"
else
  echo "写入 release 签名配置…"
  cp "$GRADLE" "$GRADLE.orig"

  # 1a. 在 signingConfigs 里加一块 release，指向 keys/
  python - "$GRADLE" <<'PY'
import io, re, sys
gradle = sys.argv[1]
src = io.open(gradle, encoding='utf-8').read()

anchor = "signingConfigs {"
block = """signingConfigs {
        release {
            // 指向仓库里的 keys/，不在 android/ 内，prebuild 不会碰它。
            // 换掉这把密钥 = 已装的 App 无法覆盖升级，必须卸载重装 = 数据全丢。
            storeFile file("%s")
            storePassword "%s"
            keyAlias "%s"
            keyPassword "%s"
        }
""" % ('../../keys/medbox-release.keystore', 'REDACTED', 'medbox', 'REDACTED')

assert src.count(anchor) == 1, "signingConfigs 出现次数不是 1，生成的模板可能变了"
src = src.replace(anchor, block, 1)

# 1b. release 构建类型改用它（原来是 signingConfigs.debug）
src = re.sub(
    r"(release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug",
    r"\1signingConfig signingConfigs.release",
    src, count=1, flags=re.S)
assert "signingConfig signingConfigs.release" in src, "没能把 release 指向新签名"

io.open(gradle, 'w', encoding='utf-8', newline='\n').write(src)
print("  signingConfigs.release 已写入")
PY

  # 1c. ABI 只要两种 ARM（CLAUDE.md 定的 universal APK），顺手把 x86 去掉，
  #     安装包小一半左右。放在 defaultConfig 里。
  python - "$GRADLE" <<'PY'
import io, re, sys
gradle = sys.argv[1]
src = io.open(gradle, encoding='utf-8').read()
if 'abiFilters' in src:
    print("  abiFilters 已存在，跳过")
else:
    anchor = "defaultConfig {"
    add = """defaultConfig {
        // 只打 32/64 位 ARM：小米8 是 arm64，另一种给更老的机器。
        // x86/x86_64 只对模拟器有意义，装到手机上纯属白白变大。
        ndk {
            abiFilters "armeabi-v7a", "arm64-v8a"
        }
"""
    assert src.count(anchor) == 1
    src = src.replace(anchor, add, 1)
    io.open(gradle, 'w', encoding='utf-8', newline='\n').write(src)
    print("  abiFilters 已写入")
PY
fi

# ── 2. android/local.properties（SDK 路径）──────────────────────────────
# 和签名配置是同一类问题：`android/` 被 prebuild 整个删掉时，这个文件一起没，
# 而 gradle 找不到 SDK 会**当场失败**：
#   SDK location not found. Define a valid SDK location with an ANDROID_HOME
#   environment variable or by setting the sdk.dir path in your project's
#   local properties file at '…/android/local.properties'.
# 2026-09-21 实测踩到：prebuild 之后直接 gradle，报的就是这条。
#
# 写进这个文件比靠 ANDROID_HOME 可靠 —— 环境变量在**每个新终端**都要重设，
# 漏掉就复现这个错；local.properties 是落到盘上的，重开终端也还在。
LP="$ROOT/android/local.properties"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ] && [ -d /d/Android/Sdk ]; then
  SDK="/d/Android/Sdk"          # 本机默认位置（见 AGENTS.md「构建配置」）
fi

if [ -z "$SDK" ]; then
  echo "!! 找不到 Android SDK：ANDROID_HOME / ANDROID_SDK_ROOT 都没设，/d/Android/Sdk 也不存在"
  echo "   先 export ANDROID_HOME=/d/Android/Sdk 再跑这个脚本"
  exit 1
fi

# Java 的 properties 里反斜杠是转义符，一律写成正斜杠（gradle 两种都认）
SDK_WIN="$(printf '%s' "$SDK" | sed 's|\\|/|g')"
if [ -f "$LP" ] && grep -qxF "sdk.dir=$SDK_WIN" "$LP"; then
  echo "local.properties 已正确，跳过"
else
  echo "写入 android/local.properties（sdk.dir=$SDK_WIN）…"
  printf 'sdk.dir=%s\n' "$SDK_WIN" > "$LP"
fi

# ── 3. 自检 ────────────────────────────────────────────────────────────
echo
echo "--- 自检 ---"
grep -n "medbox-release.keystore\|signingConfig signingConfigs" "$GRADLE" || true
grep -n "abiFilters" "$GRADLE" || true
grep -n "^sdk.dir=" "$LP" || true
echo
echo "OK。接着跑： cd android && ./gradlew assembleRelease"
