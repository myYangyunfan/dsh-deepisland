# DSH Notch — 系统级智能体灵动岛

把 DSH（DeepSeek Harness）的智能体工作状态显示在 **MacBook 物理刘海上**——
一个独立的原生 macOS 菜单栏应用，与仓库里的 DSH 插件（`lib/client.js`）是两套并列方案：

| 方案 | 位置 | 形态 | 适合 |
|---|---|---|---|
| **DSH 插件** | DSH 窗口内（DOM 覆盖层） | 随 DSH 窗口走 | 只用 DSH、想跟插件一致的四态样式 |
| **DSH Notch**（本目录） | 屏幕顶部物理刘海（NSPanel） | 系统级常驻 | 切到任何 App 都能看到，跨全屏/多桌面 |

> 两套方案同时开会在 DSH 窗口内叠出「应用内岛 + 真实刘海岛」两个状态栏，
> 建议只留系统级这一个（关闭插件的方法见仓库根 README）。

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
折叠 208×50（= 刘海宽 + 26×2），展开 440×160（= 刘海高 + 132）。
文字一律从刘海高（28pt）之下开始——**刘海区域是物理挖孔，画在那里的像素永远看不见**。

## 编译

本机只有 Command Line Tools（无完整 Xcode），`swift build` 会报
`unable to lookup item 'PlatformPath'`，因此**直接用 `swiftc`**。已封装成脚本：

```bash
cd swift
./build.sh              # 编译 + 打包 .build/DSHNotch.app
./build.sh preview      # 再离屏渲染形状预览图到 .build/preview/
./build.sh install      # 再安装到 /Applications 并启动
```

脚本内部等价于：

```bash
SDK=$(xcrun --show-sdk-path)
swiftc -O -sdk "$SDK" -target arm64-apple-macos13.0 -parse-as-library \
  -o .build/DSHNotch Sources/DSHNotch/Core/*.swift Sources/DSHNotch/UI/*.swift Sources/DSHNotch/App.swift
```

## 自检（不靠肉眼的两条路径）

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

## 数据来源

读取 DSH 的会话事件流（零新增数据通道）：

```
~/.dsh/sessions/<项目路径>/<session-id>/session.v4.jsonl.zstd
```

事件结构（逆向 dsh 0.2.0-rc.2 确认）：

```json
{ "type": "tool/call", "seq": 29, "time": 1791042626255,
  "data": { "turn": 1, "callId": "call_…", "name": "bash",
            "arguments": "{\"command\":\"ls -la …\"}" } }
```

注意 `arguments` 是**内嵌 JSON 的字符串**，需二次解析。解析逻辑与插件端
`parseActivityFromEvents` 一一对应，游标按事件自带的 `seq` 单调推进。

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

搜索顺序：`DSH_NOTCH_ZSTD` 环境变量 → App 同目录 → `Contents/Resources` →
`~/.local/bin/zstdlite` → `zstd`（homebrew/系统）→ `$PATH`。

## 诊断

```bash
DSH_NOTCH_VERBOSE=1 /Applications/DSHNotch.app/Contents/MacOS/DSHNotch
```

输出屏幕度量、zstd 工具路径、命中的会话文件、解压字节数/行数/解码条数、
首帧状态、窗口几何自证。排查数据通路或定位问题时先看这个。

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

## 已知限制

- 事件文件是 DSH 写完才落盘的，**写入过程中该行可能不完整**（解码自然跳过）。
- 只读「最近修改的会话文件」，同时开多个会话时只跟随最新那个。
- 无硬件刘海的屏会退化为屏幕顶部悬浮药丸（`NotchMetrics` 已做回退，
  但样式未针对无刘海屏调优）。
- 折叠态胶囊比刘海宽 52pt，会盖住刘海两侧各 26pt 的菜单栏空白区；
  展开态 440pt 宽，会明显盖住菜单栏（可接受：这是用户主动触发的临时面板）。
