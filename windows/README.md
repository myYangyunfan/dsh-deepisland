# DSH Notch for Windows

Windows 版的刘海灵动岛。**状态：骨架阶段，未完成。**

## 现在有什么

```
windows/
├── README.md          ← 你在这里
├── package.json       Electron 壳（窗口/托盘/生命周期）
├── src/
│   ├── main.js        主进程：无边框置顶小窗 + 托盘 + 配置轮询
│   ├── preload.js     暴露最小能力给渲染进程（不开放 node）
│   ├── renderer.js    状态条 UI（折叠条 / 展开面板）
│   └── config.js      读 client-config.json（与 macOS 版同一份协议）
└── session/           会话数据读取（与 macOS 版同一套逻辑）
```

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
- [ ] `session/` —— 移植 `swift/Sources/DSHNotch/Core/SessionSource.swift` 的逻辑
- [ ] 事件流解析 + 游标缓存（对应 macOS 版的 `ProjectionCache.swift`）
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
