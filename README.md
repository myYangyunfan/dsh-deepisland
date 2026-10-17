# DeepSeek Harness 刘海灵动岛（VibeIsland）

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue.svg" alt="Platform">
  <img src="https://img.shields.io/badge/version-1.3.1-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/tests-336%20%2B%20311%20passing-brightgreen.svg" alt="Tests">
</p>

在 **macOS 屏幕顶端的物理刘海**（Windows 为屏幕顶端居中悬浮窗）实时显示 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）智能体的工作状态：思考中 / 执行工具 / 等你审批 / 多个子代理并行。**点一下就能跳到对应的对话。**

<p align="center">
  <img src="docs/screenshots/hud-multi.png" alt="多会话 HUD 展开态" width="680">
</p>

> 上图截自 Windows 端构建（`windows/`）。两端视觉同构 —— Windows 版样式按 `swift/UI/NotchContentView.swift` 逐条移植（纯黑底、状态色内发光带、同一套弹簧参数）。

---

## ✨ 功能特性

### 实时状态识别

从 DSH 会话文件（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）的事件流增量扫描，识别智能体当前在做什么：

| 状态 | 含义 | 光效 |
| :--- | :--- | :--- |
| 💭 思考中 | 正在分析规划（取深度思考 reasoning 的要点） | 蓝 |
| ⚡ 执行工具 | 正在跑哪个工具、动哪个文件 | 青 |
| ❓ 等待确认 | 工具调用待审批，脉冲提醒并自动展开 | 琥珀 |
| ✅ 已完成 | 任务完成 | 绿 |
| 💤 待命 | 空闲 | 灰 |

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="docs/screenshots/compact-thinking.png" alt="思考中" width="280"><br><sub>折叠态 · 思考中</sub></td>
      <td align="center"><img src="docs/screenshots/compact-tool.png" alt="执行工具" width="280"><br><sub>折叠态 · 执行工具</sub></td>
      <td align="center"><img src="docs/screenshots/compact-multi.png" alt="多会话" width="280"><br><sub>折叠态 · 多会话并行</sub></td>
    </tr>
  </table>
</p>

### 悬停展开 HUD

鼠标在岛上停留约 0.2 秒展开详情面板：当前动作、文件、待办进度、耗时 / 轮次 / 工具次数 / 输出 token / 上下文占用。移开 0.35 秒自动收起，也可以点一下钉住常驻。

<p align="center">
  <table>
    <tr>
      <td align="center"><img src="docs/screenshots/hud-thinking.png" alt="单会话 HUD" width="300"><br><sub>展开态 · 单会话详情</sub></td>
      <td align="center"><img src="docs/screenshots/hud-tool.png" alt="工具执行 HUD" width="300"><br><sub>展开态 · 工具执行</sub></td>
    </tr>
  </table>
</p>

### 多会话并行跟随

DSH 可同时开多个会话。折叠态显示最该关注的那个 + 会话数徽标；展开态每个对话各占一行，按「等人工确认 > 执行工具 > 思考 > 已完成 > 待命」排序，最多同时跟随 6 个。任一会话进入等待确认都会自动展开提醒。

### 一键跳转对话

点展开态里的某一行，DSH **直接切到那个会话** —— 不用搜、不用粘贴、不用按回车，也不需要辅助功能权限。DSH 在后台也会被拉到前台。原理见[架构](#-架构)。

### 双端支持

| 平台 | 形态 | 位置 |
| :--- | :--- | :--- |
| macOS | `DSHNotch.app`（Swift / NSPanel） | 屏幕顶端的物理刘海 |
| Windows | `DSHNotch.exe`（Electron 无边框置顶小窗 + 托盘） | 屏幕顶端居中 |

两端都是**系统级**的，切到任何 App 都可见。共享同一份配置协议 `client-config.json`、同一个本机跳转桥 `127.0.0.1:47311`、同一个数据源，设置面板两边通用。

---

## 📦 安装

### 方式一：DSH 插件安装（推荐）

插件是刘海的「控制面 + 通道」：提供设置面板、一键跳转桥、以及 app 的自动下载安装。

**1. 在 DSH 插件页输入地址安装**

打开 DSH Desktop → 插件管理 → 输入：

```text
git+https://github.com/myYangyunfan/dsh-deepisland.git
```

> ⚠️ **要完整地址，不能只写仓库名。** 写成 `myYangyunfan/dsh-deepisland` 会被当成 npm 包名去 registry 找，必然失败。

**2. 点「立即启用」**

装完 DSH 会弹对话框，上面有个「立即启用」按钮 —— 点它，就完成了。

> **为什么需要这一步？** 插件管理器的「安装」只跑 `pnpm add` 写 `dependencies`，不写 `dsh.profile.bundles`，而宿主按 `bundles` 顺序叠加载树 —— 不登记，插件压根不会被加载，且宿主毫无提示。「立即启用」调的正是补登记。
>
> <details>
> <summary>没看到按钮 / 点了没反应？两条等价的路（展开看）</summary>
>
> **A. 已有 app 的老用户**：点菜单栏图标 →「⚠️ 插件未启用 · 点此修复…」，按提示操作（自动备份、写完自证）。
>
> **B. 从仓库下载 zip**：解压后双击 `scripts/setup.command`，自动完成登记，不用填任何东西。
>
> 终端等价命令：
>
> ```bash
> node "$HOME/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island/scripts/register-bundle.mjs"
> ```
>
> 只想看状态不改：加 `--check`。
> </details>

**3. 重启 DeepSeek Harness**

退出应用再打开（不是关窗口）。插件加载后会自动下载安装 app（仅限缺失时，SHA256 校验通过才执行），几秒后刘海出现。

**验证装好了：**

```bash
curl -s http://127.0.0.1:47311/health
# 看到 "ok":true 且 "keys" 里有 notchEnabled 就对了
```

### 方式二：手动安装 app

不装插件也能用刘海，只是失去「一键跳转」与「自动安装」。

```bash
# macOS：编译 + 打包 + 安装并启动
cd swift && ./build.sh install

# Windows：从 Release 下载 zip，解压到 %LOCALAPPDATA%\Programs\DSHNotch
# （插件检测到 app 存在会跳过自动下载）
```

手动安装与故障排查详见 [`swift/INSTALL.md`](./swift/INSTALL.md) 与 [`windows/README.md`](./windows/README.md)。

---

## 🖱️ 使用

| 操作 | 效果 |
| :--- | :--- |
| 鼠标移到刘海（停留约 0.2 秒） | 展开 HUD 面板 |
| 鼠标移开（超过 0.35 秒） | 自动收起 |
| 点岛体 / 面板非对话区 | 钉住常驻展开，再点取消 |
| 点展开态里的某一行对话 | **直接跳到 DSH 里的那个会话**（DSH 在后台也会被拉到前台） |
| 状态变橙（等待人工确认） | 自动展开提醒 |
| 菜单栏波形图标（macOS）/ 托盘图标（Windows） | 开关刘海、悬停展开、空闲收起、开机自启、桥状态、打开配置目录、退出 |

设置改动**下一拍就生效**（app 每 250ms 查一次配置，靠 mtime + 大小判变化），不用重启任何东西。

---

## ⚙️ 配置

DSH 设置 → 🏝️ 灵动岛，或直接改 `client-config.json`（macOS 在 `~/Library/Application Support/DSHNotch/`，Windows 在 `%APPDATA%\DSHNotch\`）：

| 配置项 | 键名 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| 刘海开关 | `notchEnabled` | `true` | 物理刘海是否显示 |
| 一步跳转 | `jumpEnabled` | `true` | 关掉则退回「置前 + 复制标题 + ⌘K 粘贴」 |
| 空闲收起 | `hideWhenIdle` | `false` | 空闲一段时间后自动收起 |
| 呼吸光晕 | `glowEffect` | `true` | 思考与执行时的流光光晕动效 |
| 悬停展开 | `expandOnHover` | `true` | 悬停自动展开 HUD |
| 缩放比例 | `scale` | `1.0` | 灵动岛尺寸缩放（0.5 ~ 2.0） |
| 显示位置 | `placement` | `notch` | `notch`（顶端吸附）/ `floating`（居中悬浮）/ `top-right` |
| 平台风格 | `platformMode` | `auto` | `auto` / `macos`（黑晶刘海）/ `windows`（亚克力毛玻璃） |
| 子代理计数 | `showSubagentCount` | `true` | 并行子代理在岛体右侧显示徽标计数 |
| 跳转桥 | `bridgeEnabled` | `true` | 本机回环桥开关。桥挂了只影响跳转，刘海照常显示 |
| 桥端口 | `bridgePort` | `47311` | 被占用时自动向后顺延，实际端口写进 `bridge.json` |
| 自动装 app | `autoInstallApp` | `true` | 缺 app 时自动下载校验安装。**只装缺失的，不做升级** |
| 安装目录 | `appInstallDir` | `/Applications` | 不可写时自动退到 `~/Applications` |

不打开 DSH 也能改（排查用）：

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"notchEnabled":false}' http://127.0.0.1:47311/config
```

写接口有白名单（只接受已知键与类型）—— 这是本机回环上的 HTTP 端点，同机任何进程都能调，不校验就等于开了个任意写的口子。

---

## 🏗️ 架构

**插件是控制面 + 通道，刘海本身是独立 app。**

```text
DSH 设置面板 ──POST /config──▶ 插件服务端（lib/index.js）──▶ client-config.json
                                                                    │
                            DSHNotch.app（Swift / Electron）◀── 读同一份 ◀┘
                                                                    │
                              ~/.dsh/sessions/**/session.v4.jsonl.zstd（唯一数据源）
```

| 能力 | 由谁提供 |
| :--- | :--- |
| 设置面板（开关刘海 / 跳转 / 空闲收起） | 插件客户端（`lib/client.js`，纯 DOM 跨平台） |
| 点岛上的对话 → 打开对应会话 | 插件服务端（`lib/index.js`）的本机桥 |
| 缺 app 时自动下载安装（SHA256 校验） | 插件服务端（`lib/index.js`） |
| 刘海本体 | `DSHNotch.app`（macOS）/ `DSHNotch.exe`（Windows） |

<details>
<summary><b>跳转桥怎么搭的（展开看）</b></summary>

关键发现：**插件的渲染进程能打开会话，外部 app 不能。** 宿主 asar 里 `ctx.uiWorkspace.openSession(target)` 有 9 处真实调用。于是让插件服务端在回环上起一个小 HTTP 服务，两端各接一半：

```text
点击 island row ──POST /jump──▶ 插件服务端 127.0.0.1:47311（队列上限 32，45s 过期）
                                      ▲ 轮询 GET /next（500ms）
                    插件客户端 lib/client.js ── ctx.uiWorkspace.openSession(sessionId)
```

点击时先发 `dsh://open` 把 DSH 置前，再投桥切会话 —— 顺序有讲究：`openSession` 只换视图不管窗口焦点，DSH 在后台时若只投桥，会话切了但窗口还在后台，等于没点。

桥的暴露面极小：只监听 `127.0.0.1`、只服务同一用户、只传 `sessionId` 与标题、响应回显插件名防误认。桥坏了优雅降级为「置前 + 复制标题」，不影响刘海本身。
</details>

<details>
<summary><b>状态判定怎么做的（展开看）</b></summary>

双路判定，事件流优先、投影兜底：

1. **事件流**（`ActivityCursor`）：逐帧增量扫描 `session.v4.jsonl.zstd`。会话文件是按事件批次追加的**多帧独立 zstd 流**（魔数 `0x28 0xB5 0x2F 0xFD`），需拼接解压，单次解压只读首帧会漏事件。
2. **投影推断**（`inferFromProjection`）：事件流不可读时，从会话投影 + 文件 mtime 启发式兜底。
3. **回合结束防误唤醒**（`sawTurnEnd`）：回合转 idle 后，投影残留的未完成步骤不会把岛再次点亮。

性能：按会话 id 保存扫描游标（容量上限 64，超出回收），只增量处理新事件 —— 实测 64000 条事件时每轮开销 0.0004ms，长会话下轮询占用主线程不到 0.1%。
</details>

---

## 🧪 开发

```text
deepisland/
├── lib/                     # DSH 插件（服务端 index.js + 客户端 client.js）
├── scripts/                 # register-bundle.mjs 等登记/兜底脚本
├── swift/                   # macOS 端：Swift / NSPanel / zstdlite
├── windows/                 # Windows 端：Electron 无边框置顶窗 + 托盘
├── test/                    # 零依赖测试套件（Node 断言 + 真实浏览器渲染验证）
└── docs/screenshots/        # README 截图（npm run shots 重新生成）
```

```bash
# 插件侧测试（336 项：注册链路、容错、事件扫描、子代理、跳转桥两端、配置持久化）
node test/run.mjs all
node test/run.mjs cfg         # 配置读写离线语义
node test/run.mjs installdl   # 自动安装（T5 需联网真下载 Release 验 SHA256）

# Windows 端测试（311 项：状态判定、zstd 多帧、桥 IPC、安装决策、UI 冒烟）
cd windows && npm test

# macOS 端自检（交互 / 投影 / 多会话 / 跳转 四套）
cd swift && ./build.sh all-tests

# 重新生成 README 截图（驱动生产渲染层，离屏 2x 高清）
cd windows && npm run shots
```

两套测试均不依赖任何 npm 包。Node 套件通过桩 `window.__ModuleLoader__` / `document` 拉起插件 factory 并灌入真实事件流；渲染套件用 CDP 驱动本机 Edge/Chrome，加载从 `lib/client.js` 抽取的真实 CSS，断言实际生效的计算样式。

---

## ❓ FAQ

<details>
<summary><b>装完了但毫无反应？</b></summary>

九成是没登记进 `dsh.profile.bundles`。见安装方式一的第 2 步 —— 点「立即启用」或跑 `scripts/setup.command`，然后**重启 DSH**（关窗口不算）。

排查时确认桥的 pid 有没有变：改了插件代码但没重启宿主时，桥还是老进程，新端点会返回 `not found` —— 这是「代码对但没生效」的常见误判。
</details>

<details>
<summary><b>下载安装失败 / 网络不通？</b></summary>

插件会自己读 `HTTPS_PROXY` / `HTTP_PROXY`（Node 的 `node:https` 默认不读，只有 curl 会），直连失败时自动改走代理隧道。诊断日志写清了是直连失败还是代理失败：

```text
~/Library/Application Support/DSHNotch/plugin-diagnose.log
```

想跳过下载自己装 app：`cd swift && ./build.sh install`，装好后插件检测到 app 存在就跳过下载。
</details>

<details>
<summary><b>Windows 端有什么限制？</b></summary>

- **置前 DSH** 降级为「复制标题 + 提示 Ctrl+K」：`dsh://open` 在 Windows 上是否注册过尚未实测，且 Windows 没有按键注入能力
- 安装包体积大（111 MB / zip 153 MB）：Electron ≥ 42 是硬门槛 —— 会话文件是 zstd 压缩的，解码要靠 Node 内置 `zlib.zstdDecompressSync`，Electron 33（Node 20）没有这个函数
- 其余能力（状态识别、多会话、HUD、桥、自动安装）与 macOS 端同构，Windows 11 真机跑通过
</details>

<details>
<summary><b>会自动升级 / 覆盖我已装的东西吗？</b></summary>

不会。自动安装**只装缺失的，不做升级**：已装 → 一个字节都不动；装了但残缺 → 报 `broken` 让你自己处理，绝不悄悄替换。升级按 <a href="./swift/INSTALL.md">swift/INSTALL.md</a> 手动来。
</details>

---

## 📄 License

[MIT](./LICENSE) © 2025 Yangyunfan
