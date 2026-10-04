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
#   ./build.sh preview    # 编译后离屏渲染形状预览图到 .build/preview/
set -euo pipefail
cd "$(dirname "$0")"

SRC=(Sources/DSHNotch/Core/*.swift Sources/DSHNotch/UI/*.swift Sources/DSHNotch/App.swift)
BIN=.build/DSHNotch
APP=.build/DSHNotch.app
SDK=$(xcrun --show-sdk-path)

echo "==> 编译（$(swiftc --version | head -1)）"
mkdir -p .build
swiftc -O -sdk "$SDK" -target arm64-apple-macos13.0 -parse-as-library \
  -o "$BIN" "${SRC[@]}"

# zstd 解压工具：优先用已安装的，否则现场编译
ZSTD_SRC=tools/zstdlite/build.sh
ZSTD_BIN="$HOME/.local/bin/zstdlite"
if [ ! -x "$ZSTD_BIN" ]; then
  echo "==> 编译 zstdlite"
  bash "$ZSTD_SRC"
fi

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
  install)
    echo "==> 安装到 /Applications"
    pkill -f "DSHNotch.app/Contents/MacOS/DSHNotch" 2>/dev/null || true
    sleep 0.5
    rm -rf /Applications/DSHNotch.app
    cp -R "$APP" /Applications/
    open /Applications/DSHNotch.app
    echo "    已启动"
    ;;
esac
