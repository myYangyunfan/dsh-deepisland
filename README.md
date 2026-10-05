# DeepSeek Harness 智能体刘海灵动岛 (DSH VibeIsland)

兼容 **macOS（硬件物理刘海屏）** 与 **Windows（Fluent 亚克力药丸）** 的 DeepSeek Harness 全局智能体工作状态灵动岛插件。

无需任何额外二进制环境，直接以 DSH 官方插件标准导入，即装即用。

---

## ✨ 核心特性

1. **双平台自适应视觉拟态**
   - **macOS 刘海模式**：默认吸附于屏幕或窗口正顶端（`top: 0`），双侧微倒角黑晶贴合，完美融入 MacBook 物理刘海。
   - **Windows Fluent 模式**：采用 Win 11 设计语言，半透明深色亚克力毛玻璃质感（`backdrop-filter: blur(24px)`），全圆角悬浮药丸形态。
   - **右上角浮标模式**：针对宽屏或分屏场景，微缩于窗口右上角，不遮挡任何正文。

2. **毫秒级内核状态感知（会话游标增量事件流）**
   - **💭 思考中 (Thinking)**：DeepSeek 标志性幻彩蓝紫流光（Aura Pulse），实时显示当前分析要点。
   - **⚡ 工具执行中 (Tool Execution)**：青绿色光晕，实时提取当前调用的工具名（`bash`、`read`、`edit`、`write`、`glob`、`grep` 等）以及正在执行的命令或操作的文件名。
   - **❓ 待审批/提问 (Action Required)**：琥珀金跳动脉冲，提示等待人工确认。
   - **👥 子代理并行 (Subagents Active)**：从会话谱系目录（`subagentsByParent`）读取运行中的子代理，在胶囊右侧显示 `👥 N` 徽章，展开 HUD 显示并行数量。
   - **⏱️ 实时计时与指标**：动态秒级耗时计数器、本回合工具调用次数统计。

3. **双态平滑交互（Pill ↔ HUD）**
   - **折叠态 (Compact Pill)**：宽度仅 200px ~ 250px，极简呈现核心状态指示灯、状态名、耗时与工具 Badge。
   - **展开态 (Expanded HUD)**：鼠标悬停或点击立即以 Apple 弹性阻尼动画向下展开为 440px 宽的极客控制台，显示完整命令代码块、耗时和工具流水。

4. **无缝集成 DSH 设置与操作栏**
   - 自动在 DSH 设置页（`settings.section`）注册「🏝️ 灵动岛」卡片，支持图形化切换形态、光晕动效与位置。
   - 自动在会话顶部栏（`header.utilities`）注册一键快捷开关按钮。

---

## 🖥️ 两套方案：窗口内插件 vs 系统级刘海

| 方案 | 位置 | 常驻性 | 目录 |
| :--- | :--- | :--- | :--- |
| **DSH 插件**（本 README 主角） | DSH 窗口内 DOM 覆盖层 | 跟随 DSH 窗口 | `lib/` |
| **DSH Notch**（原生 App） | Mac 物理刘海（NSPanel） | 系统级，切到任何 App 都可见 | [`swift/`](./swift/README.md) |

两套同时启用会在 DSH 窗口内出现「应用内中部岛 + 真实刘海岛」两个状态栏，视觉冗余。
**只想要系统级那一个时，把插件从 profile 的 bundle 列表里摘掉即可**：

```bash
# 编辑 ~/.dsh/profiles/desktop/package.json，从 dsh.profile.bundles 移除该插件
#   "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
# 依赖项可以不删（保留安装状态，随时能在插件管理里重新启用），重启 DSH 生效
```

### DSH Notch 怎么用（系统级那个）

菜单栏出现波形图标即已就绪，刘海正中就是浮层：

| 操作 | 结果 |
| :--- | :--- |
| 鼠标移到刘海上（停留约 0.2 秒） | 展开成面板（440 宽；高 176，多会话时按行数长到 235） |
| 鼠标移开（超过 0.35 秒） | 自动收起 |
| 在岛上点一下（折叠态，或展开态的非对话区） | 钉住常驻展开／再点一下取消 |
| 展开态点某一行对话（单会话时点中间详情块） | **直接跳到 DSH 里的那个对话**（装了插件时；否则降级为置前 + 复制标题）。DSH 在后台也会被拉到前台 |
| 状态变橙（等待人工确认） | 自动展开提醒 |
| 菜单栏波形图标 | 使用说明 / 钉住 / 悬停展开开关 / 空闲自动收起 / 开机自启 / 授予辅助功能权限（自动定位对话） / 定位会话文件 / 导出预览图 / 退出 |

**同时跟随最多 6 个对话。** DSH 并行开多个会话时（本机实测同一分钟有两个在写文件），
折叠态显示最该关注的那个 + 会话数徽标 `⚏ 2/3`，展开态每个对话各占一行，
按「等人工确认 > 执行工具 > 思考 > 已完成 > 待命」排序——任一会话等人确认都会自动展开。

---

## 🔗 点一下对话就跳过去：插件桥

点展开态里的某一行，DSH 会**直接切到那个会话**——不用搜、不用粘贴、不用按回车，
也**不需要辅助功能权限**。

### 为什么以前做不到

DSH 对外只注册了一条深链 `dsh://open`，作用仅是把主窗口拉到前台：

```js
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
});
```

没有「打开第 N 个对话」的对外接口。所以上一版只能绕：置前 DSH + 把标题写进剪贴板，
让你 `⌘K` 再 `⌘V`，有辅助功能权限时替你按完 ⌘K 和粘贴。

### 桥是怎么搭起来的

关键发现：**插件的渲染进程能打开会话，外部 app 不能。**
宿主 asar 里 `ctx.uiWorkspace.openSession(target)` 有 9 处真实调用，官方注释写着
「target 可以是已知的 Session id」。于是让插件的服务端半边在回环上起一个小 HTTP 服务，
两端各接一半：

```
  点击 island row
        │
        ▼
  ┌─────────────────────────┐         ┌──────────────────────────────────┐
  │ DSHNotch.app (Swift)    │  POST   │ DSH 插件服务端  lib/index.js      │
  │ SessionJump.postToBridge│ ──────► │ 127.0.0.1:47311  /jump          │
  └─────────────────────────┘         │   队列（上限 32，45s 过期）      │
        │                            └──────────────────────────────────┘
        │ 读 bridge.json 拿端口                  ▲ 轮询 GET /next（500ms）
        │                                      │
        │                            ┌──────────────────────────────────┐
        └──────────────────────────  │ DSH 插件客户端  lib/client.js    │
                                     │ ctx.get("uiWorkspace")           │
                                     │   .openSession(sessionId)        │
                                     └──────────────────────────────────┘
```

会话 id 从会话文件里取（`{"type":"session","id":"session-<uuid>"}`，与目录名一致），
正是 `openSession` 要的形态。

### 为什么渲染进程能连本机 HTTP

逐条查过宿主，不是想当然：

- **主窗口没有 CSP。** asar 里 10 处 `Content-Security-Policy` 分属 API 文件服务
  （`sandbox; default-src 'none'`）、HTML 预览消毒、更新/欢迎/强制更新弹窗，
  没有一条管到 `dsh-app://app` 主界面。
- Electron 启动参数含 `--disable-features=PrivateNetworkAccessChecks,
  LocalNetworkAccessChecks`，本机网络访问的额外预检被关掉了。
- 协议注册为 `--cors-schemes=dsh-app`，跨源走 CORS，所以桥的响应都带
  `Access-Control-Allow-Origin: *`。

### DSH 在后台也能置前

点击时**先发 `dsh://open` 置前，再投桥切会话**。顺序是有讲究的：

`openSession` 只换视图、**不管窗口焦点** —— 宿主文档原话是
*"synchronously replaces the owned `mainView` reference"*。
DSH 在后台时若只投桥，会话确实切了，但窗口还在后台，用户看不见，等于没点。
`dsh://open` 是唯一能把窗口捞到前台的入口（它内部调 `focusPrimaryWindow()`）。

反过来说，置前放在前面也更自然：窗口先到前台，用户看到的已经是一个切好的会话，
而不是「切完了再被拉过来」。

### 为什么设置里的开关以前「点不动」

如果你曾经看到「启用灵动岛状态栏」点了没反应，那不是 UI 坏了，是**写入通道断了**。

设置卡片原本只有一条写配置的路：`scope.update(...)`。而 `scope` 来自宿主的
`configForms` 服务，它由 `@deepseek-ai/dsh-client-ui-settings` 提供 ——
**用户可以在自己 profile 的 `cordis.patch.yml` 里把它关掉**：

```yaml
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
```

那个 bundle 带首次引导流程，很多人会关掉（本机 desktop profile 就是）。
一旦关掉，链条是这样断的：

1. `bindConfigScope` 拿不到 `configForms` → 返回 `null`
2. `updateField` 写的是 `if (scope && …) scope.update(…)` → **静默什么都不做**
3. checkbox 是受控组件（`checked: config.enabled`），状态没变
4. → **勾号不弹、岛不消失，也没有任何报错**

现在改成三路并行，任何一路通都生效：

| 通道 | 生效范围 | 说明 |
| :--- | :--- | :--- |
| 宿主 `configForms` | 当前 profile | 权威源，能用就用 |
| **桥上的 `/config`** | 跨重启、DSH 升级也不丢 | 服务端落盘到 `client-config.json` |
| `localStorage` | 本次窗口 | 桥不在时的兜底 |

并且**每次改动都会在面板上显示「已保存」或失败原因** —— 不再静默失败。
读配置时本地值是基线、宿主值覆盖它，所以宿主服务缺席时用户上次的选择依然生效。

落盘走的是**白名单**（只接受已知键与类型）+ **原子替换**，因为这是本机回环上的
HTTP 端点，同机任何进程都能调 —— 不校验就等于开了个任意写的口子。

自查：

```bash
curl -s http://127.0.0.1:47311/config
cat ~/Library/Application\ Support/DSHNotch/client-config.json
```

> 排查时踩的一个坑：日志目录里若只有旧文件，别据此断言「插件没激活」。
> 要看**桥的 pid 有没有变** —— 改了插件代码但没重启宿主时，桥还是老进程，
> 新加的端点会返回 `not found`。这是「代码对但没生效」的常见误判，
> 我自己就差点据此得出错误结论。

### 点击热区的分工

| 点哪里 | 折叠态 | 展开态 |
| :--- | :--- | :--- |
| 对话详情块 / 某一行的对话 | 钉住 | **跳到该对话** |
| 面板其余区域（标题、待办、统计、模型行） | 钉住 | 钉住 / 取消钉住 |

**单会话面板没有做成「整块可点」** —— 那会抢掉外层「点一下 = 钉住/取消」的手势：
SwiftUI 里子视图手势优先于父视图，一旦整块接管，展开态就再也钉不住了
（本项目真踩过，`--self-test` 当场报「展开态下点击 → 仍应钉住」失败）。
折叠态本来没有对话可跳，点一下必须是钉住；两者要共存，
「跳转」就必须有明确的热区。

多会话时底部统计行也能点 —— 它显示的就是主会话（排序第一）的指标，不歧义。

### 桥坏了会怎样

**降级，不影响灵动岛。** 桥只在 `127.0.0.1` 上、只服务同一个用户、只传 sessionId。
用户没装插件、DSH 没开、插件版本旧 —— 全部退回「置前 + 复制标题 +（有权限则）⌘K ⌘V」，
和在装桥之前完全一样。`/jump` 与 `/next` 的响应都回显插件名，
免得 47311 附近有别的服务时被误认。

想关掉：设置里 `bridgeEnabled: false`。

### 🔴 两条不能碰的纪律

1. **`uiWorkspace` 绝不能写进 `exports.inject`。** Cordis 会为缺失的服务无限等待，
   插件永久停在 `pending (waiting for service: uiWorkspace)`，整个灵动岛直接消失。
   本项目早前把不存在的 `settingsScope` 写进 inject 就踩过这个坑
   （证据在 `~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`）。
   现在一律用 `ctx.get("uiWorkspace")` 运行时探测，取不到就安静跳过这一跳。
2. **`/next` 取队列前必须先 prune。** 少这一步，一条十分钟前的点击会在你下次
   打开 DSH 时把你劫持到某个会话。队列项 45s 过期。

---

## 📥 只装插件就够了（但要登记一次）

装了插件，**macOS 上的 DSHNotch.app 会自己装好**。前提是插件**已被加载**，
而这一步不是装完就自动的 —— 见下面的
「[🔴 还差一步：把插件登记进 dsh.profile.bundles](#-还差一步把插件登记进-dshprofilebundles)」。

插件加载后，`apply()` 会做两件事：

### 一、自动把 macOS app 装好

1. 插件服务端检查 `/Applications/DSHNotch.app`
   （判据是主程序**和**自带的 zstdlite 都在——只看 `.app` 目录是不够的，
   早期就出过「包在但读不到任何会话」的事故）
2. 缺了就从本仓库 Release 下载 `DSHNotch-<版本>-<架构>.zip`
   （直连优先，`gh-proxy.com` 镜像兜底）
3. **校验 SHA256**，对不上就中止安装
4. `ditto` 解压（保可执行位与代码签名，`unzip` 会丢）、清 quarantine
5. 装进 `/Applications`（不可写则退 `~/Applications`）并启动

#### 请知情：它会下载并运行一个外部程序

这是自动安装做不到完全无感的地方，明说在这：

- 只从**本仓库的 Release** 下载，且**必须 SHA256 对得上**才会执行
- **绝不覆盖已安装的版本。** 已装 → 一个字节都不动；装了但残缺 → 报 `broken` 并
  让你自己处理，绝不悄悄替换
- 只装缺失的，不做升级。**升级仍按 [`swift/INSTALL.md`](./swift/INSTALL.md) 手动来**
- 每一步都打到 DSH 日志（搜 `[dsh-vibe-island]`）

关掉：设置里 `autoInstallApp: false`，然后按 `swift/INSTALL.md` 手动装。

### 二、起本机跳转桥

点岛上的对话直接切到该会话，见上面的
「[🔗 点一下对话就跳过去：插件桥](#-点一下对话就跳过去插件桥)」。

---

## 🧪 DSH Notch 怎么用（系统级那个）

菜单栏出现波形图标即已就绪，刘海正中就是浮层：

| 操作 | 结果 |
| :--- | :--- |
| 鼠标移到刘海上（停留约 0.2 秒） | 展开成面板（440 宽；高 176，多会话时按行数长到 235） |
| 鼠标移开（超过 0.35 秒） | 自动收起 |
| 在岛上点一下（折叠态，或展开态的非对话区） | 钉住常驻展开／再点一下取消 |
| 展开态点某一行对话（单会话时点中间正文块） | 跳到 DSH 里的那个对话：DSH 置前 + 该会话标题进剪贴板 |
| 状态变橙（等待人工确认） | 自动展开提醒 |
| 菜单栏波形图标 | 使用说明 / 钉住 / 悬停展开开关 / 空闲自动收起 / 开机自启 / 授予辅助功能权限（自动定位对话） / 定位会话文件 / 导出预览图 / 退出 |

**同时跟随最多 6 个对话。** DSH 并行开多个会话时（本机实测同一分钟有两个在写文件），
折叠态显示最该关注的那个 + 会话数徽标 `⚏ 2/3`，展开态每个对话各占一行，
按「等人工确认 > 执行工具 > 思考 > 已完成 > 待命」排序——任一会话等人确认都会自动展开。

**点一下对话就跳过去。** 见上面的「[🔗 点一下对话就跳过去：插件桥](#-点一下对话就跳过去插件桥)」。

安装（**别人要装到自己机器上，看 [`swift/INSTALL.md`](./swift/INSTALL.md)** ——
那里写了「下载现成包」和「从源码编译」两条路，含 Gatekeeper 放行；
**装了插件的话 app 会自动装好**，一般不用手动走）：

```bash
cd swift
./build.sh install     # 编译 + 打包 + 装到 /Applications 并启动
./build.sh package     # 产出可分发 zip（.build/dist/，附 SHA256SUMS.txt）
./build.sh all-tests   # 交互 / 投影 / 多会话 / 跳转 四套自检
./build.sh preview     # 离屏渲染形状预览图（校验形状读起来像不像刘海延伸）
```

详见 [`swift/README.md`](./swift/README.md) 与 [`swift/INSTALL.md`](./swift/INSTALL.md)。

---

## 📁 插件工程结构

```text
deepisland/
├── dsh.plugin.json          # 插件核心元数据声明（id, version, main）
├── package.json             # 客户端注入与宿主共享模块声明
├── cordis.patch.yml         # DSH Cordis 插件栈自动挂载
├── lib/
│   ├── index.js             # 服务端 Cordis 插件：配置注册 + 本机跳转桥 + app 自动安装
│   └── client.js            # 客户端核心 Bundle（UI、CSS、事件扫描、桥客户端、设置项）
├── test/                    # 零依赖测试套件（Node 断言 + 真实浏览器渲染验证）
└── README.md                # 插件使用与安装文档
```

### 测试

```bash
node test/run.mjs all         # 235 项 Node 断言：状态机、挂载、游标性能、子代理、跳转桥两端
node test/run.mjs installdl    # 18 项：要联网，真下载 Release 并验 SHA256（约 30s，不进 all）
node test/render-verify.mjs   # 33 项真实浏览器断言：计算样式、尺寸、双平台皮肤（产物在 test/.tmp/）
```

各套件与职责：

| 套件 | 断言 | 覆盖 |
| :--- | ---: | :--- |
| `contract` | 36 | 宿主契约（配置命名空间、inject 纪律等） |
| `parse` / `apply` / `subagent` | 101 | 事件流解析、挂载、子代理聚合 |
| `bridge` | 60 | **服务端桥**：起停、CORS、队列语义、TTL、端口顺延、app 完整性判定 |
| `bridgeclient` | 27 | **客户端桥**：端到端 `POST /jump → 轮询 → openSession`、降级、停用纪律 |
| `installdl` | 18 | **自动安装**：不覆盖已装、残缺包不替换、真下载 + 校验 + 篡改检测（需联网） |

跨语言那一段（Swift `URLSession` → Node 桥）由 `./swift/.build/DSHNotch --self-test-jump`
在桥跑着时验证，会打印「投递调用正常返回（通=true）」。

两套测试均不依赖任何 npm 包。Node 套件通过桩 `window.__ModuleLoader__` / `document` 拉起插件 factory 并灌入真实事件流；渲染套件用 CDP 驱动本机 Edge/Chrome，加载从 `lib/client.js` 抽取的真实 CSS，断言实际生效的计算样式。

> 桥的两套测试用 `node:http` 而不是 `fetch` 发请求：作者本机的执行沙箱允许 listen 回环，
> 但拦截 `fetch` 到 `127.0.0.1`。这**只影响测试环境**——桥的客户端在 DSH 渲染进程里用的是浏览器 fetch。

---

## 🚀 安装与导入方式（Direct Import）

本插件遵循 DeepSeek Harness 标准插件规范，可通过以下两种方式直接导入：

### 方式一：复制到 DSH 外部插件目录（推荐）

1. 将当前 `deepisland` 目录复制或重命名为 `dsh-vibe-island`：
   ```bash
   cp -r /path/to/deepisland ~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island
   # 或直接放入 web profile 插件库：
   cp -r /path/to/deepisland ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-vibe-island
   ```

2. 刷新 DeepSeek Harness 界面（或访问 `http://127.0.0.1:19387`），模块加载器将自动加载灵动岛。

### 方式二：通过 DSH 插件管理器安装

DSH Desktop 内置插件管理器（`@deepseek-ai/dsh-client-ui-plugin-manager`，随 0.2.0-rc.2 提供），
安装入口是**输入「包名或地址」**（pnpm 接受的写法都行），不是选择压缩包：

```text
git+https://github.com/myYangyunfan/dsh-deepisland.git
```

装完重启 DSH 生效。实测的三条限制：

- **一次只能装一个** —— 对话框一次跑一条 pnpm 命令，第二个 spec 要等前一个完成
- **没有版本选择器** —— 不列注册表版本、不提供升级；profile 装的插件**升级＝卸载后重装**
- **不透明失败** —— 出错的行只显示失败，具体原因在 Host 日志里

> 装到哪个 profile 要看 DSH 实际在跑哪个：插件宿主进程的启动参数里第 4 段就是
> profile 路径（`ps -ax | grep dsh-desktop-host`）。本机是 `desktop`。

### 🔴 还差一步：把插件登记进 `dsh.profile.bundles`

**插件管理器的「安装」只做了一半。** 光装完不生效 —— 这是个真坑，
而且宿主**一点提示都没有**：插件管理器里照样显示「已安装」，功能毫无反应。

宿主内置文档原文：

> Bundles are npm packages whose manifest declares `"dsh": { "bundle": { "patch":
> "./cordis.patch.yml" } }`; the tree is composed by applying each bundle's patch
> lists in **`dsh.profile.bundles` order** over an empty entry list, then the
> profile's own patches.

而插件管理器的实现（asar 内置文档）是：

> 插件管理器跑 **`pnpm add`**

`pnpm add` 只写 `dependencies`，**不碰 `dsh.profile.bundles`**。这俩是独立字段
（`initProfile` 里 `dependencies: {}` 和 `bundles: [...bundles]` 各自初始化，
无任何自动合并）。所以装完插件，它在 `dependencies` 里躺着，却不在 `bundles` 里 ——
**树按 `bundles` 顺序叠，它压根不会被加载。**

#### 这是宿主 UI 路径的实现缺口，不是配置问题

追到源码了。宿主里唯一会写 `bundles` 的函数是 `reconcileProfilePlugins`
（内部会调 `writeProfileBundles`），而在整个 asar 里它只出现 **2 次**：
一次定义、一次在 export 列表里 —— **插件管理器的 `installBundle` 路径压根没调用它**。

而官方 CLI 走的是另一条自己实现的代码（`reconcile` + `saveManifest`），**会**写。
所以同一件事，CLI 能做、插件页做不到 —— 差的是代码路径，不是配置。

还有个细节值得记（它也解释了为什么直接 add 没用）：

```js
for (const name of dependencies) {
  if (beforeDeps.has(name)) continue;   // 只处理「本次新增」的依赖
  …
  bundles.push(name);
}
```

**同步只覆盖「本次新增」的依赖。** 对一个「已在 dependencies、但不在 bundles」的插件
直接 `add`，pnpm 会答 `Already up to date`，同步那一步根本不执行。
所以 `setup.command` 走的是官方完整 cycle：`remove` → `add`。

> 顺带更正另一处：宿主确实有 `reportSkippedBundles` 会往 stderr 打印跳过原因（实测有输出），
> 但它只列**「在 bundles 里、却加载失败」**的条目。本插件是**压根不在 bundles 里**，
> 连「被跳过」都算不上 → 不在跳过列表、不影响别的 bundle、**一点提示都没有**。

#### 怎么补这一步

**双击一个文件就行**（脚本会自己找 profile、自己备份、出错会解释）：

```text
scripts/setup.command
```

从 GitHub 下载 zip 解压后双击它，或从仓库里双击。跑完**重启 DSH Desktop** 即可。

<details>
<summary>或者在终端里跑（等价，二选一）</summary>

```bash
# 你手上没有仓库也行 —— 脚本随插件装好了，路径是现成的：
node "$HOME/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island/scripts/register-bundle.mjs"

# 只想看状态不改：
node "$HOME/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island/scripts/register-bundle.mjs" --check

# 摘掉（依赖保留）
node "$HOME/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island/scripts/register-bundle.mjs" --remove
```

已有仓库的话也可以 `node scripts/register-bundle.mjs`。
profile 名会从 DSH 宿主进程的命令行里自动读出来，不用手填。
</details>

#### 试过让 pnpm 自动登记，行不通（实测记录）

免得后人再试一遍。**pnpm 确实会为 git 依赖跑 `prepare` 脚本**（实测会执行），
看起来像是能自动登记的正路，但有两个各自致命的坑：

1. **默认被供应链安全挡住**。pnpm 11 要求先把它加进 `allowBuilds` 才跑：

   ```text
   ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED: … is not in the "allowBuilds" allowlist
   ```

   而白名单要写**精确到 commit hash** 的 spec
   （`"@作者/包@git+…#<40位hash>": true`）—— 意味着每装一个版本、每升级一次，
   用户都得手动改一次 `pnpm-workspace.yaml`。比双击一个文件更麻烦。

2. **就算放行了也会被覆盖**。pnpm 的顺序是
   **先跑 git 依赖的 `prepare` → 然后才写 profile 的 `package.json`**。
   实测 `prepare` 脚本自报「成功登记」，但它写进 manifest 的那一项
   被 pnpm 随后的写入盖掉了，bundles 里根本没有。

两条叠起来这条路彻底没戏（但**官方 CLI 那条是通的**，见上 ——
它不依赖 `prepare`，而是在 pnpm 跑完之后自己写 manifest）。

宿主侧没有别的钩子：
`normalizeShippedProfile` 只在 profile 仍是出厂默认组合时重置 bundles（与装新插件无关）；
`dsh --profile desktop …` 被 Electron 独占，CLI 进不去这个 profile。

**结论：这一步省不掉，只能给用户一个一键入口。**

它也是**不能由插件自己搞定**的：挂载发生在**读 manifest 之前**，
bundle 没进列表 → 它的 `apply()` 根本不会被调用 → 也就没有机会去注册桥、
去装 app。鸡生蛋，只能由 profile 配置解开。

> 顺带说明：宿主里 `dsh.plugin.json` **根本不被读**（asar 里出现 0 次），
> 那是给人看的说明文件；`engines` 也不参与跳过判断。
> bundle 唯一会被跳过的原因是 `peerDependencies` 里名字以
> `@deepseek-ai/dsh-` 开头的包不满足 semver —— 本插件这些都写 `*`，
> 任意宿主版本都通过，不会成为跳过原因。

**改完必须重启 DSH Desktop 才生效。** 之后确认：

```bash
node "$HOME/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island/scripts/register-bundle.mjs" --check
#   三项应全绿
cat ~/Library/Application\ Support/DSHNotch/bridge.json   # 桥起来了会出现
```

### 装完就有的东西

重启 DSH 之后，**不需要再装别的东西**：

| 能力 | 由谁提供 |
| :--- | :--- |
| 窗口内灵动岛 | 插件客户端（`lib/client.js`） |
| 点对话直接跳转 + 自动装 macOS app | 插件服务端（`lib/index.js`） |

想让岛显示在**物理刘海**上而不是 DSH 窗口里，再看下一节装原生 app
（不装插件的话，app 需要你手动装一次，见 [`swift/INSTALL.md`](./swift/INSTALL.md)）。

---

## ⚙️ 配置说明

在 DeepSeek Harness 设置中，可自定义以下属性：

| 配置项 | 键名 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| **主开关** | `enabled` | `true` | 是否启用屏幕顶部灵动岛状态栏 |
| **显示位置** | `placement` | `notch` | `notch`（顶端吸附） / `floating`（居中悬浮） / `top-right`（右上角） |
| **平台风格** | `platformMode` | `auto` | `auto`（系统自适应） / `macos`（黑晶刘海） / `windows`（亚克力毛玻璃） |
| **呼吸光晕** | `glowEffect` | `true` | 是否在 Agent 思考与执行时开启流光光晕动效 |
| **悬停展开** | `expandOnHover` | `true` | 鼠标悬停在胶囊上时自动展开 HUD 控制台 |
| **缩放比例** | `scale` | `1.0` | 灵动岛尺寸缩放（范围 0.8 ~ 1.3） |
| **跳转桥** | `bridgeEnabled` | `true` | 点岛上的对话直接切到该会话。关掉则退回「置前 + 复制标题 + ⌘K 粘贴」 |
| **桥端口** | `bridgePort` | `47311` | 本机回环端口。被占用时自动向后顺延，实际端口写进 `bridge.json` |
| **自动装 app** | `autoInstallApp` | `true` | macOS 上缺 `DSHNotch.app` 时自动下载校验并安装。**只装缺失的，不做升级** |
| **安装目录** | `appInstallDir` | `/Applications` | 不可写时自动退到 `~/Applications` |
| **子代理计数** | `showSubagentCount` | `true` | 有并行子代理时在岛体右侧显示微章计数 |

配置写在 profile 的 `cordis.patch.yml` 里，形如：

```yaml
- id: vibe-island
  name: '@dsh-external/dsh-vibe-island'
  config:
    bridgeEnabled: true
    autoInstallApp: false   # 不想让插件自动装 app 就关掉
```

---

## 🛡️ 架构与性能保障

- **零外部运行时依赖**：直接复用宿主环境已注入的 React 18 与微内核总线，体积仅数十 KB。
- **只追加扫描缓存**：按会话 id 保存事件流扫描游标（容量上限 64，超出自动回收），只增量处理最新发生的事件。解析开销与历史长度无关——实测 64000 条事件时每轮仅 0.0004ms，长会话下轮询占用主线程不到 0.1%。
- **子代理零额外数据通道**：内核把子代理实现为独立会话，插件只读客户端已有的会话谱系快照，不新增任何后端请求。
- **沙箱隔离样式**：所有 CSS 类名带有专用命名空间（`vibe-island-*`），不会对 DSH 主题样式产生冲突或污染。
- **插件加载永不被打崩**：服务端 `apply()` 里注册配置、起桥、装 app 三件事各自独立 try/catch，
  全部失败也只记一行日志。配置服务缺失、`register` 抛重复注册、运行环境没有 `node:http`
  都有对应用例（见 `test-bridge.mjs` T8）。
- **桥的暴露面极小**：只监听 `127.0.0.1`（不绑 `0.0.0.0`）、只服务同一用户、
  只传 `sessionId` 与标题、队列上限 32 条且 45s 过期、响应回显插件名以防误认。
- **下载即校验**：自动安装只在 SHA256 与 Release 发布的 `SHA256SUMS.txt` 一致时才执行，
  且绝不覆盖已安装的版本。TLS 证书校验保持开启——这是「校验过再装」的前提，
  不要为了跑通而关掉。
