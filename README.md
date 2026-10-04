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
| 展开态点某一行对话（单会话时点中间正文块） | 跳到 DSH 里的那个对话：DSH 置前 + 该会话标题进剪贴板 |
| 状态变橙（等待人工确认） | 自动展开提醒 |
| 菜单栏波形图标 | 使用说明 / 钉住 / 悬停展开开关 / 空闲自动收起 / 开机自启 / 授予辅助功能权限（自动定位对话） / 定位会话文件 / 导出预览图 / 退出 |

**同时跟随最多 6 个对话。** DSH 并行开多个会话时（本机实测同一分钟有两个在写文件），
折叠态显示最该关注的那个 + 会话数徽标 `⚏ 2/3`，展开态每个对话各占一行，
按「等人工确认 > 执行工具 > 思考 > 已完成 > 待命」排序——任一会话等人确认都会自动展开。

**点一下对话就跳过去。** 点展开态里的某一行 → DSH 被拉到前台，该会话标题进剪贴板，
DSH 里按 `⌘K` 再 `⌘V` 即定位。授予「辅助功能」权限后，`⌘K` 与粘贴会自动完成。
（DSH 只对外注册了 `dsh://open` 一条深链，没有「打开第 N 个对话」的接口，
所以只能这么绕 —— 详见 [`swift/README.md`](./swift/README.md) 的「跳转到对话」。）

安装与自检：

```bash
cd swift
./build.sh install     # 编译 + 打包 + 装到 /Applications 并启动
./build.sh all-tests   # 交互 / 投影 / 多会话 / 跳转 四套自检
./build.sh preview     # 离屏渲染形状预览图（校验形状读起来像不像刘海延伸）
```

详见 [`swift/README.md`](./swift/README.md)。

---

## 📁 插件工程结构

```text
deepisland/
├── dsh.plugin.json          # 插件核心元数据声明（id, version, main）
├── package.json             # 客户端注入与宿主共享模块声明
├── cordis.patch.yml         # DSH Cordis 插件栈自动挂载
├── lib/
│   ├── index.js             # 服务端 Cordis 插件（热配置命名空间注册）
│   └── client.js            # 客户端核心 Bundle（UI、CSS、事件扫描引擎、设置项）
├── test/                    # 零依赖测试套件（Node 断言 + 真实浏览器渲染验证）
└── README.md                # 插件使用与安装文档
```

### 测试

```bash
node test/run.mjs all      # 112 项 Node 断言：状态机、挂载、游标性能、子代理聚合
node test/render-verify.mjs # 33 项真实浏览器断言：计算样式、尺寸、双平台皮肤（产物在 test/.tmp/）
```

两套测试均不依赖任何 npm 包。Node 套件通过桩 `window.__ModuleLoader__` / `document` 拉起插件 factory 并灌入真实事件流；渲染套件用 CDP 驱动本机 Edge/Chrome，加载从 `lib/client.js` 抽取的真实 CSS，断言实际生效的计算样式。

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

### 方式二：通过 DSH 插件包导入器导入

将本文件夹压缩为 `dsh-vibe-island.zip`，在 DSH 的插件管理页面中直接选择「导入插件包」即可。

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

---

## 🛡️ 架构与性能保障

- **零外部运行时依赖**：直接复用宿主环境已注入的 React 18 与微内核总线，体积仅数十 KB。
- **只追加扫描缓存**：按会话 id 保存事件流扫描游标（容量上限 64，超出自动回收），只增量处理最新发生的事件。解析开销与历史长度无关——实测 64000 条事件时每轮仅 0.0004ms，长会话下轮询占用主线程不到 0.1%。
- **子代理零额外数据通道**：内核把子代理实现为独立会话，插件只读客户端已有的会话谱系快照，不新增任何后端请求。
- **沙箱隔离样式**：所有 CSS 类名带有专用命名空间（`vibe-island-*`），不会对 DSH 主题样式产生冲突或污染。
