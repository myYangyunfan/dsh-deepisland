'use strict';
/**
 * Electron 主进程 —— Windows 版灵动岛。
 *
 * ## 为什么是 Electron 而不是手写 Win32
 *
 * 要一个「浮在所有窗口之上、不吃鼠标、半透明、无边框」的小窗，手写 Win32
 * 需要自己搭 `WS_EX_LAYERED` / `WS_EX_TRANSPARENT` / `SetWindowPos(HWND_TOPMOST)`
 * 一整套 —— 工作量远大于 UI 本身，而且「不吃鼠标」和「要能点」这对矛盾需求
 * 得靠 `WM_NCHITTEST` 逐像素判。Electron 一个 `BrowserWindow` 选项就够。
 *
 * 代价是 ~80MB 的安装包。对本项目的定位（一个盯着 DSH 的常驻小挂件）可以接受。
 *
 * ## 几个不能省的选项
 *
 * - `backgroundThrottling: false` —— 窗口不可见/失焦时 Chromium 会把定时器
 *   降频到 1s 甚至暂停，250ms 的轮询直接失效（岛变成「半天不动」）。
 * - `transparent: true` —— 岛是异形的，没有它就只能是个黑方块。
 * - `skipTaskbar: true` —— 它不是普通应用窗口，不该占任务栏位置。
 */

const { app, BrowserWindow, Tray, Menu, shell, clipboard, ipcMain, screen, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 启动追踪（仅 DSH_NOTCH_TRACE=<文件> 时生效）。
// 打包后的 exe 是 Windows GUI 子系统进程：console.log 一个字都看不到，
// 「为什么打包产物起不来」就只能靠写文件来问。
const TRACE = process.env.DSH_NOTCH_TRACE || '';
const trace = (m) => { if (TRACE) { try { fs.appendFileSync(TRACE, m + '\n'); } catch { /* ignore */ } } };
trace('[trace] main.js 载入 packaged=' + app.isPackaged + ' resourcesPath=' + process.resourcesPath);
process.on('uncaughtException', (e) => { trace('[trace] uncaughtException: ' + (e && (e.stack || e.message))); });
process.on('unhandledRejection', (e) => { trace('[trace] unhandledRejection: ' + (e && (e.stack || e))); });

const config = require('./config.js');
const { SessionMonitor } = require('./monitor.js');
const bridge = require('./bridge.js');
const { performJump } = require('./jump.js');

/** 轮询间隔。与 Swift 版一致 —— 250ms 是「跟手」与「不烧 CPU」的交点。 */
const TICK_MS = 250;

/** 折叠态尺寸（未乘 scale）。 */
const COLLAPSED = { w: 380, h: 46 };
/** 展开态尺寸上限（未乘 scale）。 */
const EXPANDED_MAX = { w: 420, h: 300 };
const EXPANDED_MIN = { w: 380, h: 120 };

/**
 * 连接器伸出屏幕顶边的长度（CSS px，未乘 scale）。
 *
 * ## 为什么窗口要往上挪
 *
 * `.neck` 用负margin-top 把自己顶到 .island 之上，但那只在**窗口内**成立——
 * 窗口顶边仍是一道看得见的边，方角也会露在屏幕里，读作「悬浮的黑盒子」。
 *
 * 要让它读作「从屏幕顶边长出来」，方角必须落在屏幕边界**之外**。
 * 做法就是把窗口 y 设成负值，让整个窗口的上缘探到屏幕上方去。
 * 那部分本来就不在屏幕里，谁也看不见。
 *
 * 数值取 10：与 CSS 里 .neck 的默认高度一致，两边对不齐就会露边。
 */
const NECK_OVERHANG = 10;

let win = null;
let tray = null;
let monitor = null;
let tickIndex = 0;
let expanded = false;
let lastSnapshotJson = '';
let bridgeState = { ok: false, port: bridge.FALLBACK_PORT, plugin: null };
let lastJump = null;       // { kind, brief, at }
let requestedHidden = false;
let forceShow = false;     // 仅冒烟模式用：无条件显示
let lastRequested = { w: COLLAPSED.w, h: COLLAPSED.h };

// ───────────────────────────── 单实例 ─────────────────────────────

/**
 * 关掉硬件加速，用软件渲染。
 *
 * 岛上只有文字、圆角和一点阴影，没有视频也没有 3D —— GPU 完全用不上。
 * 而 GPU 进程在部分机器上（无显卡驱动、远程桌面、受限沙箱）会**反复崩溃**，
 * 崩够次数后 Chromium 直接 `FATAL: GPU process isn't usable. Goodbye.`
 * 把整个 app 带走。实测在本机受限环境下必现。软件渲染没这个风险，
 * 对这个尺寸的窗口性能也完全够。
 */
app.disableHardwareAcceleration();
// 光关硬件加速还不够：GPU 进程仍会被拉起来，崩够次数后
// `gpu_data_manager_impl_private.cc` 照样 FATAL。直接把 GPU 跑在浏览器进程里，
// 从根上不让它单独起进程。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'AcceleratedVideoDecodeLinuxGL');

// 不锁的话，双击第二次会开第二个岛 —— 两个岛叠在一起，谁都不知道该关哪个。
const gotLock = app.requestSingleInstanceLock();
trace('[trace] 单实例锁 = ' + gotLock);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { showWindow(); }
  });
}

// ───────────────────────────── 窗口 ─────────────────────────────

function assetPath(name) {
  // 打包后 resources/app.asar/src/main.js → __dirname 在 asar 内，assets 同级
  const candidates = [
    path.join(__dirname, '..', 'assets', name),
    path.join(process.resourcesPath || '', 'assets', name),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 把窗口摆到主显示器顶部中间，并设成给定尺寸（CSS px，内部会乘 scale）。
 *
 * ## 为什么用 `setBounds` 而不是 `setSize` + `setPosition`
 *
 * 实测（scaleFactor = 1.75 的机器上）：**分开调这两个会漂移** ——
 * 每调一次窗口长大约 1~2 px，几秒钟就能从 380×46 涨到 400×60 以上，
 * 岛会越用越大。原因是 DWM 的 resize 动画叠加 DPI 取整，两次调用之间
 * 读到的尺寸不是最终值。改成一次 `setBounds` 原子地给全四个值，实测稳定。
 *
 * 这个坑不难复现但很难从现象猜到原因（只看到「岛在慢慢变大」）。
 */
function placeWindow(w, h, force = false) {
  lastRequested = { w, h };
  if (!win || win.isDestroyed()) return;
  const scale = win._scale || 1;
  const ww = Math.round(w * scale);
  // 窗口要比内容**高出一截**NECK_OVERHANG。
  //
  // 为什么不直接用 h：.neck 是负 margin，它占据的位置在 .island 的 box 之上，
  // 而 offsetHeight 量的是 .island 的 border-box —— **不含**那段。
  // 若窗口正好等于 h，颈部会被窗口边界裁掉，方角又露在屏幕里，
  // 于是「连接器」这件事完全白做（而且只在截图里才看得出来）。
  const hh = Math.round((h + NECK_OVERHANG) * scale);
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.round(area.x + (area.width - ww) / 2);
  // y 往上探 NECK_OVERHANG，让连接器的方角落到屏幕顶边之外（见 NECK_OVERHANG 注释）。
  //
  // 用 `area.y - 探出量` 而不是硬编码 0：显示器有任务栏且位于**上方**时
  // workArea.y 本身是正的，岛会跟着任务栏往下挪一截；
  // 不跟着算的话，连接器就会浮在任务栏下面而不是屏幕边缘，读作「贴了个膏药」。
  //
  // 屏幕顶边不能真被盖住：workArea.y 为负（任务栏在上）时，y 会算得更负，
  // 相当于把岛推进屏幕外的区域，用户就看不见它了。所以钳到 workArea 上沿之内 ——
  // 宁可连接器露一点边，也不要整个岛消失。
  const y = Math.max(area.y, Math.round(area.y - NECK_OVERHANG * scale));

  // 容差 2px：DPI 取整会让「设 380 读到 381」，没有容差就会每拍重设一次，
  // 白白触发 DWM 的 resize 动画。2px 在 380 宽的岛上看不出来。
  const TOL = 2;
  const b = win.getBounds();
  if (!force
    && Math.abs(b.width - ww) <= TOL && Math.abs(b.height - hh) <= TOL
    && Math.abs(b.x - x) <= TOL && Math.abs(b.y - y) <= TOL) return;
  if (process.env.DSH_NOTCH_VERBOSE) {
    console.log('[dsh-notch] resize ' + b.width + 'x' + b.height + ' → ' + ww + 'x' + hh);
  }
  win.setBounds({ x, y, width: ww, height: hh });
}

function createWindow() {
  const cfg = config.load();

  win = new BrowserWindow({
    width: Math.round(COLLAPSED.w * cfg.scale),
    height: Math.round(COLLAPSED.h * cfg.scale),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: true,
    show: false,
    title: 'DSHNotch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // ⚠️ 不能省：窗口失焦/被遮挡时 Chromium 会把定时器降频，
      // 250ms 轮询会变成「半天不动」。
      backgroundThrottling: false,
    },
  });
  win._scale = cfg.scale;

  // 岛不该参与「显示全部窗口」的窗口切换
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, 'index.html'));

  // 任何形式的「打开新窗口」都不允许 —— 岛只有一个窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  win.on('closed', () => { win = null; });

  win.once('ready-to-show', () => {
    applyVisibility();
  });

  placeWindow(COLLAPSED.w, COLLAPSED.h);
  // 先不 show —— 等首帧快照到了由 applyVisibility 决定
}

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  win.focus();
}

function hideWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
}

// ───────────────────────────── 托盘 ─────────────────────────────

/**
 * 托盘图标。
 *
 * 没有一个可见入口的话，岛会变成一个「关不掉也找不到」的东西 ——
 * 用户只能在任务管理器里杀。所以托盘是这个 app 必须的一部分，不是装饰。
 */
function createTray() {
  const file = assetPath('tray.png');
  let image;
  if (file) {
    image = nativeImage.createFromPath(file);
    image = image.resize({ width: 32, height: 32 });
  }
  if (!image || image.isEmpty()) {
    // 兜底：画一个 32×32 的纯色块，保证托盘一定出现（没有图标时 Electron 会静默不建）
    image = nativeImage.createFromBuffer(makeFallbackPng(32));
  }
  tray = new Tray(image);
  tray.setToolTip('DSHNotch · DSH 灵动岛');
  refreshTrayMenu();
  tray.on('click', () => {
    if (win && win.isVisible()) hideWindow(); else showWindow();
  });
}

/**
 * 把 DSH 窗口带到前台。
 *
 * ## 为什么要这个
 *
 * 岛自己不做设置界面 —— 唯一的设置入口是 DSH 的「设置 → 🏝️ 灵动岛」，
 * 两边共用同一份 `client-config.json`，再画一套只会变成第二个真相源。
 * 于是第一件会绊住用户的事就是：**装完了，设置在哪？**
 *
 * ## 为什么只能做到「尽量」
 *
 * Windows 没有 `NSWorkspace.activate` 那种按 bundle id 激活的能力。
 * Electron 侧能做的只有两件事，且都不保证成功：
 * 1. 自己有没有 DSH 窗口能聚焦（本 app 没有，它只有岛）；
 * 2. 再问一次**单实例锁**——若 DSH 也用了单实例锁，这次调用会把已有实例
 *    带到前台，然后我们立刻退出。
 *
 * 第 2 条依赖 DSH 自己实现了 `requestSingleInstanceLock`，**本仓库无法验证**。
 * 所以返回值会如实说明用了哪条路，界面上也照实提示，而不是假装一定能打开。
 *
 * @returns {Promise<{ ok: boolean, how: string }>}
 */
function bringDshToFront() {
  // 路 1：本进程若还留着别的窗口（正常情况没有）
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === win || w.isDestroyed()) continue;
    try { if (w.isMinimized()) w.restore(); w.show(); w.focus(); return { ok: true, how: 'window' }; }
    catch { /* 试下一条 */ }
  }
  // 路 2：现有实例已经持有单实例锁 —— 再问一次会唤起它
  return { ok: false, how: 'single-instance' };
}

function refreshTrayMenu() {
  if (!tray) return;
  const cfg = config.load();
  const login = app.getLoginItemSettings();
  const menu = Menu.buildFromTemplate([
    {
      label: cfg.notchEnabled ? '隐藏灵动岛' : '显示灵动岛',
      click: () => {
        const v = { ...config.load() };
        v.notchEnabled = !v.notchEnabled;
        config.save(v);
        applyVisibility();
        refreshTrayMenu();
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!login.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    {
      label: '跳转桥：' + (bridgeState.ok ? '已连上 (' + bridgeState.port + ')' : '未连上')
        // 待处理条数是「点了会话但 DSH 没切过去」的唯一线索。
        // 只显示「已连上」的话，这种情况下界面和正常态完全一样。
        + (bridgeState.ok && bridgeState.pending > 0
          ? ' · ' + bridgeState.pending + ' 条待处理'
          : ''),
      enabled: false,
    },
    {
      label: '打开 DSH 设置（灵动岛面板）',
      click: () => { bringDshToFront(); },
    },
    { type: 'separator' },
    {
      label: '打开配置目录',
      click: () => { shell.openPath(config.appDataDir()); },
    },
    {
      label: '在资源管理器中显示配置文件',
      click: () => { shell.showItemInFolder(config.storePath()); },
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ───────────────────────────── 轮询 ─────────────────────────────

function snapshot() {
  const cfg = config.load();
  const now = Date.now();
  const entries = monitor ? monitor.poll(now, tickIndex) : [];
  return {
    now,
    entries,
    config: {
      notchEnabled: cfg.notchEnabled,
      jumpEnabled: cfg.jumpEnabled,
      idleHide: cfg.idleHide,
      scale: cfg.scale,
      fileExists: cfg.fileExists,
      raw: cfg.raw,
    },
    bridge: bridgeState,
    expanded,
    jump: lastJump,
  };
}

function startLoop() {
  monitor = new SessionMonitor();

  const tick = () => {
    tickIndex += 1;
    let snap;
    try {
      snap = snapshot();
    } catch (e) {
      // 单拍出错不该让岛整个死掉 —— 记日志，下一拍再来
      console.error('[dsh-notch] poll 异常:', e && e.stack);
      return;
    }

    const json = JSON.stringify(snap);
    if (json !== lastSnapshotJson) {
      lastSnapshotJson = json;
      // ⚠️ 退出过程中定时器还会再打一拍，而那时渲染帧已经销毁了 ——
      // 直接 send 会抛「Render frame was disposed」，在退出日志里留一串红字。
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        try {
          win.webContents.send('island:snapshot', snap);
        } catch (e) {
          console.warn('[dsh-notch] 推送快照失败:', e && e.message);
        }
      }
    }

    // 配置可能在两次 tick 之间被设置面板改了
    applyVisibility();

    // 每 8 拍探一次桥（约 2s）—— 桥起没起不需要 250ms 精度
    if (tickIndex % 8 === 1) {
      bridge.health().then((r) => {
        // 判定要不要刷托盘菜单：pending 也要算进去。
        // 只比 ok/port 的话，「0 条待处理 → 1 条待处理」不会触发刷新，
        // 而这恰恰是最需要让用户看见的一次变化（他刚点了，没生效）。
        const changed = r.ok !== bridgeState.ok
          || r.port !== bridgeState.port
          || (r.pending || 0) !== (bridgeState.pending || 0);
        bridgeState = r;
        if (changed) refreshTrayMenu();
      }).catch(() => { /* 探桥失败就当没桥 */ });
    }
  };

  const timer = setInterval(tick, TICK_MS);
  tick();

  // ── 端到端冒烟（仅 DSH_NOTCH_SMOKE=1 时生效）──
  //
  // 存在的理由：UI 层（renderer.js / styles.css）在纯 Node 自检里测不到，
  // 而「没跑过的 UI 代码」等于没写。这个开关让 CI 能真的把岛显示出来、
  // 读回渲染后的文本与窗口尺寸，再自己退出。
  if (process.env.DSH_NOTCH_SMOKE === '1') {
    forceShow = true;
    setTimeout(async () => {
      if (!win || win.isDestroyed()) { app.quit(); return; }
      win.show();
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const text = await win.webContents.executeJavaScript(
          'document.getElementById("island").innerText');
        const size = win.getSize();
        const lines = [
          '渲染文本 = ' + JSON.stringify(text),
          '窗口尺寸 = ' + size.join('x'),
          '会话数 = ' + (JSON.parse(lastSnapshotJson).entries || []).length,
        ];
        for (const l of lines) console.log('[smoke] ' + l);
        // 打包后的 exe 是 Windows GUI 子系统进程，stdout 拿不到（终端里一片空白），
        // 所以额外写一份到文件 —— 否则「打包产物真的能跑」这件事无从验证。
        if (process.env.DSH_NOTCH_SMOKE_OUT) {
          try { fs.writeFileSync(process.env.DSH_NOTCH_SMOKE_OUT, lines.join('\n') + '\n'); }
          catch (e) { /* 写不出不影响冒烟本身 */ }
        }
      } catch (e) {
        console.log('[smoke] 取渲染结果失败: ' + (e && e.message));
      }
      app.quit();
    }, 3000);
  }
}

/** 决定窗口此刻该不该显示。 */
function applyVisibility() {
  if (!win) return;
  // 冒烟模式：无条件显示（否则「空闲自动收起」会立刻把它藏起来，什么也看不到）
  if (forceShow) { if (!win.isVisible()) win.show(); return; }
  const cfg = config.load();
  if (requestedHidden || !cfg.notchEnabled) { hideWindow(); return; }

  // 空闲收起：一个活跃会话都没有时把岛藏起来（macOS 的 idleHide 同义）
  if (cfg.idleHide && monitor) {
    const entries = lastSnapshotJson ? safeParseEntries() : [];
    const anyActive = entries.some((e) => e && e.status && e.status !== 'idle');
    if (!anyActive) { hideWindow(); return; }
  }
  if (!win.isVisible()) win.show();
}

function safeParseEntries() {
  try {
    return JSON.parse(lastSnapshotJson).entries || [];
  } catch {
    return [];
  }
}

// ───────────────────────────── IPC ─────────────────────────────

ipcMain.handle('island:jump', async (_e, payload) => {
  const entry = payload || {};
  const cfg = config.load();
  const outcome = await performJump(entry, {
    // `dsh://open` 是 DSH 唯一对外注册的深链。Windows 上是否注册过未实测 ——
    // 失败只是「置前」这一步无效，降级路径照走。
    activate: async () => {
      try {
        await shell.openExternal('dsh://open');
        return true;
      } catch (err) {
        console.warn('[dsh-notch] dsh://open 打不开（协议可能未注册）:', err && err.message);
        return false;
      }
    },
    copy: (text) => { clipboard.writeText(text); return true; },
    post: cfg.jumpEnabled
      ? (sid, title) => bridge.postJump(sid, title)
      : async () => false,
  });
  lastJump = { kind: outcome.kind, brief: outcome.brief, at: Date.now() };
  lastSnapshotJson = '';   // 强制下一拍立刻把提示推给渲染层
  return { ok: outcome.isSuccess, brief: outcome.brief, kind: outcome.kind };
});

ipcMain.handle('island:resize', (_e, payload) => {
  if (!win) return false;
  // clamp 的上/下限是「.island 内容高」，而 placeWindow 会自己加 NECK_OVERHANG，
  // 所以这里**不能**把颈部算进上下限 —— 否则窗口会比内容高出 2 倍颈部。
  const w = clamp(payload && payload.width, EXPANDED_MIN.w, EXPANDED_MAX.w) || COLLAPSED.w;
  const h = clamp(payload && payload.height, COLLAPSED.h, EXPANDED_MAX.h) || COLLAPSED.h;
  placeWindow(w, h);
  return true;
});

ipcMain.handle('island:expand', (_e, value) => {
  expanded = !!value;
  if (!expanded) placeWindow(COLLAPSED.w, COLLAPSED.h);
  return expanded;
});

ipcMain.handle('island:hide', () => {
  requestedHidden = true;
  hideWindow();
  return true;
});

ipcMain.handle('island:show', () => {
  requestedHidden = false;
  applyVisibility();
  return true;
});

ipcMain.handle('island:quit', () => { app.quit(); return true; });

ipcMain.handle('island:toggle-notch', () => {
  const next = config.toggleNotch();
  applyVisibility();
  refreshTrayMenu();
  return next;
});

ipcMain.handle('island:open-dsh', () => bringDshToFront());

ipcMain.handle('island:open-config-dir', () => {
  shell.openPath(config.appDataDir());
  return true;
});

// ───────────────────────────── 工具 ─────────────────────────────

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 32×32 的纯色 PNG（托盘图标缺失时的兜底，保证托盘一定存在）。 */
function makeFallbackPng(size) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;   // filter: none
    for (let x = 0; x < size; x += 1) {
      const o = rowStart + 1 + x * 4;
      raw[o] = 0x4e; raw[o + 1] = 0x7c; raw[o + 2] = 0xff; raw[o + 3] = 0xff;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ───────────────────────────── 生命周期 ─────────────────────────────

app.on('ready', () => {
  trace('[trace] ready');
  createWindow();
  trace('[trace] window 建好');
  createTray();
  trace('[trace] tray 建好');
  startLoop();
  trace('[trace] 轮询已起');

  // 显示器变了（插拔外接屏 / 改分辨率）→ 重新定位，否则岛会飘到屏幕外
  const repo = () => placeWindow(lastRequested.w, lastRequested.h, true);
  screen.on('display-added', repo);
  screen.on('display-removed', repo);
  screen.on('display-metrics-changed', repo);
});

function currentSize() {
  return win ? win.getBounds() : { width: COLLAPSED.w, height: COLLAPSED.h };
}

app.on('window-all-closed', () => {
  // Windows 上关窗不等于退出：岛靠托盘活着
  if (process.platform !== 'darwin') return;
  app.quit();
});

app.on('before-quit', () => {
  if (tray) { tray.destroy(); tray = null; }
});
