# DSH Notch — 系统级智能体灵动岛

把 DSH（DeepSeek Harness）的智能体工作状态显示在 **MacBook 物理刘海上**——
一个独立的原生 macOS 菜单栏应用，与仓库里的 DSH 插件（`lib/client.js`）是两套并列方案：

| 方案 | 位置 | 形态 | 适合 |
|---|---|---|---|
| **DSH 插件** | DSH 窗口内（DOM 覆盖层） | 随 DSH 窗口走 | 只用 DSH、想跟插件一致的四态样式 |
| **DSH Notch**（本目录） | 屏幕顶部物理刘海（NSPanel） | 系统级常驻 | 切到任何 App 都能看到，跨全屏/多桌面 |

> 两套方案同时开会在 DSH 窗口内叠出「应用内岛 + 真实刘海岛」两个状态栏，
> 建议只留系统级这一个（关闭插件的方法见仓库根 README）。

**同时跟随多个对话。** DSH 可以并行开好几个会话（本机实测同一分钟里有两个会话在写文件），
只跟「最新那个文件」会丢掉其余对话的状态。现在刘海一次跟随最多 **6 个**活跃会话：
折叠态显示最该关注的那个 + 会话数徽标（`⚏ 2/3` = 3 个里头 2 个在跑），
展开态**每个对话各占一行**，按「谁最需要你介入」排序。

## 多会话：跟谁、排第几

候选范围是 `~/.dsh/sessions` 下**最近 30 分钟内有写入**的会话，最多 6 个；
一个都没有时退化为全量最新的 1 个（岛不会变空）。

主会话（列在第一位、折叠态显示的那个）按这个顺序选：

```
等人工确认  >  执行工具  >  思考中  >  已完成  >  待命        同级按 mtime 新的在前
```

「等人工确认」排最前，因为它是**唯一需要你动手**的状态——排在列表底部等于把它埋掉。
任一会话进入等确认状态都会让刘海自动展开，不只是主会话。

两个必须处理的边界：

- **停摆降级**：会话被关掉时最后一条事件可能停在 `tool/call`（结果永远不来）。
  若按事件流重放就会在岛上永远挂一个假的「执行 bash」。所以「最后一个事件已经过去
  90 秒」的会话一律降级为待命（`SessionMonitor.demoteIfStale`）。
- **历史重放不给回执期**：`done` 状态的 5 秒保持期从**事件自己的时间戳**算起，
  而不是「现在」。否则 App 一启动，一排几天前的会话会集体显示「任务已完成」。

性能：每个会话一套独立 `seq` 游标（增量解析）；**非主会话降频到每 4 个 tick
（1 秒）刷新一次**，主会话保持每 250ms。否则 6 个会话同时跑时，每个 tick 都要起
6 个 zstd 解压进程。掉出候选窗口的会话连同游标一起回收。

## 怎么用

装好并在运行后（菜单栏出现波形图标 ⏦），刘海正中就是这块浮层：

| 操作 | 结果 |
|---|---|
| **鼠标移到刘海上**（停留约 0.2 秒） | 展开成大面板（440 宽；高 176，多会话时按行数长到最多 235） |
| **鼠标移开**（超过 0.35 秒） | 自动收起 |
| **在岛上点一下**（折叠态，或展开态的非对话区） | 钉住（常驻展开）／再点一下取消 |
| **展开态点某一行对话**（单会话时点中间那块正文） | 跳到 DSH 里的那个对话：DSH 被拉到前台 + 该会话标题进剪贴板（见下节） |
| 状态变橙（等待人工确认） | 自动展开提醒，不用手点 |
| 任务跑完 | 保持绿色「任务已完成」约 5 秒，再自动收起 |
| 菜单栏波形图标 | 使用说明 / 钉住展开 / 悬停展开开关 / 空闲自动收起 / 开机自启 / 授予辅助功能权限（自动定位对话） / 定位会话文件 / 导出形状预览图 / 退出 |

状态色：灰=待命、蓝=思考、青=执行工具、橙=等你确认、绿=已完成。

启动后会自动展开 2.4 秒作为「我在跑」的演示。

### 展示哪些信息

| 位置 | 内容 |
|---|---|
| **折叠态**（208×50，单会话） | 状态点、当前动作、工具名（或子代理并发数）、本回合耗时 |
| 折叠态·单会话且上下文吃紧 | 占用百分比（>50% 转琥珀、>80% 转红）——常态不占位 |
| **折叠态·多会话** | 状态点、**主会话**动作、**会话数徽标** `⚏ 2/3`、主会话耗时。上下文百分比与工具名让位（208pt 装不下四样东西） |
| **展开态·单会话**（440×176） | 状态角标、当前任务、**轮次与步数** `T3·S98`、**工具参数正文**（等宽、最多 3 行）、**待办进度 + 当前待办项**、耗时、工具调用次数、**输出 token**、**上下文占用百分比**、**在飞工具/子代理数**、模型名与权限预设 |
| **展开态·多会话**（440×176→235） | 头部（主会话角标 + `N 个会话` + 交互提示）+ **每个对话一行**（状态点 / 会话标题 / 当前动作 / 短标签 / 耗时，主会话行高亮）+ 底部统计行（主会话的耗时 / 工具 / 输出 token / 上下文） |

几条判读规则：

- **工具参数正文**按 `command → file_path/path → pattern → question → description`
  的优先级挑最像人话的字段；`question` 出现即判定「等人工确认」→ 转橙并自动展开。
- **上下文占用**用宿主自己的算法（`surfaceTokens / contextWindow`），
  与 DSH 输入框下方那颗上下文环同源。
- **子代理并发数** = 投影里「在飞的工具调用」∩「agent 类工具名」
  （`subagent` / `send_message`）。事件流本身不含子代理信息，见下方数据来源。

数据全部**只读**本地会话文件，不联网、不改 DSH 任何文件。

## 跳转到对话

点岛上的某一行 → DSH 被拉到前台，同时那个会话的标题进了剪贴板。接着在
DSH 里按 **⌘K**（会话搜索）再 **⌘V** 即可定位过去 —— 标题就是列表行里
看得到的那串字，搜得到。

| 辅助功能权限 | 点一下之后 |
|---|---|
| 未授予（默认） | 置前 DSH + 标题进剪贴板，⚠️ 剩下 ⌘K、⌘V 两步自己做 |
| 已授予 | 还会自动替用户按 ⌘K 与 ⌘V，只剩一个回车确认 |

授权入口：菜单栏波形图标 →「授予辅助功能权限（自动定位对话）…」，
会弹系统询问并直接打开「辅助功能」设置页。**授权后要重启一次 DSH Notch 才生效**
（该菜单项标题会随之变成「辅助功能已授权（点对话自动定位）」）。

### 为什么不能一键直达

因为 DSH 侧没有这个入口。逐项查过 0.2.0-rc.2 的 `app.asar` 后确认：

- 对外**只注册了一条深链** `dsh://open`，主进程的 `open-url` 处理里只认这
  一个字面量，作用是 `focusPrimaryWindow()` —— 把主窗口拉到前台（实测有效）。
- 主界面是**无 URL 路由**的 SPA（前端里唯一带 `pushState` 的是内置 PDF 阅读器）。
- preload 暴露的只有 `dshDesktop` / `dshPlatform` / `__DSH_LOCALE__` /
  `dshPlatform` 之类，**没有任何会话控制能力**。
- host 的 `127.0.0.1:19387` 是要鉴权的 ACP 传输层，只服务 agent 协议，不是 UI 控制口。

所以跳转只能是「置前 + 复用 DSH 自己的会话搜索」，全程对 DSH 本体
**零改动、零注入、零调试端口**。

⌘K 不是猜的，宿主里注册的就是它：

```js
register("session.search", () => t("search.sessions.aria"),
         ["search sessions"], "KeyK", ["primary"], ["primary", "alt"], …)
```

`KeyK` + `primary`（macOS 上 primary = Command）＝ **⌘K**。

## 形状：为什么是「刘海的矩形延伸」

本机实测（MacBook Air 13" 1280×832 @2x）：

```
auxiliaryTopLeftArea  = (0, 804, 562, 28)
auxiliaryTopRightArea = (718, 804, 562, 28)
→ 物理刘海 = 156 × 28 pt，中心 x = 640（= 屏幕中心）
```

形状规则只有三条，缺一条就会读成「悬浮黑盒子」：

1. **顶边平直、方角**——物理刘海就是一个方正缺口，延伸自然也是矩形。
   早期版本给顶部两角画了内凹弧想做「负形」，结果是上沿被啃掉两块，
   像一个沙漏/奇形怪状的胶囊。
2. **顶边必须落在屏幕顶边之外**——形状顶端 y = 屏幕顶端时，两个方角正好压在
   屏幕边界上、肉眼看不见，整体读作「屏幕顶边正中长出来的一块黑色」。
   只要顶端距屏幕顶还有十几 pt（早期版本因为窗口含阴影留白而下移 11pt），
   方角暴露在画面里，立刻变成悬浮的黑盒子。
3. **只圆底部两角**——底角半径折叠态 12pt、展开态 20pt。

尺寸策略（`NotchMetrics`，全部由实测刘海推导）：
折叠 208×50（= 刘海宽 + 26×2）；展开 440 宽 × **176…235 高**——宽度固定，
高度随会话数增长（单会话 176 = 刘海高 + 148，多会话按 22pt/行 往上加，
6 行封顶 235；取单会话高度为下限，避免 1↔2 个会话切换时形状突然塌一截）。
**窗口尺寸按最大值（6 行）开**，展开时只改形状高度、窗口不动，动画不会被裁。

文字一律从刘海高（28pt）之下开始——**刘海区域是物理挖孔，画在那里的像素永远看不见**。

## 交互：悬停与点击怎么实现的

面板为了不抢用户的点击，是 `ignoresMouseEvents = true` 的**穿透窗口**。
代价是它**收不到任何鼠标事件**——所以：

- **悬停不能靠 `mouseEntered`**（穿透状态下永远不触发），只能由 App 层
  以 1/15 秒轮询 `NSEvent.mouseLocation` 自行判定指针是否落在岛体矩形内。
  读鼠标位置**不需要任何权限**（连辅助功能授权都不需要）。
- 判定用 `NotchMetrics.islandRect(size:)`（传**当前**形状尺寸）而不是窗口矩形 ——
  窗口按最大展开态开（440 宽 × 235 高 + 光晕留白），拿它当热区会把菜单栏一大片
  都算成「岛上」；而且多会话展开时形状高度是会变的，热区必须跟着走。
- 进入热区后需**停留 0.18 秒**才展开，避免鼠标掠过往顶栏时误触发；
  离开后**宽限 0.35 秒**才收起，避免边缘抖动导致闪烁。展开态整块也算「还在岛上」。
- **点击只在指针真的位于岛上时才接管**（`NotchPanel.isInteractive`，
  不留宽限、每次轮询重新判定）。否则窗口矩形会长期吞掉其下方应用与菜单栏的点击。
  这也意味着：点一下岛体钉住、再点一下取消，都不会「漏」到底下的应用。
- 因为交互是「悬停时临时打开」的，**小按钮是坏的**（早期版本 HUD 右上角有个 ✕，
  在穿透状态下根本点不动，是个假控件）。现在改成整块岛体可点，语义写在面板上
  （「点一下钉住」/「已钉住 · 点一下取消」）。

## 编译

**别人要装到自己机器上 → 看 [`INSTALL.md`](./INSTALL.md)**（两条路：下载现成包 / 从源码编译，
含 Gatekeeper 放行与卸载）。下面只讲本仓库的构建脚本。

本机只有 Command Line Tools（无完整 Xcode），`swift build` 会报
`unable to lookup item 'PlatformPath'`，因此**直接用 `swiftc`**。已封装成脚本：

```bash
cd swift
./build.sh              # 编译 + 打包 .build/DSHNotch.app
./build.sh preview      # 再离屏渲染形状预览图到 .build/preview/
./build.sh install      # 再安装到 /Applications 并启动
./build.sh package      # 产出可分发 zip 到 .build/dist/（附 SHA256SUMS.txt + 打包自证）
./build.sh self-test    # 交互自检（注入合成 NSEvent）
./build.sh proj-test    # 投影自检（真实缓存 + 事件流端到端）
./build.sh sess-test    # 多会话自检（排序 / 尺寸 / 无刘海尺寸 / 停摆降级 / 真实发现）
./build.sh jump-test    # 跳转自检（深链 / 剪贴板 / 反馈文案）
./build.sh all-tests    # 上面四套自检全跑一遍
./build.sh probes       # 编译全部自检探针到 .build/probes/
```

架构默认跟随本机（`uname -m`），可用 `DSHNOTCH_ARCH=x86_64 ./build.sh …` 覆盖。
带刘海的 MacBook 全是 Apple Silicon，所以 arm64 是主要目标。

脚本内部等价于：

```bash
SDK=$(xcrun --show-sdk-path)
swiftc -O -sdk "$SDK" -target "$(uname -m)-apple-macos13.0" -parse-as-library \
  -o .build/DSHNotch Sources/DSHNotch/Core/*.swift Sources/DSHNotch/UI/*.swift Sources/DSHNotch/App.swift
```

### 发布：由 CI 产出，不在这台机器上发

作者本机网络对 `api.github.com` 是 **SNI 级阻断**，实测三连：

| 检查 | 结果 |
| :--- | :--- |
| `dig api.github.com` | 被污染成 `199.59.148.9`（不是 GitHub 的 IP） |
| `doh.pub` 拿真实 IP `20.205.243.168` 后直连 | 超时，0 字节 |
| `github.com` | 正常 200 / 1.8s |

所以 `gh release create` 在这里永远 502/超时，但 `git push` 一直好使 ——
git 走的是另一条链路。于是发布改成**推 tag 触发 GitHub Actions**（runner 在境外）：

```bash
# 版本号在 swift/Resources/Info.plist 的 CFBundleShortVersionString
git push origin main
git tag -a v0.3.1 -m "DSH Notch 0.3.1" && git push origin v0.3.1   # 这一步触发发布
```

`.github/workflows/release.yml` 会在 `macos-14`（arm64）上编译打包、
断言产物确实是 arm64、再用 `GITHUB_TOKEN` 建 release 并附上 zip 与 `SHA256SUMS.txt`。
也可到 Actions 页手动触发（`workflow_dispatch`，填要发布的 tag）。

CI 上没有登录图形会话，所以 `build.sh package` 里「运行自检」那一项会被
`DSHNOTCH_SKIP_SELFTEST=1` 跳过；「zstdlite 已随包」「代码签名完好」两项照跑。

> 发完之后自己若要装同一版本，别用 `releases/download` 直链 —— 国内实测返回 404，
> 用 [`INSTALL.md`](./INSTALL.md) 里给的镜像前缀下载。

## 自检（不靠肉眼的七条路径）

### 1. 离屏渲染形状预览

```bash
./build.sh preview      # 产物：.build/preview/preview-*-{zoom,}.png
```

`--render-preview` 把灵动岛画在「模拟壁纸 + 模拟菜单栏文字 + 模拟物理挖孔」上，
并把**挖孔区域涂成纯黑**——真实刘海处没有像素，用黑矩形复刻这一约束，
才能暴露「文字被挖孔吃掉」这类问题。再自动裁一块放大 2 倍出图，
形状细节在全屏图里根本看不清。

### 2. 从外部断言窗口几何

```bash
swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 -parse-as-library \
  -o /tmp/probe-window tools/probe-window.swift && /tmp/probe-window
```

期望输出（已验证）：

```
窗口「-」 layer=25 alpha=1.00
  bounds(pt): x=400.0 y=0.0 w=480.0 h=180.0     ← CG 坐标（左上原点）
  顶端贴合屏幕顶边 (y≈0) : ✅
  水平居中               : ✅
  层级高于普通窗口        : ✅ layer=25
```

`DSH_NOTCH_VERBOSE=1` 启动时还会打印 `NSWindow.frame`（AppKit 左下原点）
与自身窗口的 CG bounds，两边互相印证。

### 3. 真正挪动指针，验证悬停链路

```bash
swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 \
  -o /tmp/probe-hover tools/probe-hover.swift Sources/DSHNotch/Core/NotchMetrics.swift

DSH_NOTCH_VERBOSE=1 ./.build/DSHNotch &     # 前台可看日志
/tmp/probe-hover --corner                   # 先把指针挪走（基线）
/tmp/probe-hover --notch 900                # 挪到刘海 → 期望日志「悬停: 进入热区 → 展开」
/tmp/probe-hover --corner 900               # 挪走     → 期望日志「悬停: 离开 → 收起」
```

已实测：基线 0 次展开；指针进入后 0.20s 出现「进入热区 → 展开」；
移开后 0.40s 出现「离开 → 收起」；`鼠标交互` 随指针同步开/关。

### 4. 注入真实 NSEvent，验证点击链路

```bash
./build.sh self-test        # 或 ./.build/DSHNotch --self-test，退出码 0 = 通过
```

自检把 `leftMouseDown/Up` 直接 `sendEvent` 进窗口，断言「点击 → 钉住翻转」。
**为什么不用 `CGEvent.post(tap: .cghidEventTap)`**：它需要辅助功能授权
（本机 `AXIsProcessTrusted = false`），事件会被系统**静默丢弃**——
探针打印「已合成点击」但宿主端毫无反应，看起来像应用坏了，其实是权限问题。

### 5. 投影解析 + 事件流端到端

```bash
./build.sh proj-test        # 或 ./.build/DSHNotch --self-test-projections
```

两条腿：

- **合成 fixture** 精确断言每个字段（局部数据里字段可能恰好缺失，覆盖不到边界），
  外加容错用例（空数据 / 非 JSON / 缺 record / `val` 为 null），
  以及「历史重放的 `turn/end` 不给新回执期」。
- **本机真实投影缓存**全部解析成功（当前 9 个），并把最近 3 个会话的
  事件流跑一遍游标，与**测试自己独立重算的期望值**对比：
  本回合工具计数、当前轮次、step 是否可取得、子代理数是否为 0。
  期望值不经过被测代码，所以能真正判出游标算错。

同时打印投影相对事件流的滞后量（实测 0）。当前：**88 项断言全通过**。

### 6. 像素采样（判断形状/布局是否溢出）

```bash
./build.sh probes
./.build/probes/probe-pixels .build/preview/preview-multi-6.png 0 40 56 120 240 400 460 468 480 520
```

直接量出每一行里「岛体黑底」与「光晕色」的水平范围。**目测 PNG 极易被
图片缩放骗到**（本项目就发生过一次：判定「光晕溢出岛体」，程序采样后
证明岛体精确位于 [420, 860] pt、两侧光晕各只外扩 5pt，完全是错觉）。

多会话的高度差也只有这样才敢下结论。6 个会话的实测输出：

```
y=120  黑底[840-1719]          → 岛体 = 420…860 pt（440 宽、水平居中 ✅）
y=460  黑底[851-1708]          → 圆角开始收窄
y=468  黑底[867-1692]
y=480  黑底[-]                 → 底部在 470px = 235pt ✅ 正好等于设计值
```

### 7. 多会话路径

```bash
./build.sh sess-test        # 或 ./.build/DSHNotch --self-test-sessions
```

`--self-test-projections` 验的是**单个会话**的解析；这一套专门验「同时跟多个」——
那条路径原先一行测试都没有。当前 **47 项断言全通过**：

- **排序**：五种状态打乱 mtime 后仍按 `waiting > tool > thinking > done > idle` 排
  （样本的 mtime 与优先级故意相反，证明排的是状态而不是「谁更新得晚」）；
  同级按 mtime 新的在前；空列表不崩；主会话 = 第 0 个。
- **尺寸**：1/2/3 个会话同高、4 个开始变高、6 个最高、超过上限被夹到 6；
  窗口 = 最大展开尺寸 + 留白；内容带真的装得下 6 行（需要 147pt，有 207pt）；
  热区顶端贴屏、水平居中、随形状长高。
- **停摆降级**：刚有事件推进的不降级；停摆 10 分钟的降为待命并清掉残留工具名与
  在飞计数；阈值两侧各测一次；`.done` 不参与降级；不知道事件时间时不动（避免误杀）。
- **真实发现**：走完整 `poll` 路径（发现 → 解压 → 游标 → 投影 → 排序），
  断言候选数 = 轮询结果数、每个都有展示名、按 mtime 倒序、
  降频轮不丢会话、`reset()` 后能重建。
  本机现场输出（当时 2 个活跃会话）：

```
候选会话 2 个: session-deb090, session-a59ae8
首帧: 会话 2 个 [高难度数学试卷出题(idle), 分析调试代码问题(idle)] 主会话「DeepSeek 待命」
```

### 8. 跳转链路（`./build.sh jump-test`）

15 条断言。**刻意不做真实跳转** —— 那会置前 DSH 并覆盖剪贴板，自检不该有副作用。
所以「深链真能被唤到」用**系统处理器查询**来证明，而不是实测：

- 深链字面量是 `dsh://open`，且 `NSWorkspace.urlForApplication(toOpen:)`
  确实指向 DeepSeek Harness —— 有注册者，才是「系统投递得出去」的证据；
- 会话搜索键位 `KeyK`（`kVK_ANSI_K` = 40）；
- 剪贴板文本选取：标题优先、空白回退会话 id、两端空白裁掉；
- 剪贴板写入往返（**写后复原**，不霸占用户剪贴板）；
- 反馈文案两种分支 + `canSendKeys` 可求值。

```
$ ./build.sh jump-test
· dsh://open 深链与系统处理器
  ✓ 系统已注册 dsh:// 处理器：/Applications/DeepSeek Harness.app
  ✓ 处理器指向 DeepSeek Harness（DeepSeek Harness.app）
· 反馈文案与权限探测
  · 辅助功能权限: 已授权（会替用户按 ⌘K ⌘V）
[dsh-notch] 跳转自检结束：通过 15，失败 0
```

注意最后那行权限是**自检进程**的（继承终端），别拿它当 app 的结论 ——
看启动诊断文件。

## 数据来源（两个本地数据源）

两个源都按**每个会话**分别读取（多会话监控的核心），发现规则见上方
「多会话：跟谁、排第几」。列表里显示的会话名取投影的 `title`（DSH 自己总结的，
如「高难度数学试卷出题」），取不到时退回项目目录名
（`--Users-delinger-Desktop-office--` → `office`），再退回 id 前 8 位。

### A. 会话事件流 —— 「正在发生什么」

```
~/.dsh/sessions/<项目路径>/<session-id>/session.v4.jsonl.zstd
```

zstd 压缩的 JSONL，每行一条事件。结构（逆向 dsh 0.2.0-rc.2 确认）：

```json
{ "type": "tool/call", "seq": 29, "time": 1791042626255,
  "data": { "turn": 1, "step": 23, "callId": "call_…", "name": "bash",
            "arguments": "{\"command\":\"ls -la …\"}" } }
```

- `arguments` 是**内嵌 JSON 的字符串**，需二次解析。
- `turn` / `step` 出现在 `step/start`、`tool/call`、`tool/result` 上，
  当前进度直接取最近一条带这两个字段的事件。
- 游标按事件自带的 `seq` 单调推进（与插件端 `parseActivityFromEvents` 同一套原则）。
- **事件流里没有** token 用量、上下文占用、待办列表、模型名 —— 这些得另找。

### B. 会话投影缓存 —— 「累计成了什么样」

```
~/.dsh/storages/session_projcache/sessions/<session-id>.json
```

这是 DSH 自己对事件流做折叠（fold）之后的状态快照，形如
`{"version":7,"record":{"rows":{ "<key>":{"ver":N,"seq":M,"val":…} }}}`。
磁盘上存的是**完整 fold state**（比它自己 UI 用的 wire view 更全），
所以能拿到界面都不显示的字段：

| row | 用途 | 备注 |
|---|---|---|
| `tokenUsage.totals` | 输出 / 未缓存输入 / 缓存命中 token | 累计值 |
| `contextPressure` | `surfaceTokens` / `contextWindow` | 宿主那颗上下文环同源 |
| `sessionStats` | `turns` / `steps` / `llmMs` / `toolMs` | 另有 `openStep`、`pendingCalls`（UI 不显示但很有用） |
| `todos` | 待办清单与状态 | |
| `modelSelection.lastUsed` | provider + 模型名 | |
| `permissions.preset` | 权限预设 | |
| `title` | DSH 自己总结的会话标题 | 比第一句 prompt 干净 |
| `subagentCatalog` | 已派生的子代理目录 | 只有 `{id, createdAt, mode, label}`，**不含运行态** |

**关键实证：投影与事件流完全同步。** 实测三个会话的 `proj.seq` 与
`events.maxSeq` 逐一相等（滞后 0 个事件序号），所以它可以当实时数据源用：

```
session-6778327d  proj.seq=544  events.maxSeq=544
session-a59ae858  proj.seq=88   events.maxSeq=88
session-9a3fb65c  proj.seq=75   events.maxSeq=75
```

（注意 `row.seq` 是「该值最后一次变化」的序号，通常小于 `maxSeq` 属正常；
这里比较的是所有 row 的最大 seq。）

### 关于子代理并发数

`app.asar` 里**不存在** `subagentsByParent` 这种快照字段，投影的
`subagentCatalog` 也只记目录不含运行态。因此并发数是用两个源**相交**推出来的：

```
在飞的工具调用 = sessionStats.pendingCalls 的 callId 集合        （源 B）
callId → 工具名 = 事件流里的 tool/call 事件                        （源 A）
子代理并发数   = 在飞调用中工具名 ∈ {subagent, send_message} 的个数
```

工具名取自 `app.asar` 中 `tool.call.toolview` 注册的 slot key
（`subagent` / `list_agents` / `send_message` / `interrupt_agent` / `job_*`），
只取真正会拉起/驱动一个子代理的两个，避免把「查询列表」也算成并发。
映射不到的 callId 会被忽略（宁可不显示，也不猜）——
此时折叠态只显示通用「在飞工具数」。

## 常驻策略

- **DSH 运行中 → 常驻**（默认）。依据是 `NSWorkspace` 里是否存在
  `com.deepseek.dsh`，启动/退出用 `didLaunch/didTerminate` 通知实时跟随。
- DSH 退出 → 立刻收起。
- 菜单栏可勾选「空闲时自动收起」，改成只在真有活动时出现（3 秒无活动收起）。
- 等待人工确认（`waiting`）时自动展开 HUD，不用手动点。

## zstd 依赖

DSH 的会话文件是 zstd 压缩的，而 macOS SDK **不提供 libzstd**。
本目录的 `tools/zstdlite` 是自写的极简解压工具（约 110 KB）：

```bash
./swift/tools/zstdlite/build.sh
```

> 为什么不用官方 zstd：① 不发布 macOS 预编译二进制；② 其 Makefile 需 GNU make，
> macOS 的 BSD make 会报 `missing separator`；③ 官方 CLI 的 `main()` 链接了
> 字典构建器（dibio），需额外编译 `lib/dictBuilder`。
>
> 正确性已用官方 python `zstandard` 逐字节比对验证（1368905 字节完全一致）。

搜索顺序：`DSH_NOTCH_ZSTD` 环境变量 → `Contents/Resources`（随包分发的那份）
→ App 可执行文件同目录 → `~/.local/bin/zstdlite` → `zstd`（homebrew/系统）→ `$PATH`。

> **`Contents/Resources` 这一条是分发的前提。** 早期只找「可执行文件同目录」，
> 而 `build.sh` 把工具放在 `Contents/Resources` —— 两者对不上，本机因为恰好有
> `~/.local/bin/zstdlite` 才没暴露；别人拿到 `.app` 是没有那份的，
> 会完全读不到会话（面板一直空白）。`./build.sh package` 的打包自证里加了这条检查。

## 诊断

```bash
DSH_NOTCH_VERBOSE=1 /Applications/DSHNotch.app/Contents/MacOS/DSHNotch
```

输出屏幕度量、候选会话列表、zstd 工具路径、每个会话的解压字节数/行数/解码条数、
投影关键指标（seq / turns / steps / 输出 token / 上下文 / 在飞调用 / 待办）、
首帧状态、多会话快照（每秒一次）、窗口几何自证。
排查数据通路或定位问题时先看这个。

### 启动诊断文件（日志读不到时的唯一线索）

本机统一日志**读不到本进程的 NSLog**（`log show` 与 `log stream` 都抓不到，
实测 0 行），而这是个没有终端的常驻 GUI —— 出问题时手里一点线索都没有。
所以每次启动都会覆盖写一份：

```
~/Library/Application Support/DSHNotch/last-launch.txt
```

真实样例：

```
DSH Notch 启动诊断
屏幕: 屏幕 1280×832@2x | 刘海 156×28 @(x=562,y=804) | 折叠 208×50 | 展开 440×176（单会话）/ 最高 235（6 会话）
DSH 运行中: true
辅助功能权限: 未授权 → 点对话只置前 DSH + 复制标题
跳转深链: dsh://open
会话候选: 1 个
```

**「辅助功能权限」这行只能由这个文件给出**：命令行里跑自检时
`AXIsProcessTrusted()` 会继承终端/宿主 App 的授权，和装到 /Applications 后的
真实进程不是一回事（本机实测：命令行报「已授权」，真实 app 报「未授权」）。

典型输出（真实运行）：

```
屏幕度量: 屏幕 1280×832@2x | 刘海 156×28 @(x=562,y=804) | 折叠 208×50 | 展开 440×176（单会话）/ 最高 235（6 会话）
候选会话 2 个: session-deb090, session-a59ae8
loadEvents: session.v4.jsonl.zstd 解压 161562 字节 / 90 行 → 解码成功 90 条
projections: session-a59ae858….json seq=159 turns=6 steps=16 out=10567 ctx=1.5%
首帧: 会话 2 个 [高难度数学试卷出题(idle), 分析调试代码问题(idle)] 主会话「DeepSeek 待命」
会话 2 个: 高难度数学试卷出题(idle,待命) | 分析调试代码问题(idle,待命)
```

最后一行每秒打一次，就是多会话监控的现场快照：两个对话各自的**标题**与状态。
注意它们是 `idle` 而不是「已完成」—— 那是停摆降级在起作用（文件早就不写了），
修这条之前，岛启动时会挂一排假的「任务已完成」。

## 踩坑记录

1. **`swift build` 在只有 CLT 的机器上不可用** —— `xcrun --show-sdk-platform-path`
   报 `unable to lookup item 'PlatformPath'`。改用 `swiftc` 直接编译。
2. **`setFrame` 会被系统悄悄改写** —— NSWindow 的 `constrainFrameRect(_:to:)`
   默认把窗口约束在 `screen.visibleFrame` 内（排除菜单栏/刘海那 28pt 带状区域），
   于是请求的 (400, 652, 480, 180) 落到屏幕上完全不是那个位置。
   **必须覆写该方法原样返回** —— 灵动岛要的就是压在菜单栏上。
3. **窗口顶端 ≠ 内容顶端** —— 早期把阴影留白算进窗口高度、内容在窗口里居中，
   结果形状整体下移 11pt，方角暴露 → 读作悬浮盒子。现在窗口顶端 = 屏幕顶端，
   内容顶端对齐，四周留白只加在左右和底部。
4. **光晕铺满整个形状会毁掉一切** —— 展开态 160pt 高，渐变铺满意味着上半部分
   全被状态色淹没，文字对比度崩掉、剪影也糊。改成固定高度（34/48pt）的光晕带 +
   外层 `.shadow` 柔光，且**必须 `clipShape` 裁进形状**，否则边缘发虚。
5. **视图树不能每 250ms 重建** —— 早期每 tick 新建一次 `NSHostingView`，
   展开动画刚起步就被打断。改成状态驱动：视图树只建一次，
   靠 `ObservableObject` 的 `@Published` 刷新。
6. **`orderFront` 之后窗口注册是异步的** —— 立刻调 `CGWindowListCopyWindowInfo`
   一条自身窗口都查不到，会误判「窗口不存在」。至少等 1 秒再查。
7. **外部工具读别的应用窗口几何不可信** —— 无屏幕录制权限时
   `CGWindowListCopyWindowInfo` 返回的列表被裁剪、数值被改写；
   `screencapture` 在此环境下直接报 `could not create image from display`。
   自证（进程内查自己的窗口）才是可信源，两者对不上时以自证为准。
8. **`-dc` 参数会让 zstdlite 静默失败** —— 它只认 `-d`。更糟的是当时把
   stderr 接到了 `FileHandle.nullDevice`，`terminationStatus != 0` 就直接
   `return nil`，日志里什么都看不到。**教训：调用外部进程务必捕获并记录 stderr**。
9. **`[String: Any]` 不符合 `Decodable`** —— 需要自定义 `JSONValue` 枚举作为替身。
10. **`animatableData` 的 setter 里不能用 `$0`** —— 那是非闭包上下文，编译期直接报错；
    且 setter 要真的写回属性，否则圆角不会随动画插值。
11. **`@Binding` 传不进 `showNotch(_:)` 这类非 View 上下文** —— 改用
    `ObservableObject` + `@ObservedObject`。
12. **`replacingOccurrences(of:with:)` 的参数标签不能省空格** ——
    `with="-zoom.png"` 会被解析成 `with=("-zoom.png")`，报
    `cannot find 'with' in scope`，极其迷惑。
13. **App 启动即退** —— 用 SwiftUI `App` 协议的 `Settings {}` 场景没有主窗口，
    `NSApplication` 不会常驻。改用 `@main enum` + `NSApplication.run()`，
    策略设 `.accessory`。
14. **穿透窗口收不到 `mouseEntered`** —— `ignoresMouseEvents = true` 时
    `NSTrackingArea`、`mouseEntered(with:)` 全部失效（鼠标事件在窗口服务器层就被
    丢掉了）。想同时做到「不抢点击」和「能感知悬停」，只有轮询
    `NSEvent.mouseLocation` 一条路——它不需要任何权限。
15. **穿透状态下的按钮是假控件** —— 同理，`ignoresMouseEvents = true` 时
    SwiftUI `Button` 永远点不动。要么在悬停时把 `ignoresMouseEvents` 设回 false
    （本项目做法，且只对「指针真在岛上」这一瞬间生效），要么别放按钮。
16. **合成 `CGEvent` 会被静默丢弃** —— 无辅助功能授权时
    `CGEvent.post(tap: .cghidEventTap)` 与 `postToPid` 都不生效，
    且 CLI 层面看不到任何报错。验证点击请直接 `NSWindow.sendEvent(NSEvent.mouseEvent(...))`。
17. **同名变量跨层漏同步** —— `Activity.toolCount`（快照字段）与
    `ActivityCursor.toolCount`（游标私有累计量）同名，`handle()` 里只自增了后者，
    快照里的值**从头到尾没被写过** → HUD 的「工具调用」永远显示 0 次。
    这个 bug 在旧版就存在，是补断言时才暴露的。
    **教训：结构体快照与内部状态用同名属性时，必须有一个显式同步点。**
18. **`turn`/`step` 只在 `step/start` 里取是漏的** —— `tool/call`、`tool/result`
    的 `data` 同样带这两个字段。只认 `step/start` 会让进度徽标停在很久以前。
    改成「任何带 `turn`/`step` 的事件都同步」，并由 `turn/start` 负责归零。
19. **不要凭印象给数据源下结论** —— 我曾判定 `session_projcache` 「只有 UI 投影、
    无实时运行状态、不适合做监控」，实测发现它带 `sessionStats` / `contextPressure` /
    `tokenUsage` / `pendingCalls`，且 `seq` 与事件流**逐一对齐（滞后 0）**。
    一个反例：`app.asar` 里根本搜不到 `subagentsByParent`，而我一直以为那是宿主 API。
20. **子代理并发数没有现成字段可读** —— 事件流不含子代理信息；投影
    `subagentCatalog` 只记 `{id, createdAt, mode, label}`（无运行态）；
    `subagent` row 只在「本会话自己是子代理」时才有值。
    最终用 `sessionStats.pendingCalls`（在飞 callId）∩ 事件流里的
    `callId → 工具名` 映射推出，映射不到就不显示 —— **宁可不显示，也不猜**。
21. **「最新那个会话」不等于「你关心的那个会话」** —— 早期实现每次只取 mtime
    最新的一个文件，多个对话并行时只显示一个。改成多会话后还有一个更隐蔽的坑：
    **`done` 的 5 秒保持期原本从「现在」起算**，而 App 启动时要重放整个历史会话，
    于是几天前结束的回合全部获得一段新的回执期 —— 岛上一排「任务已完成」。
    改成从**事件自己的 `time`** 起算，历史回合立即归位。
22. **文件不更新了，状态却还挂着** —— 会话被关掉时最后一条事件可能是
    `tool/call`（结果永远不来）。游标重放会把这个中间状态当成现状，而文件不再变化，
    于是「执行 bash」永远停在岛上。修法是按**最后事件时间**做停摆降级（90 秒），
    且只改展示快照、不动游标 —— 该会话真收到新事件时会自然恢复。
23. **折叠态 208pt 装不下四样东西** —— 加上会话数徽标后，标题被挤成
    「等待人工…」（读不出信息）。取舍是**多会话时去掉上下文百分比与工具名**，
    保「主会话在干什么 + 几个在跑 + 耗时」。窄面板上加字段前先在预览图上量一遍。
24. **行内耗时对停摆会话是误导** —— 待命会话的 `turnStartTime` 是上一回合的起点，
    照着算会显示「已经跑了 3 小时」。改成只在会话活跃时显示，其余给 `--:--`。
25. **`String(format:)` 参数错位不报错，只是静默输出垃圾** —— 给 `describe`
    加多会话尺寸时漏了一个宽度参数，日志打出「展开 **176×235**（单会话）/
    最高 **0**（0 会话）」：高度顶到了宽度的位置、`%ld` 位置读到了错位的 Float
    变成 0。Swift 这里**不做任何校验**，也不崩。修法是先把尺寸取成局部变量
    再传，并让自检**按内容断言日志**（`SessionSelfTest.testSizes` 里 4 条）。

## 已知限制

- 事件文件是 DSH 写完才落盘的，**写入过程中该行可能不完整**（解码自然跳过）。
- **多会话上限 6 个、观察窗口 30 分钟**：同时开更多对话时只跟最近修改的 6 个；
  超过 30 分钟没写入的会话会掉出候选（选中它的行下次刷新就消失）。
  这两个数字都在 `SessionSource` 里，改一行即可。
- **非主会话有 1 秒延迟**：降频刷新（每 4 个 tick）换来的低开销 ——
  次要对话的状态最多晚 1 秒更新；主会话（排序第一）保持 250ms。
- **会话名可能撞车**：标题取自 DSH 的 `title`，两个对话标题一样时列表里会显示
  相同的名字（id 不同，排序和统计各自独立）——**不会串数据，只是看起来重名**。
- **上下文占用**取自投影的 `surfaceTokens / contextWindow`，是 DSH 自己的估算
  （它同时还有 `sampledSurfaceTokens`，两者略有差异），当参考值用。
- **子代理并发数是推断值**：靠「在飞的工具调用」∩「agent 类工具名」得出。
  工具改名或事件流还没读到对应 `tool/call` 时就退化为只显示「在飞工具数」，
  不会瞎报。
- **投影缓存缺失时自动降级**：读不到 `session_projcache` 就只展示事件流
  能给的字段（动作、工具名、耗时、轮次步数），token / 上下文 / 待办不显示。
  两个数据源都是只读，任何一侧失败都不会影响另一侧。
- **无刘海屏（M1 Air / iMac / 合盖只接外接屏）形态不同**：没有物理挖孔，
  折叠态是 320×26 的贴顶悬浮条（有刘海时是 208×50 的刘海延伸条）。
  这条路径只有**离线渲染**验证（`--render-preview-nonotch`）+ 8 条尺寸断言，
  **没有真机**。曾经这里塌成高度 0（`notchHeight 0 + infoBandHeight 0`），
  面板整个不可见 —— 现已给无刘海态一个自有高度，断言钉在 `testNoNotch`。
  悬浮条贴在最顶上，可能压住菜单栏左侧文字（它不接收鼠标事件，菜单仍可点）。
- 无硬件刘海的屏会退化为屏幕顶部悬浮药丸（`NotchMetrics` 已做回退，
  但样式未针对无刘海屏调优）。
- 折叠态胶囊比刘海宽 52pt，会盖住刘海两侧各 26pt 的菜单栏空白区；
  展开态 440pt 宽，会明显盖住菜单栏（可接受：这是用户主动触发的临时面板）。
- 悬停热区必然与刘海两侧的菜单栏带重叠（胶囊本来就画在那里）。
  鼠标停在紧邻刘海的那 26pt 空白带上也会展开 —— 这是刻意的（不然盲区里
  根本没法对准），嫌烦可在菜单栏关掉「鼠标悬停展开」。
- **跳转要绕一步**：DSH 没有「打开第 N 个对话」的接口（原因见「跳转到对话」），
  点对话行是「置前 DSH + 复制标题」。不自动发回车 —— 搜索结果第一项未必就是
  目标，交给用户确认。授予辅助功能权限后能省掉 ⌘K、⌘V 两步。
- 悬停/点击都依赖本地轮询与窗口服务器，**多显示器时只服务带刘海的屏**
  （`NotchMetrics.targetScreen()` 优先选有刘海的屏，否则主屏）。
