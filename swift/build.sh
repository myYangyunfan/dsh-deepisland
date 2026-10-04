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
