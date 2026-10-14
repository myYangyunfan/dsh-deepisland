'use strict';
/**
 * Electron 主进程 —— Windows 版灵动岛。
 *
 * ## 架构（macOS 版同款，丝滑的来源）
 *
 * 窗口按**最大展开态**一次开好（MAX_WINDOW），顶端钉在屏幕顶端、水平居中；
 * 展开收起只是岛体在窗口里改宽改高（渲染层 CSS 弹簧）—— 窗口不动，
 * 动画全程 GPU 合成。「逐帧 setBounds 跟随内容」的老路在 DWM 上必然抖：
 * 层化透明窗口的尺寸变化走不了合成器快路径。
 *
 * 窗口平时**鼠标穿透**（setIgnoreMouseEvents(true, {forward:true})），
 * 只有指针进岛时渲染层才调 island:set-interactive 临时接管 —— 比岛大一圈
 * 的透明区域（bleed，给外发光留的）不吞下方应用的点击。
 *
 * ## 为什么是 Electron 而不是手写 Win32
 *
 * 要一个「浮在所有窗口之上、不吃鼠标、半透明、无边框」的小窗，手写 Win32
 * 需要自己搭 `WS_EX_LAYERED` / `WS_EX_TRANSPARENT` / `SetWindowPos(HWND_TOPMOST)`
 * 一整套 —— 工作量远大于 UI 本身，而且「不吃鼠标」和「要能点」这对矛盾需求
 * 得靠 `WM_NCHITTEST` 逐像素判。Electron 一组选项就够（穿透由我们自己在
 * 渲染层做命中切换，等价于 Mac 的 NotchPanel.isInteractive）。
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
const TRACE = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData/Roaming'),
  'DSHNotch',
  'main.log'
);
const trace = (m) => {
  try {
    fs.appendFileSync(TRACE, `[${new Date().toISOString()}] ${m}\n`);
  } catch { /* ignore */ }
};
trace('[trace] main.js 载入 packaged=' + app.isPackaged + ' resourcesPath=' + process.resourcesPath);
process.on('uncaughtException', (e) => { trace('[trace] uncaughtException: ' + (e && (e.stack || e.message))); });
process.on('unhandledRejection', (e) => { trace('[trace] unhandledRejection: ' + (e && (e.stack || e))); });
app.on('will-quit', () => trace('[trace] app will-quit'));
app.on('quit', (e, code) => trace('[trace] app quit code=' + code));
process.on('exit', (code) => trace('[trace] process exit code=' + code));

const config = require('./config.js');
const { SessionMonitor } = require('./monitor.js');
const bridge = require('./bridge.js');
const { performJump } = require('./jump.js');

/** 轮询间隔。与 Swift 版一致 —— 250ms 是「跟手」与「不烧 CPU」的交点。 */
const TICK_MS = 250;

/**
 * 固定窗口尺寸：按**最大展开态**一次开好（macOS 版 NotchMetrics 的
 * maxExpandedSize + bleed 同款结论）。
 *
 * 展开收起只是岛体在窗口里改宽改高（CSS 弹簧），窗口一个字节都不动 ——
 * 「逐帧 setBounds」的老路在 DWM 上必然抖（层化透明窗口的尺寸变化
 * 走不了合成器快路径），这是 macOS 丝滑、旧 Windows 版发涩的分水岭。
 *
 * 比最大内容（岛体最宽 436）大一圈的部分是 **bleed**：给外发光留绘制
 * 空间。窗口平时鼠标穿透，多出来的透明区域不吞下方应用的点击。
 */
const MAX_WINDOW = { w: 484, h: 300 };

let win = null;
let tray = null;
let monitor = null;
let tickIndex = 0;
let lastSnapshotJson = '';
let bridgeState = { ok: false, port: bridge.FALLBACK_PORT, plugin: null };
let lastJump = null;       // { kind, brief, at }
let requestedHidden = false;
let forceShow = false;     // 仅冒烟模式用：无条件显示

// ───────────────────────────── 单实例 ─────────────────────────────

/**
 * 关掉硬件加速，用软件渲染。
 *
 * 岛上只有文字、圆角和一点光晕，没有视频也没有 3D —— GPU 完全用不上。
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
 * 把窗口摆到主显示器顶部中间。尺寸恒为 MAX_WINDOW × scale —— 本函数
 * 只在启动、scale 变化、显示器几何变化时被调用，**不参与展开动画**
 * （那是渲染层在窗口内部的 CSS 弹簧，碰窗口就会抖）。
 *
 * y = workArea.y：窗口顶端与屏幕（工作区）顶端重合，岛体顶端的两个方角
 * 落在屏幕边界上 —— 「从屏幕顶边长出来」的读感由此而来（macOS 版
 * windowOrigin 的同一条纪律：窗口顶端 = 屏幕顶端，不留顶部 bleed）。
 */
function placeWindow(force = false) {
  if (!win || win.isDestroyed()) return;
  const scale = win._scale || 1;
  const ww = Math.round(MAX_WINDOW.w * scale);
  const hh = Math.round(MAX_WINDOW.h * scale);
  const area = screen.getPrimaryDisplay().workArea;
  const x = Math.round(area.x + (area.width - ww) / 2);
  const y = area.y;

  // 容差 2px：DPI 取整会让「设 484 读到 485」，没有容差就会反复重设，
  // 白白触发 DWM 的窗口动画。2px 在这个尺寸上看不出来。
  const TOL = 2;
  const b = win.getBounds();
  if (!force
    && Math.abs(b.width - ww) <= TOL && Math.abs(b.height - hh) <= TOL
    && Math.abs(b.x - x) <= TOL && Math.abs(b.y - y) <= TOL) return;
  if (process.env.DSH_NOTCH_VERBOSE) {
    console.log('[dsh-notch] place ' + b.width + 'x' + b.height + ' → ' + ww + 'x' + hh);
  }
  win.setBounds({ x, y, width: ww, height: hh });
}

function createWindow() {
  const cfg = config.load();

  win = new BrowserWindow({
    width: Math.round(MAX_WINDOW.w * cfg.scale),
    height: Math.round(MAX_WINDOW.h * cfg.scale),
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

  // 穿透为常态：forward 让 mousemove 仍被转发进渲染层（命中判定靠它），
  // 指针进岛时渲染层会调 island:set-interactive 临时接管。
  win.setIgnoreMouseEvents(true, { forward: true });

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

  placeWindow();
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
  // 路 2：现有实例已经持有单实例锁 —— 再起一个会唤起它
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

    // scale 变化要重摆窗口（尺寸 = MAX_WINDOW × scale），其余几何不变
    const wantScale = config.load().scale || 1;
    if (win && !win.isDestroyed() && (win._scale || 1) !== wantScale) {
      win._scale = wantScale;
      placeWindow();
    }

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
  // 读回渲染后的文本与岛体尺寸，再自己退出。
  //
  // 除了读文本，还会**落两张截图**（折叠态 + 展开态，按岛体实际矩形裁剪，
  // 不带窗口的 bleed 留白）：动画/布局这类「跑通了但长得不对」的问题只有
  // 看图能发现。截图目录由 DSH_NOTCH_SMOKE_DIR 指定（默认与冒烟输出同目录，
  // 再退 %APPDATA%\DSHNotch）。展开态用合成 mousemove 触发 —— 窗口平时
  // 鼠标穿透，渲染层的命中判定吃的就是这些转发事件（listener 不校验 isTrusted）。
  if (process.env.DSH_NOTCH_SMOKE === '1') {
    forceShow = true;
    setTimeout(async () => {
      if (!win || win.isDestroyed()) { app.quit(); return; }
      win.show();
      await new Promise((r) => setTimeout(r, 1500));
      const lines = [];
      const shotDir = process.env.DSH_NOTCH_SMOKE_DIR
        || (process.env.DSH_NOTCH_SMOKE_OUT
          ? path.dirname(process.env.DSH_NOTCH_SMOKE_OUT)
          : path.join(process.env.APPDATA || '.', 'DSHNotch'));
      const readIsland = async () => win.webContents.executeJavaScript(`(() => {
        const i = document.getElementById('island');
        const r = i.getBoundingClientRect();
        return { text: i.innerText, x: r.left, y: r.top, w: r.width, h: r.height };
      })()`);
      const shot = async (name, box) => {
        try {
          // capturePage 要 {x,y,width,height} 且取整（getBoundingClientRect 是小数）
          const rect = {
            x: Math.round(box.x), y: Math.round(box.y),
            width: Math.round(box.w), height: Math.round(box.h),
          };
          const img = await win.webContents.capturePage(rect);
          fs.mkdirSync(shotDir, { recursive: true });
          const file = path.join(shotDir, name);
          fs.writeFileSync(file, img.toPNG());
          lines.push('截图 = ' + file);
        } catch (e) {
          lines.push('截图失败（' + name + '）: ' + (e && e.message));
        }
      };
      try {
        // 折叠态：文本 + 岛体矩形 + 截图（窗口恒定，量的是岛自己的尺寸）
        const c = await readIsland();
        lines.push('折叠文本 = ' + JSON.stringify(c.text));
        lines.push('折叠岛体 = ' + Math.round(c.w) + 'x' + Math.round(c.h));
        await shot('smoke-collapsed.png', c);

        // 展开态：把指针「挪」到岛心（穿透窗口只认转发的 mousemove）→ 等驻留+弹簧 → 再量再截
        const fire = (x, y) => win.webContents.executeJavaScript(
          `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y} }))`);
        await fire(Math.round(c.x + c.w / 2), Math.round(c.y + c.h / 2));
        await new Promise((r) => setTimeout(r, 250));   // 跨过 200ms 驻留门槛
        await fire(Math.round(c.x + c.w / 2), Math.round(c.y + c.h / 2) + 4);
        await new Promise((r) => setTimeout(r, 750));   // 等弹簧走完
        const e = await readIsland();
        lines.push('展开文本 = ' + JSON.stringify(e.text));
        lines.push('展开岛体 = ' + Math.round(e.w) + 'x' + Math.round(e.h));
        await shot('smoke-expanded.png', e);
        lines.push('会话数 = ' + (JSON.parse(lastSnapshotJson).entries || []).length);

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

/**
 * 指针进岛/出岛：切窗口的点击穿透。判定在渲染层（它有岛的当前矩形和
 * 转发来的指针位置），这里只执行。穿透是常态，进岛才临时接管 ——
 * macOS 版 NotchPanel.isInteractive 的同一条纪律。
 */
ipcMain.handle('island:set-interactive', (_e, value) => {
  if (win && !win.isDestroyed()) {
    try {
      win.setIgnoreMouseEvents(!value, { forward: true });
    } catch (e) {
      trace('[trace] setIgnoreMouseEvents 失败: ' + (e && e.message));
    }
  }
  return true;
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
  const repo = () => placeWindow(true);
  screen.on('display-added', repo);
  screen.on('display-removed', repo);
  screen.on('display-metrics-changed', repo);
});

app.on('window-all-closed', () => {
  // Windows 上关窗不等于退出：岛靠托盘活着
  if (process.platform !== 'darwin') return;
  app.quit();
});

app.on('before-quit', () => {
  if (tray) { tray.destroy(); tray = null; }
});
