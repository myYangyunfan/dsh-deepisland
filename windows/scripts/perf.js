'use strict';
/**
 * 渲染层性能基准 —— `node scripts/perf.js [--src <dir>] [--out <json>] [--label <name>]`。
 *
 * ## 为什么要有它
 *
 * 「动画更顺、CPU 更低」这类优化必须能被**重复测量**，否则每次都是感觉。
 * 本脚本驱动的是**生产渲染层本身**（`src/index.html` + `renderer.js` + `styles.css`），
 * 只把主进程那一侧换成可控的合成快照 —— 和 `scripts/shots.js` 同一个思路，
 * 区别是这里要的是数字不是图。
 *
 * 它能测的：
 * - rAF 帧间隔 p50/p95/p99/max、掉帧数（> 2×p50）、名义帧率；
 * - `PerformanceObserver` 的 longtask 数量与总时长（主线程卡顿，肉眼可见的掉帧来源）；
 * - `MutationObserver` 的 DOM 变更/秒（structural 单独计数：childList/attributes，
 *   排除本地秒级时钟的 characterData 文本更新）；
 * - 渲染进程 CPU%（`webContents.getOSProcessId()` + `app.getAppMetrics()`）；
 * - 每次推送的快照 JSON 字节数与推送次数/秒；
 * - 「同一 rev 连推 8 次」去重探针：结构变更数 + 这段的 CPU
 *   （模拟「内容没变、主进程还在发」；v1 每拍整树重建，v2 应当跳过）。
 *
 * ## 为什么窗口是「几乎不可见地 show」而不是 show:false（踩坑，勿改）
 *
 * 隐藏窗口（`show:false`）在 Windows 上 rAF 只会正常跑约 1 秒，之后被节流到
 * **1Hz**（实测帧间隔稳定 1006.9ms，肉眼看不出来但会把 p95/max 全污染）。
 * 所以测量窗口必须先 `setOpacity(0.02)` 再 `showInactive()`：真的显示、
 * 但不抢焦点、基本透明，rAF 稳定跑满刷新率（本机 240Hz 实测）。
 *
 * 另一个坑：`webContents.getProcessId()` 在这个窗口上返回 5（内部 id），
 * 用它去 `app.getAppMetrics()` 里找不到对应进程，CPU 恒为 0；
 * 要用 `webContents.getOSProcessId()` 才能对上 `type: 'Tab'` 那条。
 *
 * 它**测不了**的（别拿这里的数字冒充）：
 * - 主进程轮询/文件读取的 CPU（只测渲染进程）；
 * - DWM 合成开销与真实透明窗口在真实合成器上的表现 —— 这里软件渲染，
 *   绝对帧率与真机不同，**只有同一台机器、同一显示模式下的 before/after 对比有意义**；
 * - v2 `rev` 去重带来的真实推送降频：合成快照是直接 `send` 的，绕过了主进程去重；
 *   去重探针只能模拟「重复发同一拍」，协议本身由 `test/snapshot.test.js` 断言。
 *
 * ## 快照口径（同一个脚本测新旧两版）
 *
 * 按被测 src 自动判定版本，生成**该版本真实 DTO 形状**的合成快照：
 *
 * - v1（`8e2d8c2`，没有 `snapshot.js`）：沿用当时 `main.js` 的 `snapshot()`
 *   + `monitor.decorate()` 形状 —— `now`、`config.raw`、每个 entry 的
 *   `file`/`project`/`mtimeMs`/`activity`（含整个投影对象）。当时协议就是这样，
 *   字节数也是那时真实发的量级。
 * - v2（有 `snapshot.js` / 新 DOM）：契约 §4 的 DTO —— `v`/`rev`/`serverNow`，
 *   entry 只留渲染需要的字段，不再有 `activity`/`proj`/`file`/`mtimeMs`/`project`。
 *
 * 两个版本都额外带上 `elapsedText`（旧渲染层读）和 `elapsedFrom`（新渲染层
 * 自己按秒走字），所以同一份脚本对两代 renderer 都能渲染，字节对比则反映
 * 的是两代**协议**的体积差，不是某份真实 DSH 数据的绝对大小。
 *
 * ## 测量流程（每次运行都一样，才能比）
 *
 * 1. 载入被测 src，stub 掉 preload 里所有 invoke 通道；
 * 2. 注入 rAF / longtask / 变更观察器，预热 300ms 后清零；
 * 3. 4s 内按 250ms 节奏推合成快照（单会话 → 多会话 → 等待确认）；
 *    期间用合成指针触发展开→收起，把形变动画也纳入帧统计；
 * 4. 主统计窗口一到就冻结数字，再补两个去重探针：
 *    ① 活跃多会话快照同 rev 连推 8 次（v1 整树重建 vs v2 跳过）；
 *    ② 切到全空闲快照（无循环动画）后同 rev 连推 8 次 —— 这段的 CPU
 *       才是「内容没变、渲染进程还在烧」的真实空闲成本。最后读回算表。
 *
 * ## 用法
 *
 * ```bash
 * cd windows
 * node scripts/perf.js                                  # 测当前 src，表格打屏
 * node scripts/perf.js --src "%TEMP%\\deepisland-baseline-src" --label baseline --out scripts/perf-baseline.json
 * ```
 */

const path = require('node:path');
const fs = require('node:fs');

// ── 启动方式自适配（与 scripts/shots.js / scripts/dev.js 同一个坑）──
//
// 宿主终端会把 ELECTRON_RUN_AS_NODE=1 传进来，带着它 require('electron')
// 返回的是二进制路径字符串。检测到字符串就用 Electron 二进制把自己重启成
// 主进程 —— 参数必须原样转发，否则 --src/--out 会丢。
let electron = require('electron');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(r.status === null ? 1 : r.status);
}
const { app, BrowserWindow, ipcMain, screen } = electron;

// ───────────────────────────── 参数 ─────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

const SRC = path.resolve(arg('--src', path.join(__dirname, '..', 'src')));
const OUT = arg('--out', null) ? path.resolve(arg('--out')) : null;
const LABEL = arg('--label', path.basename(SRC));
const DURATION_MS = Math.max(1000, Number(arg('--duration', 4000)) || 4000);
/** 推送节奏：与主进程活跃态轮询同一个值（250ms 是「跟手」与「不烧 CPU」的交点）。 */
const TICK_MS = 250;
const WARMUP_MS = 300;

/** 真实窗口比岛大一圈（bleed 给外发光）。优先读被测 main.js 的常量，保证同口径。 */
function maxWindowSize() {
  try {
    const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
    const m = /const MAX_WINDOW = \{ w: (\d+), h: (\d+) \}/.exec(main);
    if (m) return { w: Number(m[1]), h: Number(m[2]) };
  } catch { /* 落到默认 */ }
  return { w: 484, h: 300 };
}

/**
 * 版本判定：v2 的标志是独立的 `snapshot.js`（契约 §4 要求纯函数模块），
 * 或新 DOM 骨架（`#compact`/`#hud`）。两者任一成立就按 v2 DTO 生成快照。
 */
function isV2() {
  if (fs.existsSync(path.join(SRC, 'snapshot.js'))) return true;
  try {
    const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
    return /id="compact"/.test(html) || /id="hud"/.test(html);
  } catch { return false; }
}

function gitHead() {
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SRC, encoding: 'utf8' });
    return (r.stdout || '').trim() || null;
  } catch { return null; }
}

// ───────────────────────── 合成快照（覆盖三种真实形态） ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();

/**
 * 三种场景按 tick 轮换，模拟真实主进程的推送节奏：
 *   0.0–1.5s 单会话思考 → 1.5–2.5s 多会话并行 → 2.5–4.0s 等待人工确认。
 * 每个 tick 都改一点内容（工具数/输出/上下文压力），否则 v2 的 rev 会判定
 * 「无变化」，测出来的就不是有活干时的渲染成本了。
 */
function sceneAt(tick) {
  const phase = tick < 6 ? 'single' : (tick < 10 ? 'multi' : 'waiting');
  return { phase, tick };
}

function baseEntry(o) {
  const now = nowMs();
  return {
    id: o.id,
    label: o.label,
    shortId: o.id.replace(/^session-/, '').slice(0, 8),
    status: o.status,
    live: o.status !== 'idle',
    glow: o.glow,
    tag: o.tag,
    badge: o.tag,
    // 两个字段都给：旧 renderer 读 elapsedText，新 renderer 用 elapsedFrom 本地走字
    elapsedFrom: now - o.elapsedMs,
    elapsedText: String(Math.floor((o.elapsedMs || 0) / 60000)).padStart(2, '0') + ':' +
      String(Math.floor((o.elapsedMs || 0) / 1000) % 60).padStart(2, '0'),
    turnStepText: o.turnStepText || null,
    toolCountText: o.toolCountText || null,
    outputText: o.outputText || null,
    contextText: o.contextText || null,
    contextFraction: typeof o.contextFraction === 'number' ? o.contextFraction : null,
    contextLevel: o.contextLevel || 0,
    todoText: o.todoText || null,
    todoDone: o.todoDone === undefined ? null : o.todoDone,
    todoTotal: o.todoTotal === undefined ? null : o.todoTotal,
    todoCurrent: o.todoCurrent || null,
    subagentText: o.subagentText || null,
    pendingTools: o.pendingTools || 0,
    detailText: o.detailText || null,
    actionText: o.actionText || null,
  };
}

/** v1（8e2d8c2）真实 DTO：entry 里带着文件/项目/mtime 与整个 activity（含投影）。 */
function v1Entry(o) {
  const e = baseEntry(o);
  const now = nowMs();
  e.file = 'C:\\Users\\dev\\.dsh\\sessions\\projects\\proj-' + e.shortId + '\\' + e.id + '\\session.v4.jsonl.zstd';
  e.project = 'D:\\workspace\\demo-' + e.shortId.slice(0, 4);
  e.mtimeMs = now;
  e.activity = {
    status: o.status,
    tag: o.tag,
    title: o.actionText || o.tag,
    detail: o.detailText || '',
    currentTool: null,
    turn: 3, step: 7, toolCount: 2, pendingAgents: 0,
    turnStartTime: now - (o.elapsedMs || 0),
    proj: {
      version: 1, title: o.label, todoTotal: 5, todoDone: 2, todoCurrent: o.todoCurrent || '',
      outputTokens: 12400, contextUsed: 32000, contextLimit: 100000,
      openStep: null, pendingCalls: {},
      updatedAt: now,
    },
    cursor: { seq: 42, lastEventTime: now, toolCount: 2 },
  };
  return e;
}

/** v2 契约 §4 DTO：只留渲染需要的字段，一个字节都不多带。 */
function v2Entry(o) {
  return baseEntry(o);
}

/** 稳定序列化 + 短哈希：v2 的 `rev` 语义（内容指纹，不含 serverNow）。 */
function revOf(obj) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

/** 每个 tick 的合成快照。v1/v2 各自形状，scene 内容一致。 */
function makeSnapshot(tick, v2) {
  const s = sceneAt(tick);
  const base = tick * TICK_MS;
  const elapsed = (n) => 42000 + base + n;
  const toolN = 2 + Math.floor(tick / 2);
  const outTokens = 12400 + tick * 137;

  const entries = [];
  if (s.phase === 'single') {
    entries.push({
      id: 'session-a1b2c3d4',
      label: 'AlexNet 架构可视化',
      status: 'thinking', glow: '#4E7CFF', tag: 'Thinking',
      elapsedMs: elapsed(0), turnStepText: 'T3·S7',
      toolCountText: toolN + ' 次', outputText: outTokens + ' tok',
      contextText: (32 + tick) + '%', contextFraction: (32 + tick) / 100, contextLevel: 0,
      todoText: '2/5', todoDone: 2, todoTotal: 5, todoCurrent: '补齐训练曲线渲染',
      detailText: '正在分析三通道卷积层的参数量与感受野（第 ' + tick + ' 拍）',
      actionText: '深度思考中...',
    });
  } else if (s.phase === 'multi') {
    entries.push({
      id: 'session-aaaa1111', label: 'AlexNet 架构可视化',
      status: 'thinking', glow: '#4E7CFF', tag: 'Thinking',
      elapsedMs: elapsed(0), turnStepText: 'T3·S7',
      toolCountText: toolN + ' 次', outputText: outTokens + ' tok',
      contextText: '41%', contextFraction: 0.41, contextLevel: 0,
      todoText: '2/5', todoDone: 2, todoTotal: 5, todoCurrent: '补齐训练曲线渲染',
      detailText: '核对 conv1 权重热图（第 ' + tick + ' 拍）', actionText: '深度思考中...',
    });
    entries.push({
      id: 'session-bbbb2222', label: 'Music Region 地图模块',
      status: 'tool', glow: '#00D2AA', tag: 'Executing Tool',
      elapsedMs: elapsed(12000), turnStepText: 'T1·S2',
      toolCountText: '1 次', outputText: '3100 tok',
      contextText: '18%', contextFraction: 0.18, contextLevel: 0,
      todoText: '1/3', todoDone: 1, todoTotal: 3, todoCurrent: '天地图瓦片源切换',
      detailText: 'const layers = await tools.glob({ pattern: "src/map/**/*.kt" }); // ' + tick,
      actionText: '执行 run_code', pendingTools: 1,
    });
    entries.push({
      id: 'session-cccc3333', label: '盐碱地决策系统',
      status: 'done', glow: '#4ADE80', tag: 'Done',
      elapsedMs: elapsed(18000), turnStepText: 'T5·S12',
      contextText: '67%', contextFraction: 0.67, contextLevel: 1,
      detailText: '任务已完成', actionText: '任务已完成',
    });
  } else {
    entries.push({
      id: 'session-cccc3333', label: '盐碱地决策系统',
      status: 'waiting', glow: '#FFAA00', tag: 'Action Required',
      elapsedMs: 3000 + base, turnStepText: 'T2·S4',
      toolCountText: '1 次', contextText: '61%', contextFraction: 0.61, contextLevel: 1,
      detailText: '提问: 是否用新一批采样数据覆盖现有施肥模型？（第 ' + tick + ' 拍）',
      actionText: '等待人工确认', pendingTools: 1,
    });
    entries.push({
      id: 'session-bbbb2222', label: 'Music Region 地图模块',
      status: 'tool', glow: '#00D2AA', tag: 'Executing Tool',
      elapsedMs: elapsed(8000), turnStepText: 'T1·S2',
      toolCountText: toolN + ' 次', outputText: outTokens + ' tok',
      contextText: '18%', contextFraction: 0.18, contextLevel: 0,
      todoText: '1/3', todoDone: 1, todoTotal: 3, todoCurrent: '天地图瓦片源切换',
      detailText: 'src/map/TileSource.kt', actionText: '执行 edit',
    });
  }

  if (!v2) {
    return {
      now: nowMs(),
      entries: entries.map(v1Entry),
      config: {
        notchEnabled: true, jumpEnabled: true, idleHide: true,
        scale: 1, fileExists: true,
        raw: { glowEffect: true, expandOnHover: true, notchEnabled: true, jumpEnabled: true, idleHide: true },
      },
      bridge: { ok: true, port: 47311, plugin: 'dsh-vibe-island', pending: 0 },
      jump: null,
    };
  }

  const content = {
    entries: entries.map(v2Entry),
    config: { scale: 1, glowEffect: true, expandOnHover: true, notchEnabled: true, idleHide: true, jumpEnabled: true },
    bridge: { ok: true, port: 47311, pending: 0 },
    jump: null,
  };
  return {
    v: 2,
    rev: revOf(content),
    entries: content.entries,
    config: content.config,
    bridge: content.bridge,
    jump: content.jump,
    serverNow: nowMs(),
  };
}

/**
 * 全空闲快照：一个 status=idle 的会话，没有任何 live/动画状态。
 *
 * 用来模拟「所有会话都待命、内容没变、主进程却还在发同一拍」的空闲态。
 * 这个状态没有任何循环动画，两代渲染层都不该有持续开销 —— 它才能干净地
 * 区分「v1 每拍重建整树」与「v2 按 rev 跳过」。
 */
function makeIdleSnapshot(v2) {
  const one = { id: 'session-idle0001', label: 'DSH 待命', status: 'idle', glow: '#50505A', tag: 'Ready' };
  if (!v2) {
    return {
      now: nowMs(),
      entries: [v1Entry(one)],
      config: {
        notchEnabled: true, jumpEnabled: true, idleHide: true,
        scale: 1, fileExists: true,
        raw: { glowEffect: true, expandOnHover: true },
      },
      bridge: { ok: true, port: 47311, plugin: 'dsh-vibe-island', pending: 0 },
      jump: null,
    };
  }
  const content = {
    entries: [v2Entry(one)],
    config: { scale: 1, glowEffect: true, expandOnHover: true, notchEnabled: true, idleHide: true, jumpEnabled: true },
    bridge: { ok: true, port: 47311, pending: 0 },
    jump: null,
  };
  return {
    v: 2,
    rev: revOf(content),
    entries: content.entries,
    config: content.config,
    bridge: content.bridge,
    jump: content.jump,
    serverNow: nowMs(),
  };
}

// ───────────────────────── 页面内插桩 ─────────────────────────

/**
 * 一次注入，全部在页面里做：rAF 时间戳、longtask、DOM 变更（structural 单列）、
 * data-expanded 翻转。`reset()` 在预热后调用，保证统计窗口内没有载入/订阅抖动。
 *
 * structural 只算 childList/attributes：本地秒级时钟的 textContent 更新是
 * characterData，一条 100% 正确的去重下也可能每 1s 出现一条 —— 把时钟噪声
 * 与「渲染层真的重画了」分开，去重探针才测得准。
 */
const INSTRUMENT = `(() => {
  const p = {
    frames: [], longtasks: [], mutations: 0, structural: 0,
    childListMutations: 0, attrMutations: 0,
    expand: [], errors: [], running: true,
  };
  window.__perf = p;
  const loop = (ts) => {
    p.frames.push(ts);
    if (p.running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  try {
    p.po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) p.longtasks.push({ start: e.startTime, dur: e.duration });
    });
    p.po.observe({ entryTypes: ['longtask'] });
  } catch (e) { p.errors.push('longtask: ' + (e && e.message)); }

  const island = document.getElementById('island');
  p.lastExpanded = island ? (island.dataset.expanded || '') : '';

  p.mo = new MutationObserver((recs) => {
    p.mutations += recs.length;
    for (const r of recs) {
      if (r.type === 'childList') { p.structural += 1; p.childListMutations += 1; }
      else if (r.type === 'attributes') { p.structural += 1; p.attrMutations += 1; }
    }
  });
  p.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  if (island) {
    p.moIsland = new MutationObserver(() => {
      const v = island.dataset.expanded || '';
      if (v !== p.lastExpanded) { p.lastExpanded = v; p.expand.push({ t: performance.now(), v }); }
    });
    p.moIsland.observe(island, { attributes: true, attributeFilter: ['data-expanded'] });
  }

  p.reset = () => {
    p.frames.length = 0;
    p.longtasks.length = 0;
    p.mutations = 0;
    p.structural = 0;
    p.childListMutations = 0;
    p.attrMutations = 0;
    p.expand.length = 0;
    p.lastExpanded = island ? (island.dataset.expanded || '') : '';
    p.t0 = performance.now();
  };
  return true;
})()`;

/** 不停止采集的读回：主统计窗口用，之后的去重探针不污染帧/DOM 数。 */
const SNAPSHOT_READ = `(() => {
  const p = window.__perf;
  return {
    frames: p.frames.slice(),
    longtasks: p.longtasks.slice(),
    mutations: p.mutations,
    structural: p.structural,
    childListMutations: p.childListMutations,
    attrMutations: p.attrMutations,
    expand: p.expand.map((x) => ({ t: x.t, v: x.v })),
    errors: p.errors.slice(),
  };
})()`;

/** 停止采集并读回；断开 observer，返回纯数据。 */
const READBACK = `(() => {
  const p = window.__perf;
  p.running = false;
  if (p.po) p.po.disconnect();
  if (p.mo) p.mo.disconnect();
  if (p.moIsland) p.moIsland.disconnect();
  return {
    frames: p.frames.slice(),
    longtasks: p.longtasks.slice(),
    mutations: p.mutations,
    structural: p.structural,
    childListMutations: p.childListMutations,
    attrMutations: p.attrMutations,
    expand: p.expand.map((x) => ({ t: x.t, v: x.v })),
    errors: p.errors.slice(),
  };
})()`;

/** 合成指针移动：pointermove + mousemove 都发（新渲染层两路都收，旧版用 mousemove）。 */
async function movePointer(win, x, y) {
  await win.webContents.executeJavaScript(`(() => {
    const o = { bubbles: true, cancelable: true, clientX: ${Math.round(x)}, clientY: ${Math.round(y)}, view: window };
    document.body.dispatchEvent(new PointerEvent('pointermove', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, o)));
    document.body.dispatchEvent(new MouseEvent('mousemove', o));
    return true;
  })()`);
}

async function islandRect(win) {
  return win.webContents.executeJavaScript(`(() => {
    const i = document.getElementById('island');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             expanded: i.dataset.expanded, mode: i.dataset.mode };
  })()`);
}

// ───────────────────────── 统计工具 ─────────────────────────

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

function summarize(raw, meta) {
  const deltas = [];
  for (let i = 1; i < raw.frames.length; i++) {
    const d = raw.frames[i] - raw.frames[i - 1];
    // 丢掉非正间隔与「观测器被暂停」这种超大空洞（系统休眠/窗口被节流时会
    // >1s），后者不可能是动画帧，混进分位数只会污染统计。
    if (d > 0 && d < 1000) deltas.push(d);
  }
  const sorted = deltas.slice().sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const p99 = quantile(sorted, 0.99);
  const max = sorted.length ? sorted[sorted.length - 1] : 0;
  const dropped = p50 > 0 ? sorted.filter((d) => d > 2 * p50).length : 0;

  const ltTotal = raw.longtasks.reduce((a, x) => a + x.dur, 0);
  const ltMax = raw.longtasks.reduce((a, x) => Math.max(a, x.dur), 0);
  const durationSec = meta.durationMs / 1000;

  return {
    frames: {
      count: deltas.length,
      p50: round(p50),
      p95: round(p95),
      p99: round(p99),
      max: round(max),
      fpsNominal: p50 > 0 ? round(1000 / p50, 1) : null,
      dropped,
      droppedPct: deltas.length ? round((dropped / deltas.length) * 100) : 0,
      longFrames16ms: sorted.filter((d) => d > 16.7).length,
    },
    longtask: {
      count: raw.longtasks.length,
      totalMs: round(ltTotal),
      maxMs: round(ltMax),
    },
    mutations: {
      records: raw.mutations,
      perSec: round(raw.mutations / durationSec, 1),
      structuralPerSec: round(raw.structural / durationSec, 1),
    },
    expand: {
      transitions: raw.expand.length,
      timeline: raw.expand.map((x) => ({ t: round(x.t - (raw.frames[0] || 0), 0), v: x.v })),
    },
    errors: raw.errors,
  };
}

/** 主进程侧 CPU 采样：`percentCPUUsage` 是「自上次调用以来」的占比。 */
function cpuSnapshot(pid) {
  const m = app.getAppMetrics().find((x) => x.pid === pid);
  return m && m.cpu ? m.cpu.percentCPUUsage : null;
}

function summarizeCpu(samples) {
  const v = samples.filter((x) => typeof x === 'number');
  // 第 0 个采样跨了预热/第一次推送，不算进均值（峰值仍保留，反映瞬时尖峰）
  const body = v.length > 2 ? v.slice(1) : v;
  const avg = body.length ? body.reduce((a, b) => a + b, 0) / body.length : 0;
  return { samples: v.length, avgPercent: round(avg), peakPercent: round(Math.max(0, ...v)) };
}

// ───────────────────────── 主流程 ─────────────────────────

function printTable(r) {
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  const rows = [
    ['帧 p50 (ms)', r.frames.p50, 'rAF 间隔中位数'],
    ['帧 p95 (ms)', r.frames.p95, '95% 的帧间隔不超过'],
    ['帧 p99 (ms)', r.frames.p99, ''],
    ['帧 max (ms)', r.frames.max, '最长一帧'],
    ['名义帧率 (fps)', r.frames.fpsNominal, '1000 / p50'],
    ['掉帧数 (>2×p50)', r.frames.dropped, '占 ' + r.frames.droppedPct + '%'],
    ['longtask 次数', r.longtask.count, '主线程 >50ms 任务'],
    ['longtask 总时长 (ms)', r.longtask.totalMs, '最长 ' + r.longtask.maxMs + 'ms'],
    ['DOM 变更/秒', r.mutations.perSec, '共 ' + r.mutations.records + ' 条（结构变更 ' + r.mutations.structuralPerSec + '/秒）'],
    ['渲染进程 CPU 均值 (%)', r.cpu.avgPercent, '峰值 ' + r.cpu.peakPercent + '%'],
    ['快照字节/次', r.snapshot.avgBytes, '最大 ' + r.snapshot.maxBytes],
    ['快照字节/秒', r.snapshot.bytesPerSec, ''],
    ['推送次数/秒', r.snapshot.perSec, '共 ' + r.snapshot.count + ' 次'],
    ['重复 rev 的结构变更', r.dedupe.structuralMutations,
      '同 rev 连推 ' + r.dedupe.duplicatePushes + ' 次（childList ' + r.dedupe.childListMutations +
      ' / attributes ' + r.dedupe.attributeMutations + '；全部变更 ' + r.dedupe.domMutations + '，含时钟文本）'],
    ['重复 rev 时 CPU 均值 %', r.dedupe.cpu.avgPercent, '峰值 ' + r.dedupe.cpu.peakPercent + '%（模拟「内容没变还在发」）'],
    ['空闲同 rev 结构变更', r.idleDedupe.structuralMutations,
      '同 rev 连推 ' + r.idleDedupe.duplicatePushes + ' 次（childList ' + r.idleDedupe.childListMutations +
      ' / attributes ' + r.idleDedupe.attributeMutations + '）'],
    ['空闲同 rev 时 CPU 均值 %', r.idleDedupe.cpu.avgPercent, '峰值 ' + r.idleDedupe.cpu.peakPercent + '%（无循环动画的真空闲态）'],
    ['展开翻转次数', r.expand.transitions, r.expand.timeline.map((x) => x.t + 'ms:' + x.v).join(' ')],
  ];
  console.log('\n[perf] ' + r.label + '  src=' + r.src + '  ' + r.durationMs + 'ms  ' +
    (r.version === 2 ? 'v2 DTO' : 'v1 历史 DTO') + '  window=' + r.window.width + 'x' + r.window.height +
    '  display=' + (r.displayHz || '?') + 'Hz');
  console.log('─'.repeat(72));
  for (const [k, v, note] of rows) console.log('  ' + pad(k, 22) + pad(v, 14) + (note || ''));
  console.log('─'.repeat(72));
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');

app.whenReady().then(async () => {
  const version = isV2() ? 2 : 1;
  const winSize = maxWindowSize();

  // stub 掉 preload 用到的所有 invoke 通道：真实环境里每个点击都有回应，
  // 这里不 stub 的话 renderer 的 setInteractive/jump 会一路 reject。
  try {
    const preloadText = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');
    const re = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
    let m;
    const stubs = {
      'island:jump': () => ({ kind: 'bridged', isSuccess: true, brief: '已切到该对话' }),
      'island:open-dsh': () => ({ ok: true, how: 'stub' }),
    };
    while ((m = re.exec(preloadText))) ipcMain.handle(m[1], stubs[m[1]] || (() => true));
  } catch (e) {
    console.error('[perf] 读 preload 失败:', e && e.message);
  }

  const win = new BrowserWindow({
    width: winSize.w,
    height: winSize.h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    resizable: false,
    show: false,            // 先不显示：载入完成后再用 opacity 0.02 显示（见文件头踩坑记录）
    webPreferences: {
      preload: path.join(SRC, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,   // 隐藏/失焦不降频，否则 rAF 与定时器全被节流
    },
  });

  await win.loadFile(path.join(SRC, 'index.html'));
  // 关键：真的 show 出来，否则 rAF 约 1s 后掉到 1Hz。opacity 0.02 + showInactive
  // = 几乎不可见、不抢焦点，但合成器持续出帧。
  win.setOpacity(0.02);
  win.showInactive();
  await sleep(400);   // 等首帧 + 渲染层订阅 onSnapshot

  const bridge = await win.webContents.executeJavaScript(
    '({ hasBridge: !!(window.island && window.island.onSnapshot), dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight })');
  if (!bridge.hasBridge) throw new Error('renderer 没有订阅 window.island.onSnapshot —— preload 没加载成功？');

  await win.webContents.executeJavaScript(INSTRUMENT);
  await sleep(WARMUP_MS);
  await win.webContents.executeJavaScript('window.__perf.reset()');

  // 注意用 getOSProcessId：getProcessId 在这个窗口上返回的是内部 id（实测 5），
  // 对不上 app.getAppMetrics() 的 pid，CPU 会被记成 0。
  const pid = typeof win.webContents.getOSProcessId === 'function'
    ? win.webContents.getOSProcessId()
    : win.webContents.getProcessId();
  const cpuSamples = [];
  cpuSnapshot(pid);          // 丢掉这次，让下一次的「自上次调用以来」覆盖真实窗口
  cpuSamples.length = 0;

  const t0 = nowMs();
  let count = 0, totalBytes = 0, maxBytes = 0;
  let lastSnap = null;   // 去重探针复用最后一拍（同一个 rev）
  const tickCount = Math.floor(DURATION_MS / TICK_MS);

  // 悬停展开→收起：800ms 进岛（折叠态中心，靠当前矩形算），1900ms 移出岛。
  // 移出用 (5,5)：岛始终水平居中，左上角一定在岛外。
  const enterTimer = setTimeout(async () => {
    try {
      const r = await islandRect(win);
      if (r) await movePointer(win, r.x + r.w / 2, r.y + r.h / 2);
    } catch { /* 窗口已关（不会发生，但别让定时器抛） */ }
  }, 800);
  const leaveTimer = setTimeout(() => { movePointer(win, 5, 5).catch(() => {}); }, 1900);

  for (let i = 0; i < tickCount; i++) {
    const due = t0 + i * TICK_MS;
    const wait = due - nowMs();
    if (wait > 0) await sleep(wait);
    const snap = makeSnapshot(i, version === 2);
    lastSnap = snap;
    const bytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');
    totalBytes += bytes;
    maxBytes = Math.max(maxBytes, bytes);
    win.webContents.send('island:snapshot', snap);
    count++;
    // CPU 采样与 tick 对齐；定时器抖动由上面的 wait 循环吸收
    cpuSamples.push(cpuSnapshot(pid));
  }
  // 让最后一拍渲染完，凑满 DURATION_MS 的统计窗口
  await sleep(Math.max(0, t0 + DURATION_MS - nowMs()));
  clearTimeout(enterTimer);
  clearTimeout(leaveTimer);

  // 主统计窗口到此为止，先读回；去重探针的帧/DOM 变更不算进上表。
  const mainRaw = await win.webContents.executeJavaScript(SNAPSHOT_READ);

  // 去重探针 1：同一个 rev 连推 8 次（内容是上一拍的「活跃多会话」），
  // v2 渲染层应当跳过整次渲染；v1 没有 rev 概念，会照旧整树重建。
  // 只看 structural（childList/attributes）：本地秒级时钟的 textContent 更新
  // 是 characterData，即使去重完全正确也可能每 1s 出现一条，不能算进去重指标。
  const dupBefore = mainRaw.mutations;
  const dupStructuralBefore = mainRaw.structural;
  const dupChildListBefore = mainRaw.childListMutations;
  const dupAttrBefore = mainRaw.attrMutations;
  // CPU 也单独采：这一段模拟「主进程内容没变、却重复发了同一拍」（v1 每拍都这样：
  // 快照里有 now/mtimeMs，JSON 永远不同 → 渲染层 4 次/秒重建整树）。
  const dupCpu = [];
  const dupPushes = 8;
  for (let i = 0; i < dupPushes; i++) {
    await sleep(TICK_MS);
    if (lastSnap) win.webContents.send('island:snapshot', lastSnap);
    dupCpu.push(cpuSnapshot(pid));
  }
  const midRaw = await win.webContents.executeJavaScript(SNAPSHOT_READ);
  const dedupe = {
    duplicatePushes: dupPushes,
    domMutations: midRaw.mutations - dupBefore,
    structuralMutations: midRaw.structural - dupStructuralBefore,
    childListMutations: midRaw.childListMutations - dupChildListBefore,
    attributeMutations: midRaw.attrMutations - dupAttrBefore,
    cpu: summarizeCpu(dupCpu),
  };

  // 去重探针 2（真·空闲态）：切到一个全空闲快照 —— 没有循环动画，
  // 两代渲染层都没有持续动画开销，剩下的差异才是「内容没变还发同一拍」的成本。
  // v1 每拍重建（innerHTML → childList），v2 rev 相同直接 return。
  const idleSnap = makeIdleSnapshot(version === 2);
  win.webContents.send('island:snapshot', idleSnap);
  await sleep(400);   // 等空闲态画完、动画全部退场
  const idleBefore = await win.webContents.executeJavaScript(SNAPSHOT_READ);
  const idleCpu = [];
  for (let i = 0; i < dupPushes; i++) {
    await sleep(TICK_MS);
    win.webContents.send('island:snapshot', idleSnap);
    idleCpu.push(cpuSnapshot(pid));
  }
  const idleAfter = await win.webContents.executeJavaScript(SNAPSHOT_READ);
  const idleDedupe = {
    duplicatePushes: dupPushes,
    domMutations: idleAfter.mutations - idleBefore.mutations,
    structuralMutations: idleAfter.structural - idleBefore.structural,
    childListMutations: idleAfter.childListMutations - idleBefore.childListMutations,
    attributeMutations: idleAfter.attrMutations - idleBefore.attrMutations,
    cpu: summarizeCpu(idleCpu),
  };

  const finalRaw = await win.webContents.executeJavaScript(READBACK);
  const finalRect = await islandRect(win);

  const durationSec = DURATION_MS / 1000;
  const result = {
    label: LABEL,
    src: SRC,
    version,
    git: gitHead(),
    durationMs: DURATION_MS,
    tickMs: TICK_MS,
    window: { width: winSize.w, height: winSize.h, dpr: bridge.dpr, inner: [bridge.innerW, bridge.innerH] },
    measurement: { showMode: 'showInactive@opacity0.02', rendererPid: pid },
    displayHz: (() => { try { return screen.getPrimaryDisplay().displayFrequency || null; } catch { return null; } })(),
    output: OUT,
    ...summarize(mainRaw, { durationMs: DURATION_MS }),
    cpu: summarizeCpu(cpuSamples),
    snapshot: {
      count,
      perSec: round(count / durationSec, 1),
      avgBytes: count ? Math.round(totalBytes / count) : 0,
      maxBytes,
      bytesPerSec: round(totalBytes / durationSec),
      totalBytes,
    },
    dedupe,
    idleDedupe,
    finalIsland: finalRect,
    ok: {
      framesCaptured: mainRaw.frames.length > 10,
      hoverExpandSeen: mainRaw.expand.length >= 2,
      rendered: !!(finalRect && finalRect.w > 0 && finalRect.h > 0),
    },
  };

  printTable(result);

  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
    console.log('\n[perf] JSON → ' + OUT);
  } else {
    console.log('\n[perf] JSON:\n' + JSON.stringify(result, null, 2));
  }

  if (!result.ok.framesCaptured) console.error('[perf] ⚠️ 只抓到 ' + mainRaw.frames.length + ' 帧，rAF 可能被节流');
  if (!result.ok.rendered) console.error('[perf] ⚠️ 岛体尺寸为 0，渲染层可能没起来');

  win.destroy();
  app.exit(result.ok.framesCaptured && result.ok.rendered ? 0 : 1);
}).catch((e) => {
  console.error('[perf] 失败:', e && (e.stack || e));
  app.exit(1);
});
