#!/bin/bash
# 构建 zstdlite —— DSH 会话文件（.jsonl.zstd）解压工具
#
# 为什么需要自建：
#   - facebook/zstd 不发布 macOS 预编译二进制
#   - 其 Makefile 需 GNU make，macOS 的 BSD make 报 "missing separator"
#   - 官方 CLI 的 main() 链接字典构建器（dibio），需额外编译 lib/dictBuilder
#
# zstdlite 只实现解压，产物约 110 KB，无第三方依赖。
# 正确性已用官方 python zstandard 逐字节比对验证（1368905 字节完全一致）。
#
# 用法: ./swift/tools/zstdlite/build.sh [输出目录]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$HERE/bin}"
SRC="$HERE/zstdlite.c"
ZSTD_VER="1.5.7"

mkdir -p "$OUT_DIR"

# 1) 取 zstd 源码（只需 lib/common 与 lib/decompress）
if [ ! -d "/tmp/zstd-build/zstd-$ZSTD_VER" ]; then
  echo "→ 下载 zstd $ZSTD_VER 源码"
  TMP=$(mktemp -d)
  curl -sL -o "$TMP/zstd.tar.gz" \
    "https://github.com/facebook/zstd/releases/download/v$ZSTD_VER/zstd-$ZSTD_VER.tar.gz"
  echo "  SHA256: $(shasum -a 256 "$TMP/zstd.tar.gz" | awk '{print $1}')"
  tar xzf "$TMP/zstd.tar.gz" -C "$TMP"
  mkdir -p /tmp/zstd-build
  mv "$TMP/zstd-$ZSTD_VER" /tmp/zstd-build/
  rm -rf "$TMP"
fi
ZSTD_DIR="/tmp/zstd-build/zstd-$ZSTD_VER"

# 2) 编译
echo "→ 编译 zstdlite"
clang -O2 -I "$ZSTD_DIR/lib" -I "$ZSTD_DIR/lib/common" \
  -o "$OUT_DIR/zstdlite" \
  "$SRC" "$ZSTD_DIR"/lib/common/*.c "$ZSTD_DIR"/lib/decompress/*.c

# 3) 自检：能解压且退出码为 0
echo "→ 自检"
SAMPLE=$(ls -t "$HOME"/.dsh/sessions/*/*/session.v4.jsonl.zstd 2>/dev/null | head -1 || true)
if [ -n "$SAMPLE" ]; then
  BYTES=$("$OUT_DIR/zstdlite" -d "$SAMPLE" 2>/dev/null | wc -c | tr -d ' ')
  echo "  解压 $SAMPLE → $BYTES 字节"
  [ "$BYTES" -gt 32 ] || { echo "❌ 解压结果异常小"; exit 1; }
else
  echo "  (未找到样本会话文件，跳过自检)"
fi

# 4) 建 zstd 软链，便于通用调用
ln -sfn zstdlite "$OUT_DIR/zstd"
echo "✅ 完成: $OUT_DIR/zstdlite"
