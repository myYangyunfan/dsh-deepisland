#!/bin/bash
# 双击这个文件即可完成登记（macOS 会用终端打开它，跑完自动关窗）。
# 文件名用 ASCII（不用中文）——中文名在部分工具链/编码环境下会显示成问号。
#
# 为什么需要它：插件管理器的「安装」只跑 pnpm add，只写 dependencies；
# 而宿主是按 dsh.profile.bundles 顺序叠插件树的。不登记 = 不会被加载，
# 而且界面上**一点提示都没有**（插件管理器里照样显示「已安装」）。
#
# 这个文件被设计成不需要用户知道仓库在哪 —— 它自己找。

set -uo pipefail

BUNDLE="@dsh-external/dsh-vibe-island"
PROFILES="$HOME/.dsh/profiles"

say()  { printf '%s\n' "$*"; }
fail() { say ""; say "❌ $*"; say ""; say "按任意键关闭这个窗口…"; read -r _; exit 1; }

say "╭─────────────────────────────────────────────╮"
say "│  DSH 智能体刘海灵动岛 · 完成登记              │"
say "╰─────────────────────────────────────────────╯"
say ""

# --- 找 DSH 在跑哪个 profile（从宿主进程命令行里读）-------------------------
PROFILE=""
if command -v ps >/dev/null 2>&1; then
  LINE=$(ps -ax -o command 2>/dev/null | grep 'dsh-desktop-host' | grep -v grep | head -1 || true)
  if [ -n "$LINE" ]; then
    PROFILE=$(printf '%s\n' "$LINE" | sed -n "s|.*$PROFILES/\([^/ ]*\).*|\1|p")
  fi
fi
[ -n "$PROFILE" ] || PROFILE="desktop"

DIR="$PROFILES/$PROFILE"
say "DSH profile：$PROFILE"

[ -f "$DIR/package.json" ] || fail "找不到 profile 的 package.json：$DIR
（DSH 可能还没启动过。先打开一次 DeepSeek Harness 再双击这个文件。）"

# --- 状态检查 ----------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  SCRIPT="$DIR/node_modules/$BUNDLE/scripts/register-bundle.mjs"
  if [ -f "$SCRIPT" ]; then
    say ""
    say "用插件自带的登记脚本（更可靠，能同时校验依赖是否装好）…"
    if node "$SCRIPT"; then
      say ""
      say "✅ 登记完成。**请重启 DeepSeek Harness**（退出应用再打开，不是关窗口）。"
      say "   重启后：DSH 窗口内会出现灵动岛；macOS 上还会自动装好刘海 app。"
      say ""
      say "按任意键关闭这个窗口…"; read -r _; exit 0
    else
      fail "登记脚本报告失败，细节见上面。"
    fi
  fi
fi

# --- 兜底：直接改 profile 的 package.json -------------------------------------
# 没有 node、或脚本还没随包装上时走这条纯 shell 的路。
BACKUP="$DIR/package.json.bak-register"
cp -p "$DIR/package.json" "$BACKUP" || fail "无法备份 package.json：$BACKUP"

node -e '
const fs=require("fs");
const p=process.argv[1], bundle=process.argv[2];
const m=JSON.parse(fs.readFileSync(p,"utf8"));
if(!(m.dsh&&m.dsh.profile)) m.dsh={profile:{}};
if(!Array.isArray(m.dsh.profile.bundles)) m.dsh.profile.bundles=[];
if(m.dsh.profile.bundles.includes(bundle)){console.log("本来就在 bundles 里，无需改动。");process.exit(0);}
m.dsh.profile.bundles.push(bundle);
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
console.log("已加入 dsh.profile.bundles：");
for(const b of m.dsh.profile.bundles) console.log("  · "+b);
' "$DIR/package.json" "$BUNDLE" 2>/dev/null \
  || fail "改写 package.json 失败。备份在：$BACKUP"

say ""
say "✅ 登记完成（原文件已备份为 $BACKUP）"
say ""
say "👉 **请重启 DeepSeek Harness**（退出应用再打开，不是关窗口）。"
say ""
say "按任意键关闭这个窗口…"
read -r _
