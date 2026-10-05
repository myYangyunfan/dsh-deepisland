#!/bin/bash
# 双击这个文件即可完成登记（macOS 会用终端打开它，跑完自动关窗）。
# 文件名用 ASCII（不用中文）——中文名在部分工具链/编码环境下会显示成问号。
#
# 为什么需要它：插件管理器的「安装」只跑 pnpm add，只写 dependencies；
# 而宿主是按 dsh.profile.bundles 顺序叠插件树。不登记 = 不会被加载，
# 而且界面上**一点提示都没有**（插件管理器里照样显示「已安装」）。
#
# 已查证：宿主里唯一会写 bundles 的函数 reconcileProfilePlugins
# **在插件管理器（installBundle）里没有被调用**（只在 export 列表里出现），
# 所以这是宿主 UI 路径的实现缺口，不是配置问题。
# 而官方 CLI（`dsh plugin add <git-url>`）走另一条代码路径，会同时写两处。
#
# 本脚本优先用官方 CLI，失败再回退到直接改 profile 的 package.json。
# 不需要用户知道仓库在哪 —— 它自己找 profile、自己备份。

set -uo pipefail

BUNDLE="@dsh-external/dsh-vibe-island"
GIT_URL="git+https://github.com/myYangyunfan/dsh-deepisland.git"
PROFILES="$HOME/.dsh/profiles"
APP="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

say()  { printf '%s\n' "$*"; }
fail() { say ""; say "❌ $*"; say ""; say "按任意键关闭这个窗口…"; read -r _; exit 1; }

say "╭─────────────────────────────────────────────╮"
say "│  DSH 智能体刘海灵动岛 · 完成登记              │"
say "╰─────────────────────────────────────────────╯"
say ""

# 判断「是否已在 bundles 里」——只在 dependencies 里出现是不够的
in_bundles() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
      const fs=require("fs"), p=process.argv[1], b=process.argv[2];
      const m=JSON.parse(fs.readFileSync(p,"utf8"));
      process.exit((m.dsh&&m.dsh.profile&&(m.dsh.profile.bundles||[]).includes(b))?0:1);
    ' "$1" "$BUNDLE" >/dev/null 2>&1
}

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

# --- 已经登记了就别折腾 -------------------------------------------------------
if in_bundles "$DIR/package.json"; then
  say ""
  say "✅ 已经在 dsh.profile.bundles 里，无需改动。"
  say ""
  say "👉 如果功能还没生效，请**重启 DeepSeek Harness**（退出应用再打开，不是关窗口）。"
  say ""
  say "按任意键关闭这个窗口…"; read -r _
  exit 0
fi

# --- 优先走宿主官方 CLI ------------------------------------------------------
# 用法是官方的增删 cycle：**remove 再 add**。
#
# 为什么要先 remove：宿主 CLI 内部的 bundles 同步只处理**本次新增**的依赖
# （源码：`for (const name of dependencies) { if (beforeDeps.has(name)) continue; … }`）。
# 所以对一个「已在 dependencies、但不在 bundles」的插件直接 add，
# pnpm 会答 "Already up to date"，同步那一步根本不会执行 —— 这正是
# 插件管理器那个缺口的成因。remove 把它从 dependencies 摘掉，
# add 才是真正的「新增」，才会写 bundles。
if [ -x "$APP" ]; then
  say ""
  say "用宿主官方命令登记（remove → add 的完整 cycle）…"
  say "    dsh plugin --profile $PROFILE add <git 地址>"
  say ""
  # 先 remove（若已装），失败无所谓 —— 目的只是让它变成「未安装」
  "$APP" plugin --profile "$PROFILE" remove "$BUNDLE" >/dev/null 2>&1 || true
  "$APP" plugin --profile "$PROFILE" add "$GIT_URL" 2>&1 | tail -5
  # 必须自己核对结果：CLI 不会报告「bundles 是否已同步」
  if in_bundles "$DIR/package.json"; then
    say ""
    say "✅ 登记完成（dependencies 与 bundles 都已写好）。"
    say ""
    say "👉 请**重启 DeepSeek Harness**（退出应用再打开，不是关窗口）。"
    say "   重启后：DSH 窗口内会出现灵动岛；macOS 上还会自动装好刘海 app。"
    say ""
    say "按任意键关闭这个窗口…"; read -r _
    exit 0
  fi
  say "   （官方命令跑完了，但 bundles 里还没出现本插件，继续用兜底方式）"
fi

# --- 兜底：直接改 profile 的 package.json -------------------------------------
say ""
say "改用兜底方式直接改写 profile 的 package.json…"
BACKUP="$DIR/package.json.bak-register"
cp -p "$DIR/package.json" "$BACKUP" || fail "无法备份 package.json：$BACKUP"

if command -v node >/dev/null 2>&1; then
  node -e '
const fs=require("fs");
const p=process.argv[1], bundle=process.argv[2];
const m=JSON.parse(fs.readFileSync(p,"utf8"));
m.dsh=m.dsh||{}; m.dsh.profile=m.dsh.profile||{};
if(!Array.isArray(m.dsh.profile.bundles)) m.dsh.profile.bundles=[];
if(m.dsh.profile.bundles.includes(bundle)){console.log("本来就在 bundles 里，无需改动。");process.exit(0);}
m.dsh.profile.bundles.push(bundle);
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n");
console.log("已加入 dsh.profile.bundles：");
for(const b of m.dsh.profile.bundles) console.log("  · "+b);
' "$DIR/package.json" "$BUNDLE" 2>/dev/null \
  || fail "改写 package.json 失败。备份在：$BACKUP"
else
  fail "这台机器上没有 node，无法自动改写。
可以手动编辑 $DIR/package.json，
在 dsh.profile.bundles 数组里加一项 \"$BUNDLE\"。"
fi

say ""
say "✅ 登记完成（原文件已备份为 $BACKUP）"
say ""
say "👉 请**重启 DeepSeek Harness**（退出应用再打开，不是关窗口）。"
say ""
say "按任意键关闭这个窗口…"
read -r _
