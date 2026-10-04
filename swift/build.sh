#!/bin/bash
# 一键编译 + 打包 + （可选）安装 DSH Notch。
#
# 为什么不用 swift build：本机只有 Command Line Tools，没有完整 Xcode，
# xcrun --show-sdk-platform-path 会报 unable to lookup item 'PlatformPath'。
# 因此直接驱动 swiftc。
#
# 用法：
#   ./build.sh            # 编译 + 打包到 .build/DSHNotch.app
#   ./build.sh install    # 再安装到 /Applications 并重启
#   ./build.sh package    # 产出可分发的 zip 到 .build/dist/（附 SHA256）
#   ./build.sh preview    # 编译后离屏渲染形状预览图到 .build/preview/
#   ./build.sh self-test  # 注入合成 NSEvent，验证点击 → 钉住链路
#   ./build.sh proj-test  # 在真实投影缓存 + 事件流上验证指标解析
#   ./build.sh sess-test  # 多会话：排序 / 展开尺寸 / 停摆降级 / 真实多会话发现
#   ./build.sh all-tests  # 上面三套自检全跑一遍
#   ./build.sh probes     # 编译自检探针到 .build/probes/
set -euo pipefail
cd "$(dirname "$0")"

SRC=(Sources/DSHNotch/Core/*.swift Sources/DSHNotch/UI/*.swift Sources/DSHNotch/App.swift)
BIN=.build/DSHNotch
APP=.build/DSHNotch.app
SDK=$(xcrun --show-sdk-path)

# 目标架构默认跟随本机（Intel 机器上是 x86_64），可用环境变量覆盖：
#   DSHNOTCH_ARCH=x86_64 ./build.sh package
# 注意：带刘海的 MacBook 全部是 Apple Silicon，所以 arm64 是主要目标；
# x86_64 只为「外接屏 + Intel 主机」这类边角场景保留（无刘海时折叠态不完整，见 INSTALL.md）。
ARCH="${DSHNOTCH_ARCH:-$(uname -m)}"
TARGET="$ARCH-apple-macos13.0"

echo "==> 编译（$(swiftc --version | head -1)）"
mkdir -p .build
swiftc -O -sdk "$SDK" -target "$TARGET" -parse-as-library \
  -o "$BIN" "${SRC[@]}"

# zstd 解压工具：优先用本机已装的，否则现场编译。
#
# ⚠️ 这里踩过一次坑：zstdlite/build.sh 默认输出到 tools/zstdlite/bin/，
#    而原先只找 $HOME/.local/bin/zstdlite —— 全新机器上两者都不是，
#    编译完 cp 的仍是那个不存在的路径，set -e 直接中断构建。
#    现在改成「本机装的 → 仓库里已有的 → 编译到仓库里」，三条路都通。
ZSTD_SRC=tools/zstdlite/build.sh
ZSTD_REPO_DIR="$(pwd)/tools/zstdlite/bin"
ZSTD_BIN="$HOME/.local/bin/zstdlite"
if [ ! -x "$ZSTD_BIN" ] && [ -x "$ZSTD_REPO_DIR/zstdlite" ]; then
  ZSTD_BIN="$ZSTD_REPO_DIR/zstdlite"
fi
if [ ! -x "$ZSTD_BIN" ]; then
  echo "==> 编译 zstdlite（需要 clang 与网络，从 facebook/zstd 取源码）"
  bash "$ZSTD_SRC" "$ZSTD_REPO_DIR"
  ZSTD_BIN="$ZSTD_REPO_DIR/zstdlite"
fi
[ -x "$ZSTD_BIN" ] || { echo "❌ zstdlite 不可用，无法继续"; exit 1; }
echo "    zstd 工具: $ZSTD_BIN"

echo "==> 打包 $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/DSHNotch"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp "$ZSTD_BIN" "$APP/Contents/Resources/zstdlite"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "    完成：$(du -sh "$APP" | cut -f1)"

case "${1:-}" in
  preview)
    echo "==> 离屏渲染形状预览"
    "$BIN" --render-preview .build/preview
    ;;
  self-test)
    echo "==> 交互自检（注入合成 NSEvent）"
    "$BIN" --self-test
    ;;
  proj-test)
    echo "==> 投影自检（真实缓存 + 事件流端到端）"
    "$BIN" --self-test-projections
    ;;
  sess-test)
    echo "==> 多会话自检（排序 / 尺寸 / 停摆降级 / 真实发现）"
    "$BIN" --self-test-sessions
    ;;
  jump-test)
    echo "==> 跳转自检（深链 / 剪贴板 / 文案）"
    "$BIN" --self-test-jump
    ;;
  all-tests)
    echo "==> 交互自检"
    "$BIN" --self-test
    echo
    echo "==> 投影自检"
    "$BIN" --self-test-projections
    echo
    echo "==> 多会话自检"
    "$BIN" --self-test-sessions
    echo
    echo "==> 跳转自检"
    "$BIN" --self-test-jump
    ;;
  probes)
    echo "==> 编译自检探针"
    mkdir -p .build/probes
    # 探针都用 @main 入口，需要 -parse-as-library（缺了会报
    # 'main' attribute cannot be used in a module that contains top-level code）
    for p in screen window hover click pixels; do
      case "$p" in
        hover|click) extra=(Sources/DSHNotch/Core/NotchMetrics.swift) ;;
        *)           extra=() ;;
      esac
      swiftc -O -sdk "$SDK" -target arm64-apple-macos13.0 -parse-as-library \
        -o ".build/probes/probe-$p" "tools/probe-$p.swift" ${extra[@]+"${extra[@]}"}
    done
    ls -1 .build/probes/
    ;;
  package)
    echo "==> 打包分发件"
    VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
            Resources/Info.plist 2>/dev/null || echo "0.0.0")
    DIST=.build/dist
    rm -rf "$DIST"; mkdir -p "$DIST"
    ZIP="$DIST/DSHNotch-$VER-$ARCH.zip"
    # 用 ditto 而不是 zip：保留可执行位、扩展属性与刚做的代码签名
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
    SHA=$(shasum -a 256 "$ZIP" | awk '{print $1}')
    # 校验文件：随 release 一起上传，下载者一条命令即可核对
    echo "$SHA  DSHNotch-$VER-$ARCH.zip" > "$DIST/SHA256SUMS.txt"
    echo "    产物:   $ZIP"
    echo "    大小:   $(du -sh "$ZIP" | cut -f1)"
    echo "    SHA256: $SHA"
    echo
    echo "    拿到包的人可这样验完整性（需与 SHA256SUMS.txt 同目录）："
    echo "      shasum -a 256 -c SHA256SUMS.txt"
    # 自证：解压后必须仍能通过自检（也就是「别人拿到能用」这条路真的通）
    echo
    echo "==> 打包自证：在临时目录解压并跑自检"
    TMP=$(mktemp -d)
    ditto -x -k "$ZIP" "$TMP"
    "$TMP/DSHNotch.app/Contents/MacOS/DSHNotch" --self-test-jump >/dev/null \
      && echo "    ✅ 解压后二进制可运行、跳转自检通过" \
      || { echo "    ❌ 解压后自检失败"; rm -rf "$TMP"; exit 1; }
    if [ -x "$TMP/DSHNotch.app/Contents/Resources/zstdlite" ]; then
      echo "    ✅ 自带 zstd 解压工具已随包（无需本机预装）"
    else
      echo "    ❌ 缺 zstdlite —— 别人装上会读不到任何会话"; rm -rf "$TMP"; exit 1
    fi
    if codesign --verify --deep "$TMP/DSHNotch.app" 2>/dev/null; then
      echo "    ✅ 代码签名完好"
    else
      echo "    ⚠️  代码签名校验未通过（临时签名，别人需按 INSTALL.md 放行）"
    fi
    rm -rf "$TMP"
    ;;
  install)
    if [ ! -w /Applications ]; then
      echo "❌ /Applications 不可写，改用图形界面安装："
      echo "   在访达里打开 $(pwd)/.build，把 DSHNotch.app 拖进「应用程序」"
      exit 1
    fi
    echo "==> 安装到 /Applications"
    pkill -f "DSHNotch.app/Contents/MacOS/DSHNotch" 2>/dev/null || true
    sleep 0.5
    rm -rf /Applications/DSHNotch.app
    cp -R "$APP" /Applications/
    open /Applications/DSHNotch.app
    echo "    已启动"
    ;;
esac
