# DSH Notch — 系统级智能体灵动岛

把 DSH（DeepSeek Harness）的智能体工作状态显示在 **MacBook 物理刘海上**——
一个独立的原生 macOS 菜单栏应用，与仓库里的 DSH 插件（`lib/client.js`）是两套并列方案：

| 方案 | 位置 | 形态 | 适合 |
|---|---|---|---|
| **DSH 插件** | DSH 窗口内（DOM 覆盖层） | 随 DSH 窗口走 | 只用 DSH、想要与插件一致的四态样式 |
| **DSH Notch**（本目录） | 屏幕顶部物理刘海（NSPanel） | 系统级常驻 | 切到任何 App 都能看到，跨全屏/多桌面 |

## 特性

- **贴真实刘海**：无边框透明 `NSPanel` + `CGShieldingWindowLevel`，
  配合内凹的 `NotchShape` 曲线，读作刘海的视觉延伸而非悬浮黑盒子。
- **DSH 有活动才显示**：常驻菜单栏（`LSUIElement`，无 Dock 图标），
  仅在 DSH 处于活跃态时在刘海显示；空闲 3 秒自动收起。
- **四种状态**：`thinking` / `tool` / `waiting` / `idle`，
  各带独立光晕色，与插件端语义一致。
- **展开 HUD**：点胶囊展开 440×146，显示完整命令、耗时、工具调用次数。
- **零第三方依赖**：zstd 解压用仓库自带的 `zstdlite`（110 KB，仅实现解压）。

## 编译

本机只有 Command Line Tools（无完整 Xcode），`swift build` 会报
`unable to lookup item 'PlatformPath'`，因此**直接用 `swiftc`**：

```bash
cd swift
SDK=$(xcrun --show-sdk-path)
swiftc -O -sdk "$SDK" -target arm64-apple-macos13.0 -parse-as-library \
  -o .build/DSHNotch \
  Sources/DSHNotch/Core/*.swift Sources/DSHNotch/UI/*.swift Sources/DSHNotch/App.swift
```

打包成 .app（含 `LSUIElement` 与 ad-hoc 签名）：

```bash
APP=".build/DSHNotch.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/DSHNotch "$APP/Contents/MacOS/DSHNotch"
cp ~/.local/bin/zstdlite "$APP/Contents/Resources/zstdlite"
# Info.plist 见本目录说明；关键项 LSUIElement=true
codesign --force --deep --sign - "$APP"
```

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

注意 `arguments` 是**内嵌 JSON 的字符串**，需二次解析。
解析逻辑与插件端 `parseActivityFromEvents` 一一对应。

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
DSH_NOTCH_VERBOSE=1 ./.build/DSHNotch.app/Contents/MacOS/DSHNotch
```

会输出 zstd 工具路径、命中的会话文件、解压字节数 / 行数 / 解码条数与首帧状态。
排查数据通路时先看这个。

## 踩坑记录

1. **`swift build` 在只有 CLT 的机器上不可用** —— `xcrun --show-sdk-platform-path`
   报 `unable to lookup item 'PlatformPath'`。改用 `swiftc` 直接编译。
2. **App 启动即退** —— 用 SwiftUI `App` 协议的 `Settings {}` 场景没有主窗口，
   `NSApplication` 不会常驻。改用 `@main enum` + `NSApplication.run()`，
   策略设 `.accessory`。
3. **`-dc` 参数会让 zstdlite 静默失败** —— 它只认 `-d`。更糟的是当时把
   stderr 接到了 `FileHandle.nullDevice`，`terminationStatus != 0` 就直接
   `return nil`，日志里什么都看不到。**教训：调用外部进程务必捕获并记录 stderr**。
4. **`[String: Any]` 不符合 `Decodable`** —— 需要自定义 `JSONValue` 枚举作为替身。
5. **`animatableData` 的 setter 里不能用 `$0`** —— 那是非闭包上下文，编译期直接报错。
6. **`@Binding` 传不进 `showNotch(_:)` 这类非 View 上下文** —— 改用
   `ObservableObject` + `@ObservedObject`。

## 已知限制

- 事件文件是 DSH 写完才落盘的，**写入过程中该行可能不完整**（解码自然跳过）。
- 空闲判定基于「最新事件的 mtime」，DSH 挂起很久后重启会先显示一帧「待命」。
- 只在有硬件刘海的屏上贴刘海；无刘海的屏会退化为屏幕底部悬浮药丸
  （`NotchPanel.targetScreen` 已做回退，但样式未针对无刘海屏调优）。
