'use strict';
/**
 * README 截图生成器 —— `npm run shots`。
 *
 * ## 为什么需要它
 *
 * README 里的状态图不能靠「手搓 HTML 冒充」—— 那等于给文档配了一套
 * 平行实现，UI 一改截图就成了假的。这里驱动的是**生产渲染层本身**
 * （`src/index.html` + `src/renderer.js` + `src/styles.css`），
 * 只是把主进程的 `island:snapshot` 换成合成快照：
 * 每个状态（思考 / 执行 / 等待确认 / 多会话 / HUD 展开）各截一张。
 *
 * ## 与冒烟测试的分工
 *
 * - `DSH_NOTCH_SMOKE=1`（main.js 内建）：验**真实数据**下岛能渲染，
 *   截的是当前会话的真实状态 —— 给 CI 用，状态不可控。
 * - 本脚本：状态**可控**，给 README 用。合成快照的字段口径与
 *   `src/snapshot.js` 的 `buildSnapshot()` 逐一对应（v2 DTO），改字段要同步改两边。
 *
 * ## 窗口为什么要 showInactive + opacity 0.02（踩坑记录，勿改）
 *
 * v2 的形变/高度依赖 CSS 过渡，而隐藏窗口（`show:false`）在 Windows 上
 * 会在约 1 秒后把 rAF 节流到 1Hz —— 弹簧和分层入场都不再推进，
 * `capturePage` 截到的是「上一场景的最后画面」，六张图会整体错位一帧。
 * 所以先 `setOpacity(0.02)` 再 `showInactive()`：窗口真的显示（合成器出帧）
 * 但基本透明、不抢焦点。实测之后 rAF 稳定 144Hz（与 perf.js 同一套做法）。
 *
 * ## 高清放大的正确姿势（踩坑记录，勿改）
 *
 * 曾经用快照配置 `scale: 2`（渲染层 `transform: scale(var(--scale))`）
 * 放大岛体截 2x 图 —— **行不通**：`capturePage` 的栅格化路径会丢弃
 * CSS transform，`getBoundingClientRect` 报的是缩放后盒子（760 宽），
 * 绘制却按原尺寸（380 宽），截出来岛体偏小、四周露背景。
 * 实测数据（DPR 1.75 机器）：布局盒 760×88 CSS px，绘制实测 665 device px。
 *
 * 现在的做法：
 * 1. 快照 `scale: 1` —— 布局盒 == 绘制盒 == `getBoundingClientRect`；
 * 2. `force-device-scale-factor=2` 命令行开关强制 DPR=2 —— 捕获
 *    分辨率 = CSS px × 2，且不受显示器缩放影响（本机 175% 会变成 1.75）；
 * 3. `capturePage(rect)` 的 rect 用 CSS px，输出即 rect × DPR device px。
 *
 * 另：`nativeImage` 位图缓冲区是 **BGRA**，逐像素分析时别按 RGBA 读。
 *
 * ## 用法
 *
 * ```bash
 * cd windows && npm run shots     # 产出 docs/screenshots/*.png（2x 高清）
 * ```
 */

const path = require('node:path');
const fs = require('node:fs');

// ── 启动方式自适配（与 scripts/dev.js 同一个坑）──
//
// 很多 Windows 开发者的终端跑在 Electron 应用里，会把 ELECTRON_RUN_AS_NODE=1
// 传进子进程。带着它启动时 require('electron') 返回的是**二进制路径字符串**，
// 拿不到 API。这里检测到是字符串就用这个二进制把自己重启成 Electron 主进程。
let electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [__filename], { stdio: 'inherit', env });
  process.exit(r.status === null ? 1 : r.status);
}
const { app, BrowserWindow, ipcMain } = electron;

/** 离屏窗口尺寸（CSS px）：比最大展开态大一圈，给光晕留绘制空间。 */
const WINDOW_W = 968;
const WINDOW_H = 600;
/** 捕获区在岛体盒外扩的 CSS px —— box-shadow 模糊 14 + y 偏移 3，20 足够包住。 */
const MARGIN = 20;
const SRC = path.join(__dirname, '..', 'src');
const OUT = path.resolve(__dirname, '..', '..', 'docs', 'screenshots');

// ───────────────────────── 合成快照（口径对齐 snapshot.js buildSnapshot） ─────────────────────────

/** v2 config DTO：只有契约 §4 这 6 项，不再有 raw/fileExists。 */
function cfg() {
  return {
    scale: 1,             // 必须是 1：CSS transform 放大在 capturePage 里会被丢弃
    glowEffect: true,
    expandOnHover: true,
    notchEnabled: true,
    idleHide: true,
    jumpEnabled: true,
  };
}

/** 上下文等级口径与 monitor.js / renderer.js 一致：>0.8 红，>0.5 琥珀。 */
function ctxLevel(frac) {
  return frac > 0.8 ? 2 : frac > 0.5 ? 1 : 0;
}

/**
 * 合成 entry：v2 DTO 白名单字段（见 src/snapshot.js 的 ENTRY_FIELDS）。
 * 刻意保留 `elapsedText`：契约 §4 允许它存在，旧读法（含 shots 的文档）兼容。
 */
function entry(o) {
  const now = Date.now();
  const elapsedMs = o.elapsedMs || 0;
  const frac = typeof o.contextFraction === 'number' ? o.contextFraction : null;
  const live = !!o.status && o.status !== 'idle';
  const e = {
    id: o.id || 'session-a1b2c3d4',
    label: o.label,
    shortId: (o.id || 'session-a1b2c3d4').replace(/^session-/, '').slice(0, 8),
    status: o.status,
    live,
    glow: o.glow,
    tag: o.tag,
    badge: o.badge || o.tag,
    turnStepText: o.turnStepText || null,
    toolCountText: o.toolCountText || null,
    outputText: o.outputText || null,
    contextText: o.contextText || null,
    contextFraction: frac,
    contextLevel: frac === null ? 0 : ctxLevel(frac),
    todoText: o.todoText || null,
    todoDone: o.todoDone === undefined ? null : o.todoDone,
    todoTotal: o.todoTotal === undefined ? null : o.todoTotal,
    todoCurrent: o.todoCurrent || null,
    subagentText: o.subagentText || null,
    pendingTools: o.pendingTools || 0,
    detailText: o.detailText || null,
    actionText: o.actionText || null,
  };
  // 只有「有回合起点」的会话才带 elapsedFrom/elapsedText；done 条目在真实数据里
  // turnStartTime=null（inferFromProjection 新建 activity），UI 显示 `--:--`。
  // 这里若给 done 补一个 now，截图会显示 00:00，与真机不一致。
  if (elapsedMs > 0) {
    e.elapsedFrom = now - elapsedMs;
    e.elapsedText = o.elapsedText || null;
  }
  // v2 渲染层按「缺省 = 空/0」读，null/0 的字段不出现在真实 DTO 里。
  // 这里保持同一口径，截图才与线上形状一致。
  for (const k of Object.keys(e)) {
    if (e[k] === null || e[k] === undefined || e[k] === '') delete e[k];
  }
  // pendingTools=0 在真实 DTO 里省略（见 snapshot.js 的 ENTRY_ALWAYS 注释）
  if (e.pendingTools === 0) delete e.pendingTools;
  return e;
}

/** 组装 v2 快照：{v, rev, entries, config, bridge, jump, serverNow}。 */
function snap(name, entries) {
  const content = {
    v: 2,
    entries,
    config: cfg(),
    bridge: { ok: true, port: 47311, pending: 0 },
    jump: null,
  };
  return {
    v: 2,
    // 渲染层按 rev 去重；每个场景的内容不同，rev 必须不同（真实主进程也是这么算的）。
    rev: 'shots-' + name,
    entries: content.entries,
    config: content.config,
    bridge: content.bridge,
    jump: content.jump,
    serverNow: Date.now(),
  };
}

/** 六个场景：三个折叠态 + 三个展开态（HUD）。hover=true 用合成 mousemove 触发悬停展开。 */
const SCENES = [
  {
    name: 'compact-thinking',
    title: '折叠态 · 深度思考中',
    snap: () => snap('compact-thinking', [entry({
      label: 'AlexNet 架构可视化',
      status: 'thinking', tag: 'Thinking', glow: '#4E7CFF',
      actionText: '深度思考中...',
      detailText: '正在分析三通道卷积层的参数量与感受野...',
      elapsedMs: 42_000, elapsedText: '00:42', turnStepText: 'T3·S7',
      toolCountText: '2 次', outputText: '12.4k tok',
      contextText: '32%', contextFraction: 0.32,
    })]),
  },
  {
    name: 'compact-tool',
    title: '折叠态 · 执行工具',
    snap: () => snap('compact-tool', [entry({
      label: 'Music Region 地图模块',
      status: 'tool', tag: 'Executing Tool', glow: '#00D2AA',
      actionText: '执行 edit',
      detailText: 'src/map/TileSource.kt',
      elapsedMs: 8000, elapsedText: '00:08', turnStepText: 'T1·S2',
      toolCountText: '1 次', outputText: '3.1k tok',
      contextText: '18%', contextFraction: 0.18, pendingTools: 1,
    })]),
  },
  {
    name: 'compact-multi',
    title: '折叠态 · 多会话并行',
    snap: () => snap('compact-multi', [
      entry({
        id: 'session-aaaa1111', label: 'AlexNet 架构可视化',
        status: 'thinking', tag: 'Thinking', glow: '#4E7CFF',
        actionText: '深度思考中...', elapsedMs: 42_000, elapsedText: '00:42', turnStepText: 'T3·S7',
        contextText: '32%', contextFraction: 0.32,
      }),
      entry({
        id: 'session-bbbb2222', label: 'Music Region 地图模块',
        status: 'tool', tag: 'Executing Tool', glow: '#00D2AA',
        actionText: '执行 edit', detailText: 'src/map/TileSource.kt',
        elapsedMs: 8000, elapsedText: '00:08', turnStepText: 'T1·S2',
        contextText: '18%', contextFraction: 0.18, pendingTools: 1,
      }),
      entry({
        id: 'session-cccc3333', label: '盐碱地决策系统',
        status: 'done', tag: 'Done', glow: '#4ADE80',
        actionText: '任务已完成', turnStepText: 'T5·S12',
      }),
    ]),
  },
  {
    name: 'hud-thinking',
    title: '展开态 · 单会话 HUD（悬停展开）',
    hover: true,
    snap: () => snap('hud-thinking', [entry({
      label: 'AlexNet 架构可视化',
      status: 'thinking', tag: 'Thinking', glow: '#4E7CFF',
      actionText: '深度思考中...',
      detailText: '先按 224×224 输入反推各层特征图尺寸，再核对原论文参数量：conv1 是 11×11×3×96，stride 4，这一层就占了三成以上参数，可视化时要把这一层的权重热图画出来。',
      elapsedMs: 42_000, elapsedText: '00:42', turnStepText: 'T3·S7',
      toolCountText: '2 次', outputText: '12.4k tok',
      contextText: '32%', contextFraction: 0.32,
      todoText: '2/5', todoDone: 2, todoTotal: 5, todoCurrent: '补齐训练曲线渲染',
    })]),
  },
  {
    name: 'hud-tool',
    title: '展开态 · 工具执行中（悬停展开）',
    hover: true,
    snap: () => snap('hud-tool', [entry({
      label: 'Music Region 地图模块',
      status: 'tool', tag: 'Executing Tool', glow: '#00D2AA',
      actionText: '执行 run_code',
      detailText: 'const layers = await tools.glob({ pattern: "src/map/**/*.kt" }); console.log(layers);',
      elapsedMs: 8000, elapsedText: '00:08', turnStepText: 'T1·S2',
      toolCountText: '1 次', outputText: '3.1k tok',
      contextText: '18%', contextFraction: 0.18, pendingTools: 1,
      todoText: '1/3', todoDone: 1, todoTotal: 3, todoCurrent: '天地图瓦片源切换',
    })]),
  },
  {
    // 等待确认会自动展开（renderer.js shouldExpand）—— 不用合成悬停
    name: 'hud-multi',
    title: '展开态 · 多会话列表（等待确认自动展开）',
    snap: () => snap('hud-multi', [
      entry({
        id: 'session-cccc3333', label: '盐碱地决策系统',
        status: 'waiting', tag: 'Action Required', glow: '#FFAA00',
        actionText: '等待人工确认',
        detailText: '提问: 是否用新一批采样数据覆盖现有施肥模型？',
        elapsedMs: 3000, elapsedText: '00:03', turnStepText: 'T2·S4',
        toolCountText: '1 次',
        contextText: '61%', contextFraction: 0.61, pendingTools: 1,
      }),
      entry({
        id: 'session-bbbb2222', label: 'Music Region 地图模块',
        status: 'tool', tag: 'Executing Tool', glow: '#00D2AA',
        actionText: '执行 edit', detailText: 'src/map/TileSource.kt',
        elapsedMs: 8000, elapsedText: '00:08', turnStepText: 'T1·S2',
        contextText: '18%', contextFraction: 0.18,
      }),
      entry({
        id: 'session-aaaa1111', label: 'AlexNet 架构可视化',
        status: 'done', tag: 'Done', glow: '#4ADE80',
        actionText: '任务已完成', turnStepText: 'T3·S7',
        contextText: '67%', contextFraction: 0.67,
      }),
    ]),
  },
];

// ───────────────────────── 截图流程 ─────────────────────────

/** 桌面感渐变背景：注入 body，让光晕与亚克力质感有东西可衬。 */
const BACKDROP = `
  html, body {
    background: linear-gradient(160deg, #2a2f38 0%, #171a21 52%, #0b0d11 100%) !important;
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureIsland(win) {
  return win.webContents.executeJavaScript(`(() => {
    const i = document.getElementById('island');
    const r = i.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio };
  })()`);
}

async function shootScene(win, scene) {
  // 1. 推合成快照（renderer.js 的 onSnapshot 会立刻重画；rev 每个场景不同）
  win.webContents.send('island:snapshot', scene.snap());
  await sleep(700);   // 跨过 340ms 宽/高/圆角弹簧 + 140ms 模式交叉淡化

  // 2. 悬停展开：合成 mousemove 落到岛心（穿透窗口只认转发事件，同冒烟测试）
  if (scene.hover) {
    const box = await measureIsland(win);
    const cx = Math.round(box.x + box.w / 2);
    const cy = Math.round(box.y + box.h / 2);
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${cx}, clientY: ${cy} }))`);
    await sleep(250);   // 跨过 200ms 驻留门槛
    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${cx}, clientY: ${cy + 6} }))`);
    await sleep(800);   // 等 340ms 高度弹簧 + 170ms 分层入场走完
  }

  // 3. 量岛体实际矩形，外扩 MARGIN 圈住光晕，按窗口边界钳制后裁剪截图
  const box = await measureIsland(win);
  const x0 = Math.max(0, Math.round(box.x - MARGIN));
  const y0 = Math.max(0, Math.round(box.y - MARGIN));
  const x1 = Math.min(box.innerW, Math.round(box.x + box.w + MARGIN));
  const y1 = Math.min(box.innerH, Math.round(box.y + box.h + MARGIN));
  const rect = {
    x: x0, y: y0,
    width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0),
  };
  const img = await win.webContents.capturePage(rect);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, scene.name + '.png');
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log('[shots] ' + scene.name + '.png  ' + size.width + 'x' + size.height
    + ' (dpr ' + box.dpr + ')  ' + kb + ' KB  — ' + scene.title);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
// 强制 DPR=2：捕获分辨率恒定 2x，不受显示器缩放影响（本机 175% → DPR 1.75）
app.commandLine.appendSwitch('force-device-scale-factor', '2');

app.whenReady().then(async () => {
  // 岛在真实环境里点的每个 IPC 都要有回应（渲染层的 invoke 才不报未处理）
  for (const ch of ['island:set-interactive', 'island:jump', 'island:open-dsh',
    'island:open-config-dir', 'island:context-menu', 'island:notify',
    'island:hide', 'island:show', 'island:quit', 'island:toggle-notch']) {
    ipcMain.handle(ch, () => true);
  }

  const win = new BrowserWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  await win.loadFile(path.join(SRC, 'index.html'));
  await win.webContents.insertCSS(BACKDROP);
  // 必须真的 show 出来（几乎透明、不抢焦点）：隐藏窗口 ~1s 后 rAF 被节流到
  // 1Hz，弹簧/入场动画不推进，截到的是上一场景的画面（见文件头踩坑记录）。
  win.setOpacity(0.02);
  win.showInactive();
  await sleep(700);   // 等渲染层订阅 onSnapshot + 首帧

  for (const scene of SCENES) {
    await shootScene(win, scene);
  }

  console.log('[shots] 完成 → ' + OUT);
  app.exit(0);
}).catch((e) => {
  console.error('[shots] 失败:', e);
  app.exit(1);
});
