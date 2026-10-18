# Windows 灵动岛 v2 优化契约

> 本文件是 2026-10-18 全方面优化（动画 / 界面 / 交互 / 性能）的**唯一实现契约**。
> 三个并行工作流（动效样式、主进程运行时、渲染层）都以本文件为准，禁止各自发明结构。
> 基线：`8e2d8c2`，`windows/src` 基线副本在 `%TEMP%\deepisland-baseline-src`。
> 最终交付：`npm test` 507 项全绿、`npm run shots` 六图、`npm run perf` 基线对比、真机冒烟折叠 380x44 / 展开 436x243。

## 0. 优化目标（验收口径）

| 维度 | 目标 | 验证方式 |
| :--- | :--- | :--- |
| 动画 | 真弹簧曲线（对齐 Swift `.spring(response:0.34, dampingFraction:0.8)`）；展开/收起 144Hz 下无长帧；内容分层入场；等待确认有脉冲；思考/工具有流光 | `scripts/perf.js` 帧统计 + 截图 + 样式断言 |
| 界面 | 视觉语言保持 macOS 版同一套（纯黑底、状态色内发光带、外发光、等宽数字）；补齐进度条、图标、层级、空态、焦点态 | `npm run shots` 六张截图逐一目检 |
| 交互 | 悬停展开/钉住/跳转/键盘/右键菜单；点击穿透**永不粘连**；热区跟随岛体 | 单测契约 + 手工冒烟 |
| 性能 | 快照只在真变化时推送且体积 ≤ 基线 40%；渲染层无强制同步布局、无全量 innerHTML；空闲 CPU 显著下降 | `scripts/perf.js` 基线对比 |

**硬约束**：不改 Swift 端源码（本机无法编译验证）；不引入任何运行时依赖；不破坏 `windows/package.json` 的零依赖自检体系。

---

## 1. 文件所有权

| 文件 | 所有者 | 说明 |
| :--- | :--- | :--- |
| `windows/src/styles.css` | **motion-ui** | 全部样式 / 动效 / 响应式 / reduced-motion |
| `windows/src/main.js`、`preload.js`、`src/snapshot.js`(新) | **runtime** | 快照协议、自适应轮询、穿透看门狗、右键菜单、IPC |
| `windows/src/index.html`、`renderer.js` | **lead** | DOM 骨架 + 增量渲染 + 交互状态机 |
| `windows/test/**`、`scripts/perf.js`(新)、`scripts/shots.js`、README/docs | **verify** | 契约测试、性能基线/对比、截图、文档 |

只改自己名下的文件。跨文件需求写进本文件「附录」或直接告诉 lead，不要代改。

---

## 2. DOM 骨架契约（`index.html`，由 lead 落地）

```html
<div id="island" class="island"
     data-mode="compact|hud"      <!-- 紧凑 / 展开 -->
     data-expanded="0|1"          <!-- = data-mode 的布尔镜像，CSS 与测试沿用 -->
     data-live="0|1"              <!-- 主会话 status !== idle -->
     data-status="idle|thinking|tool|waiting|done"
     data-glow="0|1"              <!-- glowEffect 开关 -->
     data-pinned="0|1">
  <div class="island-clip">
    <div class="band" aria-hidden="true"></div>
    <div class="island-body">
      <div id="pinned-hint" class="pinned-hint"></div>

      <div id="compact" class="compact">
        <span id="c-dot" class="dot"></span>
        <span id="c-title" class="title"></span>
        <span id="c-chip" class="chip"></span>
        <span id="c-gauge" class="gauge"></span>
        <span id="c-elapsed" class="gauge elapsed mono"></span>
      </div>

      <div id="hud" class="hud">
        <div class="hdr">
          <span id="h-dot" class="dot"></span>
          <span id="h-badge" class="badge"></span>
          <span id="h-title" class="h-title"></span>
          <span id="h-step" class="h-step mono"></span>
          <span id="h-hint" class="hint"></span>
        </div>
        <div id="pressure" class="pressure"><div id="pressure-fill" class="pressure-fill"></div></div>
        <div id="detail" class="detail"><span id="detail-text" class="detail-text"></span></div>
        <div id="todo" class="todo">
          <span class="todo-ico" aria-hidden="true"></span>
          <span id="todo-cur" class="cur"></span>
          <span id="todo-prog" class="prog mono"></span>
        </div>
        <div id="list" class="list"></div>
        <div id="stats" class="stats"></div>
        <div class="footer">
          <span class="foot-left"><i id="bridge-dot" class="bridge-dot"></i><span id="bridge-text"></span></span>
          <span id="jump" class="jump"></span>
          <span class="link" id="settings-link" data-act="settings">设置</span>
        </div>
      </div>
    </div>
  </div>
</div>
```

**约定**
- 所有节点**一次创建、永不复用 innerHTML 重建**。渲染层只改 `textContent` / class / `style.setProperty`。
- 会话行结构：`.row[data-id]` > `.dot` + `.label` + `.action` + `.tag.mono` + `.elapsed.mono`，`tabindex="-1"`。
- 统计行条目：`.stat[data-key]` > 文本节点 + `b.mono`；槽位固定 6 个（耗时/轮次/工具/输出/上下文/子代理），待办只在待办行。
- 详情块：外层 `#detail` 承担 padding/背景/裁剪，内层 `#detail-text` 承担 `-webkit-line-clamp`（单层 clamp 在 Chromium 152 会把第三行顶部漏进 padding，实测验证）。
- 显隐：渲染层切换 `.is-off` class（CSS: `display:none`），不要用 `hidden` 属性（会被动效打断）。
- 岛体高度**由 `--island-h` 驱动**（见 §6），不要用 `height:auto` 做过场。

---

## 3. CSS 变量契约（renderer 写入方 ← 加粗）

```css
--scale: 1;                 /* 用户缩放，renderer 写 */
--glow: #4E7CFF;            /* 主会话状态色，renderer 写 */
--dot: var(--glow);          /* 单个状态点颜色，renderer 按元素写 inline */
--island-w: 380px;          /* 折叠宽，motion-ui 定义；展开由 [data-expanded] 覆盖 */
--island-h: auto;           /* 岛高，renderer 用 ResizeObserver 写 px */
--spring: linear(...);      /* 弹簧曲线，motion-ui 定义，§6 给定量 */
--spring-ms: 340ms;
--snap: cubic-bezier(.2,.9,.25,1);  /* 内容入场，≈220ms */
--snap-ms: 220ms;
--r-collapsed: 12px; --r-expanded: 20px;
--band-collapsed: 34px; --band-expanded: 48px;
```

不同 `data-status` 只改 `--glow`；所有派生色必须 `color-mix(in srgb, var(--glow) …)` 或 `currentColor`。

---

## 4. 快照协议 v2（runtime 产出，renderer 消费）

`win.webContents.send('island:snapshot', payload)`，payload **禁止**包含：`now`、`activity`、`proj`、`file`、`mtimeMs`、`project`。

```js
{
  v: 2,
  rev: <string>,                 // 内容指纹；未变化时主进程根本不发
  entries: [{
    id, label, shortId,
    status,                      // idle|thinking|tool|waiting|done
    live,                        // status !== 'idle'
    glow, tag, badge,
    elapsedFrom,                 // epoch ms | null；renderer 自己按秒走字
    turnStepText, toolCountText, outputText,
    contextText, contextFraction, contextLevel,   // fraction: 0..1 | null（进度条用）
    todoText, todoDone, todoTotal, todoCurrent,
    subagentText, pendingTools,
    detailText, actionText,
  }],
  config: { scale, glowEffect, expandOnHover, notchEnabled, idleHide, jumpEnabled },
  bridge: { ok, port, pending },
  jump: { kind, brief, at } | null,
  serverNow: <epoch ms>
}
```

- `rev` = 对上述内容（不含 `serverNow`）做稳定序列化后的短哈希；相同则不推送。
- 空闲时主进程轮询降频（见 `nextDelay()`），任何一跳检测到变化立即推送。
- 旧字段 `elapsedText` 可保留在 `entries` 里做兼容（`shots.js` / 旧测试），但 renderer 优先用 `elapsedFrom` 自己算。

---

## 5. 交互契约

| 行为 | 规则 |
| :--- | :--- |
| 悬停展开 | 进入 200ms 后展开，移开 350ms 后收起（保留现有常量，Mac 同档） |
| 钉住 | 点折叠态主行 / 点 HUD 空白 / `Esc` 取消；`data-pinned` 同步 |
| 跳转 | 点详情块、会话行、统计行 |
| 键盘 | HUD 展开时 `↑/↓` 移动行焦点、`Enter` 跳转、`Esc` 取消钉住并收起；焦点行加 `.focused` |
| 右键 | 岛体任意处右键 → 主进程原生菜单（钉住/收起、隐藏、设置、配置目录、退出） |
| 双击 | 折叠态双击主行 → 打开 DSH（`openDsh`） |
| 穿透 | 常态 `setIgnoreMouseEvents(true,{forward:true})`；命中翻转才发 IPC；**离开窗口 / 岛体缩小后必须收回** |
| 热区 | 折叠外扩 8px、展开 4px；`getBoundingClientRect` 只允许在「脏标记 + rAF」路径里调用 |

**穿透永不粘连**（三条防线，缺一不可）：
1. renderer：`pointermove` rAF 节流 + 脏矩形；`mouseleave`；1s 兜底复算；
2. renderer：`transitionend`（width/height）后复算；
3. main：500ms 看门狗，用 `screen.getCursorScreenPoint()` 对比窗口矩形，指针已出窗则强制 `setIgnoreMouseEvents(true)` 并通知 renderer。

---

## 6. 动效契约（motion-ui）

1. **真弹簧**：`--spring` 必须是下面这条（由 SwiftUI 解析式 `response=0.34, damping=0.8` 采样 61 点，过冲 1.5%）：
   ```
   linear(0 0%, 0.0052 1.67%, 0.0196 3.33%, 0.0417 5%, 0.07 6.67%, 0.1034 8.33%, 0.1406 10%, 0.1808 11.67%, 0.2231 13.33%, 0.2666 15%, 0.3109 16.67%, 0.3552 18.33%, 0.3993 20%, 0.4425 21.67%, 0.4848 23.33%, 0.5257 25%, 0.5651 26.67%, 0.6028 28.33%, 0.6387 30%, 0.6727 31.67%, 0.7048 33.33%, 0.7348 35%, 0.763 36.67%, 0.7891 38.33%, 0.8134 40%, 0.8358 41.67%, 0.8564 43.33%, 0.8753 45%, 0.8925 46.67%, 0.9082 48.33%, 0.9223 50%, 0.9351 51.67%, 0.9465 53.33%, 0.9567 55%, 0.9658 56.67%, 0.9738 58.33%, 0.9809 60%, 0.987 61.67%, 0.9924 63.33%, 0.997 65%, 1.0009 66.67%, 1.0042 68.33%, 1.0069 70%, 1.0092 71.67%, 1.011 73.33%, 1.0124 75%, 1.0135 76.67%, 1.0143 78.33%, 1.0148 80%, 1.0151 81.67%, 1.0152 83.33%, 1.0151 85%, 1.0149 86.67%, 1.0145 88.33%, 1.0141 90%, 1.0136 91.67%, 1.013 93.33%, 1.0124 95%, 1.0118 96.67%, 1.0111 98.33%, 1 100%)
   ```
2. 宽度、高度、圆角共用 `--spring-ms var(--spring)`；**禁止 `transition: all`**；**禁止对 `box-shadow`/`filter` 做过渡**（软件渲染下每帧重绘大面积模糊）—— 外发光改用独立伪元素 `opacity` 过渡。
3. 分层入场：展开时 `hdr`(0ms) → `pressure`(20ms) → `detail`(50ms) → `todo`(80ms) → `list`(110ms) → `stats`(140ms) → `footer`(170ms)，每层 `opacity 0→1` + `translateY(3px→0)`，用 `--snap-ms`；收起时全部 0 延迟。
4. 状态动效（受 `data-glow` 门控的纯装饰部分）：
   - 思考：状态点 2.4s 呼吸（scale 1→1.25，透明度微降）；
   - 工具：状态点 1.6s 弹性呼吸 + 内发光带流光（`transform: translateX` 的扫光层，3s 线性循环）；
   - 等待确认：琥珀心跳 1.2s + 外发光脉冲（opacity 0.55→0.9）；
   - 完成：一次性绿色微光（`animation` 仅进入 done 时触发，靠属性变化）；
   - 所有循环动画必须能被 `prefers-reduced-motion: reduce` 完全关闭。
5. 尺寸/圆角/宽度都用 `contain: layout paint` 限制重排范围；`.island-clip { contain: layout paint; }`。
6. 视觉口径不可漂移：纯黑底、底部圆角 12→20、顶部平、状态点 6px、数字 `tabular-nums`、发丝线 `rgba(255,255,255,.08)`、详情正文 `rgb(166,214,255)`。
7. 新增但必须遵守 Mac 语言：上下文压力条（2px，`--glow` 渐变，>50% 琥珀 / >80% 红）、行 hover 反馈（白 13%）、焦点环（`outline: 1px solid color-mix(...)`，仅键盘焦点）。

---

## 7. 性能不变量（测试会按源码断言）

**renderer**
- `render()` 热路径禁止 `offsetHeight` / `offsetWidth` / `getBoundingClientRect()` / `scrollHeight`；
- 禁止 `innerHTML =` 赋值（一次性建骨架除外）；行/统计用 DOM API 增量；
- `pointermove` 只写脏标记 + rAF；1s 本地时钟只改时间文本节点；
- CSS 自定义属性写入前先比较旧值（同值不写）。

**main**
- 快照必须是 DTO（无 `activity`/`proj`/`now`），`rev` 去重；
- `nextDelay()` 自适应：有活跃会话 250ms，全空闲/窗口隐藏 1000ms；
- 穿透看门狗 500ms；不新增常驻高频定时器。

---

## 8. 测试与验证

- 现有契约断言**意图保留、口径随 v2 更新**（本次交付实测 507 项，9 套件）（例如 `snap.config.` 裸取禁令、窗口架构、弹簧时长、发光口径等仍然成立）。
- 新增：快照 DTO/去重/自适应时延单测；渲染层热路径静态断言；动效契约断言（linear 弹簧、无 box-shadow 过渡、reduced-motion、脉冲关键帧）。
- `node windows/scripts/perf.js`：输出 JSON（帧间隔 p50/p95/max、掉帧数、DOM 变更/秒、长任务、渲染进程 CPU、快照字节/秒），支持 `--src <dir>` 对基线目录跑。
- 最终验收：`npm test` 全绿、`npm run shots` 六图目检、`DSH_NOTCH_SMOKE=1` 真数据冒烟、perf 对比表。

## 9. 附录：沟通约定

- 任何契约需要变更，先在共享任务板写到 lead，不自行改契约。
- 改完先自测自己那部分（源码断言可先手动 `node -e` 验证），不要跑全量 `npm test` 抢进度。
- 注释沿用仓库风格：**写「为什么」，不写「做了什么」**，关键取舍要写清反例。
