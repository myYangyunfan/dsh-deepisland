# DSH Notch for Windows

Windows 版的刘海灵动岛。**状态：数据层已完成并验证，UI 层未做。**

## 现在有什么

```
windows/
├── README.md              ← 你在这里
├── package.json           Electron 壳（独立子项目，不受根 package.json 的 type:module 影响）
├── src/
│   ├── session-source.js  ✅ 会话发现 + zstd 解压 + 事件解码（33 项自检）
│   ├── projections.js     ✅ 读 DSH 的投影快照 + 宽松解析（47 项自检）
│   ├── config.js          ⬜ 读 client-config.json（与 macOS 版同一份协议）
│   ├── main.js            ⬜ 主进程：无边框置顶小窗 + 托盘 + 配置轮询
│   ├── preload.js         ⬜ 暴露最小能力给渲染进程（不开放 node）
│   └── renderer.js        ⬜ 状态条 UI（折叠条 / 展开面板）
└── test/
    ├── run.js                 跑器
    ├── session-source.test.js
    └── projections.test.js
```

**数据层已完成**：80 项自检，Node 22 与宿主 Electron Node 24.18.1 各跑一遍全过，
用**真实**会话文件（9 个）与真实投影文件（15 个）验证，不是造假样本。

**UI 层还没动** —— 它需要 Windows 才能验。跑 `node test/run.js` 可复验数据层。

## 数据现状：能显示什么、不能显示什么（**先读这段**）

移植时用真实数据（9 个会话文件 + 15 个投影文件）实测出一个**必须先讲清的限制**，
否则会做出「看起来有实时状态、其实只是静态快照」的东西。

### 事件流里没有状态事件

`session.v4.jsonl.zstd` 解压后，`type` **只有 `session` 一种**（9 个会话全如此），
连 `seq` 字段都没有。所以 macOS 版 `ActivityCursor` 依赖的事件流判定
（`thinking` / `tool` / `waiting`）**在真实数据上永远走不到**。

→ 状态只能靠**投影侧**判定：`openStep`（有未闭合的步骤）、
`pendingCalls`（在飞的工具调用）、`seq` 是否在推进。

### 真实数据实测（那次会话已结束，48 分钟前）

| 能显示 | 值 |
| :--- | :--- |
| 标题 | 高难度数学试卷出题 |
| 输出 token | 1.4k |
| 上下文占用 | 10243 / 1000000（1.0%） |
| 回合 / 步骤 | 3 / 6 |
| LLM 耗时 / 工具耗时 | 59s / 11s |
| 权限预设 | workspace-write |
| 正在执行？ | 否（`openStep` 为 null、`pendingCalls` 为空 —— 符合「已结束」） |

真在跑时 `openStep` / `pendingCalls` / `seq` 会持续推进，
届时才能判定「执行中」。**这一点必须在 UI 上如实反映**：
不要在没有信号时假装有实时状态。

### 三条移植时踩到的形态坑（都已加断言）

1. **`title.val` 是裸字符串**，不是对象。第一版按对象取 → 标题整个丢掉
2. **`pendingCalls` 是对象** `{callId: {…}}`，不是数组。
   第一版用 `Array.isArray()` → 永远空 → 判定不出「正在执行」。
   **而自造样本里塞的是数组，所以测试一直是绿的** ——
   假样本骗过了测试，这类断言必须用真实形态
3. **投影文件名有两种**：`session-<id>.json` 与 `<id>.json`（实测 15 个文件里两种都有）

## 与 macOS 版共享的东西

| 共享 | 形式 | 说明 |
| :--- | :--- | :--- |
| **配置协议** | `client-config.json` | 键名与语义完全一致（`notchEnabled` / `jumpEnabled` / `hideWhenIdle`）。Windows 路径是 `%APPDATA%\DSHNotch\`，插件服务端要按平台选目录 |
| **本机桥** | `127.0.0.1:47311` | 纯 `node:http`，跨平台通用。Windows 上照样能 `POST /jump` 换会话 |
| **会话数据源** | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | 纯文件读取 + zstd 解压。路径分隔符与目录名编码需按 Windows 调整 |

## 为什么用 Electron

1. **DSH 本身就是 Electron**（Windows 版同理），视觉与输入行为能对齐，
   不会出现"两个 Electron 抢焦点"的怪问题
2. **无边框置顶小窗**用 Electron 几十行就能做；原生 Win32 要处理
   `WS_EX_LAYERED` / `WS_EX_TRANSPARENT` / `SetWindowPos(HWND_TOPMOST)` /
   点击穿透（`WS_EX_TRANSPARENT`）等一堆细节，而且每处都有坑
3. **托盘** Electron 有原生 `Tray`，原生 Win32 要自己画图标 + 处理
   右键菜单与 DPI 缩放
4. **zstd 解压**：Node 22+ 内置 `zstdDecompressSync`（DSH 运行时是 Node 24），
   不必像 macOS 版那样自带 zstdlite 二进制

**代价**：安装包 ~80 MB（macOS 版 1.2 MB）。对"常驻小工具"来说偏大，
但换来的是少踩 Win32 的坑。

## 待办

- [ ] `config.js` —— 读 `%APPDATA%\DSHNotch\client-config.json`，按 mtime 缓存

- [ ] 渲染进程 UI（折叠条 / 展开面板 / 多会话行）
- [ ] 点击某行 → `POST http://127.0.0.1:47311/jump`
- [ ] 置前 DSH（Windows 上的深链/激活方式**待查证**，macOS 是 `dsh://open`）
- [ ] 托盘菜单（显示/隐藏、退出）
- [ ] 打包（`electron-builder` → nsis）与 SHA256SUMS
- [ ] 插件服务端：Windows 上自动装它（现在 `platform !== 'darwin'` 直接跳过）
- [ ] 插件服务端：`configFilePath()` 按平台选目录（现在硬编码 macOS 路径）

## ⚠️ 未验证

**这个项目一行都还没在 Windows 上跑过。** 开发环境是 macOS，没有 Windows 机器，
所以以下全部未经真机验证：构建、运行、托盘行为、置前 DSH、打包、插件自动安装。

写完之后的验证只能靠 Windows 机器或 CI（`windows-latest` runner）。

## 怎么构建（未验证）

```powershell
npm install
npm start        # 开发
npm run dist     # 打包 → dist/
```
