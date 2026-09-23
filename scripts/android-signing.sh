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
#
# ── 口令放哪（2026-09-23 开源时挪的）───────────────────────────────────
# 🔴 **口令不进仓库。** 它写在 `keys/keystore.properties`，而 `keys/` 已在 .gitignore 里：
#
#     storePassword=…
#     keyPassword=…
#
# 原先是硬编码在本文件里的 —— 而本文件被 git 跟踪，**准备开源之后那条理由不成立了**：
# 密钥 + 口令一起公开 = 任何人都能签出一个可覆盖安装、并且能读到那个数据库的「新版本」，
# 等于把「数据只在手机本地」这条承诺作废。所以现在从文件读。
#
# 为什么用文件而不是环境变量：环境变量在**每个新终端**都要重设，漏掉就复现「读不到口令」；
# 落到盘上的文件重开终端也还在 —— 与下面 local.properties 是同一个理由。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE="$ROOT/android/app/build.gradle"
KS="$ROOT/keys/medbox-release.keystore"

# 🔴 同一个目录的 **Windows 写法**（`D:/…`），专供交给 python 用。
#    下面那两个改文件的 python 是**原生程序**：平时 MSYS 会自动把参数里的
#    `/d/…` 转成 `D:\…`，**但 `MSYS_NO_PATHCONV=1` 时不会** —— 而 AGENTS.md
#    教人用 adb 时第一步就是 `export MSYS_NO_PATHCONV=1`，同一个终端接着跑本脚本
#    是很自然的操作。**2026-09-23 实测踩到**：python 拿到 `/d/Documents/…`
#    直接 `FileNotFoundError`，`set -e` 让脚本当场退出。
#    ⚠️ 这个失败**只影响签名那一段**，非常容易被当成噪音略过，后果是打出一个
#    用 `debug.keystore` 签名的包 —— 装不上已装的 App（签名不符），白等 20 分钟。
#    所以不依赖那个自动转换，自己用 bash 内建的 `pwd -W` 取 Windows 形式。
ROOT_WIN="$( (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -W) 2>/dev/null || printf '%s' "$ROOT")"
GRADLE_PY="$ROOT_WIN/android/app/build.gradle"

if [ ! -f "$GRADLE" ]; then
  echo "!! 找不到 $GRADLE —— 先跑 npx expo prebuild --platform android"
  exit 1
fi
if [ ! -f "$KS" ]; then
  echo "!! 找不到签名密钥 $KS"
  echo "   重新生成一把（注意：新密钥签的包装不进已装的旧 App，必须卸载重装，数据会丢）："
  echo "   keytool -genkeypair -v -storetype PKCS12 -keystore keys/medbox-release.keystore \\"
  echo "     -alias medbox -keyalg RSA -keysize 2048 -validity 10000 \\"
  echo "     -dname \"CN=medbox, OU=family, O=medbox, C=CN\""
  echo "   ↑ 口令由 keytool 交互式问，这里刻意不写 -storepass —— 写了口令就回到本文件里了"
  echo "     问完把口令填进 keys/keystore.properties（见文件头「口令放哪」）"
  exit 1
fi

# ── 0. 口令 ────────────────────────────────────────────────────────────
KSP="$ROOT/keys/keystore.properties"
if [ ! -f "$KSP" ]; then
  echo "!! 找不到 $KSP"
  echo "   里面放你自己的签名口令（这个文件不进仓库），两行："
  echo "     storePassword=<口令>"
  echo "     keyPassword=<口令>"
  exit 1
fi

# 取一个键的值。`tr -d '\r'` 是为了容忍 CRLF 存盘 —— 这台机器上 Git 会把文本转成 CRLF，
# 不管的话口令尾巴上会多一个 \r，gradle 报的是「keystore password was incorrect」，
# 读起来像口令错、其实是多了一个字节。
read_prop() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$KSP" | tr -d '\r' | tail -1
}
STOREPASS="$(read_prop storePassword)"
KEYPASS="$(read_prop keyPassword)"
if [ -z "$KEYPASS" ]; then
  KEYPASS="$STOREPASS"        # PKCS12 本来也只认一个口令，只写一行是常见情形
fi
if [ -z "$STOREPASS" ]; then
  echo "!! $KSP 里没读到 storePassword"
  exit 1
fi
# 走环境变量交给下面的 python，**不进 argv** —— argv 在 `ps` 里别人看得见
export STOREPASS KEYPASS

# ── 1. 签名配置 ────────────────────────────────────────────────────────
# 用 .bak 判断「是否已经改过」不够可靠（二次 prebuild 会重置），所以直接查标记行。
if grep -q "medbox-release" "$GRADLE"; then
  echo "签名已配置过，跳过"
else
  echo "写入 release 签名配置…"
  cp "$GRADLE" "$GRADLE.orig"

  # 1a. 在 signingConfigs 里加一块 release，指向 keys/
  # PYTHONIOENCODING：不设的话 python 按本地代码页输出，中文在这台机器上是乱码
  # （`已写入` 显示成 `��д��`），看着像脚本坏了。见 windows-cmd-encoding-936。
  PYTHONIOENCODING=utf-8 python - "$GRADLE_PY" <<'PY'
import io, os, re, sys
gradle = sys.argv[1]
src = io.open(gradle, encoding='utf-8').read()

# 口令从环境变量来 —— 源头是 keys/keystore.properties，那个文件不进仓库（见脚本文件头）。
# 走环境变量而不是 argv：argv 在 `ps` 里别人看得见。
storepass = os.environ['STOREPASS']
keypass = os.environ['KEYPASS']

# 自检：口令里若有引号或反斜杠，下面 %s 把它插进 gradle 会把字符串截断，
# 生成的 build.gradle 语法就坏了 —— 而报错是 gradle 那边的
# 「Could not compile build file」，看不出跟口令有关。当场拦下。
for _name in ('STOREPASS', 'KEYPASS'):
    _v = os.environ[_name]
    assert '"' not in _v and '\\' not in _v, \
        '%s 里有引号或反斜杠，会让生成的 build.gradle 变形' % _name

anchor = "signingConfigs {"
block = """signingConfigs {
        release {
            // 指向 keys/（已 gitignore），不在 android/ 内，prebuild 不会碰它。
            // 口令由 scripts/android-signing.sh 从 keys/keystore.properties 注入。
            // 换掉这把密钥 = 已装的 App 无法覆盖升级，必须卸载重装 = 数据全丢。
            storeFile file("%s")
            storePassword "%s"
            keyAlias "%s"
            keyPassword "%s"
        }
""" % ('../../keys/medbox-release.keystore', storepass, 'medbox', keypass)

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
  # PYTHONIOENCODING：不设的话 python 按本地代码页输出，中文在这台机器上是乱码
  # （`已写入` 显示成 `��д��`），看着像脚本坏了。见 windows-cmd-encoding-936。
  PYTHONIOENCODING=utf-8 python - "$GRADLE_PY" <<'PY'
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

# 🔴 MSYS 的挂载路径（`/d/Android/Sdk`）Java **不认识** —— 它会被当成
# 「当前盘符下的 \d\Android\Sdk」，也就是 D:\d\Android\Sdk，不存在。
# 这台机器上 ANDROID_HOME 通常是空的，于是上面那个 fallback 拿到的正是 `/d/…` 形式，
# 原样写进 local.properties ⇒ gradle 报的就是这个脚本本该防住的那条
# 「SDK location not found」。**2026-09-22 实测踩到**（上一版只把反斜杠换成斜杠，
# 没处理盘符那一段，所以注释里那句「gradle 两种都认」是错的）。
# 与 `D:\Android\Sdk` 两种写法 gradle 都认，但**只认 Windows 形式**。
case "$SDK" in
  /[A-Za-z]/*) SDK="$(printf '%s' "$SDK" | sed 's|^/\([A-Za-z]\)/|\1:/|' | sed 's|^\([a-z]\)|\U\1|')" ;;
esac

# Java 的 properties 里反斜杠是转义符，一律写成正斜杠
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
