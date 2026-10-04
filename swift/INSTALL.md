# 安装 DSH Notch（给别人用）

这份说明面向「**要把 DSH Notch 装到自己 Mac 上**」的人。
如果你是本仓库作者、机器上已经有源码，`./build.sh install` 一行就够，不用看这里。

## 两条路，选一条

| | 方式一：下载现成包 | 方式二：从源码编译 |
| :--- | :--- | :--- |
| 适合谁 | 只想用 | 想改代码 / 想跟着仓库更新 |
| 额外需要 | 无 | Xcode 命令行工具（首次约 1–2 GB） |
| 唯一门槛 | Gatekeeper 手动放行一次 | 无 |
| 更新方式 | 重新下载新包 | `git pull && ./build.sh install` |

两条路装出来的东西**完全一样**。包是自包含的，不依赖你的开发环境。

## 0. 前置条件

| 项 | 要求 | 怎么查 |
| :--- | :--- | :--- |
| 系统 | macOS 13 或更高 | `sw_vers -productVersion` |
| 芯片 | Apple Silicon（arm64） | `uname -m` → `arm64` |
| DSH | 装了 **DeepSeek Harness Desktop**，且至少跑过一轮对话 | 看 `~/.dsh` 目录在不在 |

数据全部来自本机 `~/.dsh` 下的会话文件。它**只读**这些文件，不联网、不改 DSH 任何东西。

> **Intel 芯片**：官方只出 arm64 包，走方式二加一个变量即可：
> `DSHNOTCH_ARCH=x86_64 ./build.sh install`。
> 另注：带刘海的 MacBook 全部是 Apple Silicon，所以 x86_64 基本只在外接屏场景用得上。

## 方式一：下载现成包

> 注：如果 Releases 页上**还没有**这个版本的包，说明还没发布 —— 走下面的方式二，
> 或者直接找给你这份说明的人要 zip。

1. 打开 Releases 页：<https://github.com/myYangyunfan/dsh-deepisland/releases>
2. 把这两个文件下到同一个目录（比如「下载」）：
   - `DSHNotch-0.3.0-arm64.zip`
   - `SHA256SUMS.txt`
3. **核对完整性**（别跳过，尤其从别人转发来的包）：
   ```bash
   cd ~/Downloads
   shasum -a 256 -c SHA256SUMS.txt
   # 期望看到：DSHNotch-0.3.0-arm64.zip: OK
   ```
4. 双击解压，把 `DSHNotch.app` 拖进「应用程序」
5. 放行 Gatekeeper（只做一次，见下节）
6. 双击启动。菜单栏出现**波形图标**就是就绪了

### 为什么要放行、怎么放行

这个 app 只做了**临时签名**（ad-hoc），没有 Apple 开发者证书 —— 那要每年 99 美元。
从网上下载的文件会被 macOS 打上「隔离」标记，所以第一次打开会弹：

> 「Apple 无法检查 DSHNotch 是否包含恶意软件」

两种放行方式，任选一种：

```bash
# A. 命令行（最快）
xattr -dr com.apple.quarantine /Applications/DSHNotch.app
```

**B. 图形方式**：在「应用程序」里 **右键**（或按住 Control 点）`DSHNotch` → 「打开」
→ 弹窗里**再点一次**「打开」。
必须走右键菜单，**直接双击是不行的**。

放行一次，以后不再提示。

## 方式二：从源码编译

需要 Xcode **命令行工具**（含 `swiftc`）。没有的话先装：

```bash
xcode-select --install      # 弹出安装向导，跟着点完
xcode-select -p             # 应输出 /Library/Developer/CommandLineTools
xcrun --show-sdk-path       # 能输出路径 = 可用了
```

注意：**只需要命令行工具，不需要装完整 Xcode**（本机就只在有命令行工具的机器上编译通过）。

然后：

```bash
git clone https://github.com/myYangyunfan/dsh-deepisland.git
cd dsh-deepisland/swift
./build.sh install          # 编译 + 打包 + 装到 /Applications + 启动
```

`build.sh` 会自动做完下面这些，不用你干预：

1. 用 `swiftc` 直接编译（绕开 `swift build`，因为只有命令行工具时它会失败）
2. 编译自带的 `zstdlite` 解压工具 —— 首次会从 facebook/zstd 取源码，**需要联网**
3. 把工具一起打进 `.app`，再做临时签名

装完可以验一下：

```bash
./build.sh all-tests        # 四套自检：交互 / 投影 / 多会话 / 跳转
```

### 想打个包发给同事

```bash
./build.sh package
# 产物：.build/dist/DSHNotch-<版本>-<架构>.zip 和 SHA256SUMS.txt
```

打包过程会自己解压回来跑一遍自检，确认「别人拿到能用」这条路是通的。

## 装完先关掉 DSH 窗口里那个岛

如果你**同时**装过 DSH 的 `dsh-vibe-island` 插件，会出现两个状态栏
（DSH 窗口内中部一个 + 真实刘海一个），视觉冗余。
只想要系统级这个的话，把插件从 bundle 列表里摘掉：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app"
      // 把 "@dsh-external/dsh-vibe-island" 从这里删掉
    ]
  }
}
```

`dependencies` 里的依赖项可以留着不删（保留安装状态，随时能在插件管理里重新启用）。
**改完要重启 DSH Desktop 才生效。**

## 怎么确认它真的在工作

鼠标移到刘海上，面板应展开并显示当前对话的状态。

如果**什么都没出现**，看这份文件（app 每次启动都会重写它）：

```bash
cat ~/Library/Application\ Support/DSHNotch/last-launch.txt
```

正常长这样：

```text
DSH Notch 启动诊断
时间: 2026-10-04 14:23:47 +0000
屏幕: 屏幕 1280×832@2x | 刘海 156×28 @(x=562,y=804) | 折叠 208×50 | 展开 440×176（单会话）/ 最高 235（6 会话）
DSH 运行中: true
辅助功能权限: 未授权 → 点对话只置前 DSH + 复制标题
跳转深链: dsh://open
zstd 解压工具: /Applications/DSHNotch.app/Contents/Resources/zstdlite
会话候选: 1 个
```

看三个字段就能定位绝大多数问题：

| 字段 | 不正常时说明什么 |
| :--- | :--- |
| `zstd 解压工具` | 显示「未找到」→ 包不完整，重新下载 |
| `会话候选` | `0 个` → DSH 还没跑过对话，或 `~/.dsh/sessions` 是空的 |
| `DSH 运行中` | `false` → DSH 没启动；它只会在 DSH 开着时常驻 |

## 没有刘海的 Mac 会怎样

能用，但形态不一样。据实说明：

| 机器 | 折叠态 | 说明 |
| :--- | :--- | :--- |
| 带刘海的 MacBook | 208×50 的刘海延伸条 | 设计目标 |
| 无刘海（M1 Air / iMac 等） | 320×26 的顶部悬浮条 | 没有挖孔，就是一条贴顶的悬浮条 |
| 合盖只接外接屏 | 同上，跟随外接屏 | 它优先找带刘海的那块屏，没有就用主屏 |

无刘海时的布局是**离线渲染验证过的**：

```bash
.build/DSHNotch --render-preview-nonotch .build/preview-nonotch
```

但没有真机上手过。已知一点：悬浮条贴在最顶上，可能压住菜单栏左侧的文字 ——
它本身不接收鼠标事件（除非指针真在它上面），菜单还能点，只是视觉上有重叠。

## 卸载

```bash
osascript -e 'quit app "DSHNotch"'                  # 或点菜单栏图标 → 退出
rm -rf /Applications/DSHNotch.app
rm -rf ~/Library/Application\ Support/DSHNotch      # 启动诊断文件
```

如果开过「开机自动启动」，它写的是一个用户级 LaunchAgent，一并删掉：

```bash
rm -f ~/Library/LaunchAgents/*dsh-notch*.plist
```

## 常见问题

| 现象 | 原因 / 处理 |
| :--- | :--- |
| 「已损坏，无法打开」 | 没放行隔离标记 → `xattr -dr com.apple.quarantine /Applications/DSHNotch.app` |
| 双击后没动静 | 用**右键 → 打开**；再不行看诊断文件 |
| 菜单栏没出现图标 | 退出重开一次 app |
| 面板一片空白、一直「待命」 | 查诊断文件里的 `zstd 解压工具` 与 `会话候选` |
| 面板跑到外接屏上去了 | 它优先跟随带刘海的那块屏；都没有时跟主屏 |
| 点了对话只跳到 DSH、没自动搜索 | 需要「辅助功能」权限：菜单栏图标 → 授予辅助功能权限 |
| 合盖后没了 | 合盖时没刘海屏，它跟到主屏；若完全无外接屏则无处可画 |
