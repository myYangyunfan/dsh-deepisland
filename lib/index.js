/**
 * @module @dsh-external/dsh-vibe-island
 * DeepSeek Harness 智能体刘海灵动岛 - 服务端 Cordis 插件
 *
 * 职责：
 * 1. 在 DSH settings 注册 `dsh-vibe-island` 命名空间，提供灵动岛形态配置。
 * 2. 供客户端 (lib/client.js) 经 configForms 读取热配置。
 * 3. 起一个**只监听 127.0.0.1 的本机跳转桥**，把 macOS 灵动岛 app 的
 *    「点某个对话 → 跳过去」请求递交给渲染进程，由渲染进程调
 *    `uiWorkspace.openSession(sessionId)` 真正打开会话。
 * 4. 缺 app 时自动把 DSHNotch.app 下载、校验、装好并启动。
 *
 * ## 为什么服务端能搭这座桥
 *
 * 这个插件是**双半边**结构，两半跑在同一个宿主 app 的不同进程里：
 *
 * | 半边 | 文件 | 进程 | 能力 |
 * |------|------|------|------|
 * | 服务端 | `lib/index.js` | `dsh-desktop-host`（Electron 以 Node 模式跑，PID 见 ps） | 完整 Node：fs / child_process / http |
 * | 客户端 | `lib/client.js` | 渲染进程（`window.__ModuleLoader__.load` 注入 DOM） | 能调宿主服务，含 `uiWorkspace.openSession` |
 *
 * 渲染进程**出不了 DSH 窗口**（只能往 document.body 塞 fixed 定位的 DOM），
 * 所以系统级刘海浮层必须由独立的 NSPanel app 承担 —— 这也是为什么仓库里
 * 同时存在 `swift/`。但反过来，**app 也进不了 DSH**（深链只有 `dsh://open`）。
 *
 * 于是缺的正是这一段「外部 → 渲染进程」的通道。本模块提供的本机 HTTP 服务
 * 就是它：app POST `/jump`，客户端轮询 `/next` 取走并执行。两者同机同用户，
 * 端口只绑 127.0.0.1，不对外暴露。
 *
 * ## 为什么渲染进程能连本机 HTTP
 *
 * 逐条查过宿主，不是想当然：
 * - 主窗口**没有 CSP**。asar 里 10 处 `Content-Security-Policy` 分别属于
 *   API 文件服务（`sandbox; default-src 'none'`）、HTML 预览消毒、
 *   更新/欢迎/强制更新弹窗，没有一条管到 `dsh-app://app` 主界面。
 * - Electron 启动参数含 `--disable-features=PrivateNetworkAccessChecks,
 *   LocalNetworkAccessChecks`，本机网络访问的额外预检被关掉了。
 * - 协议注册为 `--standard-schemes/--secure-schemes/--cors-schemes=dsh-app`，
 *   跨源走 CORS，所以本模块所有响应都带 `Access-Control-Allow-Origin: *`。
 */
import { createRequire } from 'node:module';
import z from '@deepseek-ai/schemastery';

export const name = '@dsh-external/dsh-vibe-island';
export const inject = ['settings'];

/** 本插件版本号：桥协议与自动安装都会把它写进 /health 供对端自证。 */
export const PLUGIN_VERSION = '1.1.0';

export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('灵动岛主开关：开启后在屏幕或窗口顶部居中显示智能体状态灵动岛'),
  placement: z.union([
    z.const('notch').description('Mac刘海/顶部吸附（紧贴屏幕物理或窗口顶端）'),
    z.const('floating').description('居中浮动药丸（微距向下偏移 10px，全圆角）'),
    z.const('top-right').description('右上角紧凑浮标（不遮挡主内容）'),
  ]).default('notch')
    .description('灵动岛放置位置与形态'),
  platformMode: z.union([
    z.const('auto').description('自动嗅探（根据当前操作系统自适应刘海或 Fluent 风格）'),
    z.const('macos').description('强制 macOS 风格（黑晶微倒角，紧凑贴合）'),
    z.const('windows').description('强制 Windows 11 风格（Fluent 亚克力毛玻璃圆角药丸）'),
  ]).default('auto')
    .description('平台视觉拟态风格'),
  glowEffect: z.boolean().default(true)
    .description('流动光晕与呼吸脉冲动效（Thinking 蓝紫光、Tool 执行高亮）'),
  expandOnHover: z.boolean().default(true)
    .description('鼠标悬停时自动展开 HUD 卡片（显示详细命令、Token 与耗时）'),
  showSubagentCount: z.boolean().default(true)
    .description('当存在并行子代理（Subagent）时在岛体右侧显示微章计数'),
  scale: z.number().step(0.05).min(0.8).max(1.3).default(1.0)
    .description('灵动岛整体缩放比例 (0.8 ~ 1.3)'),

  // ---- 以下为 v1.1.0 新增：跳转桥与自动安装 -------------------------------
  bridgeEnabled: z.boolean().default(true)
    .description('本机跳转桥：把灵动岛 app 的「点对话跳转」请求交给 DSH 渲染进程执行。'
      + '关闭后点击会退回「置前 + 复制标题 + ⌘K 粘贴」的旧方案'),
  bridgePort: z.natural().min(1024).max(65535).default(47311)
    .description('跳转桥本机端口。被占用时自动向后顺延，实际端口写入 bridge.json'),
  autoInstallApp: z.boolean().default(true)
    .description('macOS 上检测不到 DSHNotch.app 时，自动从本仓库 Release 下载、'
      + '校验 SHA256、安装并启动。关掉则只记一条日志，由你自己按 INSTALL.md 装'),
  appInstallDir: z.string().default('/Applications')
    .description('app 安装目标目录。不可写时自动退到 ~/Applications'),
});

const NS = 'dsh-vibe-island';

// ===========================================================================
// 跳转桥
// ===========================================================================

/** 桥的默认端口。与 lib/index.js 的 Config.bridgePort 默认值保持一致。 */
export const BRIDGE_PORT = 47311;
/** 端口被占时最多向后试几个。 */
const BRIDGE_PORT_TRIES = 12;
/** 队列上限：DSH 没开时 app 的请求会先堆着，上限防止无限增长。 */
const BRIDGE_QUEUE_MAX = 32;
/**
 * 单条请求的存活时长。
 *
 * app 点一下会「POST 跳转 + 置前 DSH」两件事一起做。若 DSH 当时是关的，
 * 桥根本不存在，POST 直接失败走降级；只有 DSH 已在跑时请求才进队列，而那种
 * 情况下渲染进程几秒内就会来取。45s 足够覆盖冷启动，又不会让用户十分钟后
 * 打开 DSH 时被一条陈旧请求劫持到某个会话。
 */
const BRIDGE_ITEM_TTL_MS = 45_000;

const BRIDGE_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '600',
};

/**
 * 桥的协议说明，纯文本返回，方便人用 curl 自查。
 * 客户端与 app 都以这里的字段为准，改动请同步两处。
 */
const BRIDGE_README = [
  'dsh-vibe-island jump bridge',
  '',
  'GET  /health  -> { ok, plugin, version, port, pending }',
  'GET  /next    -> { ok, items: [{ seq, sessionId, title, ts }] }   取走并清空队列',
  'POST /jump    <- { "sessionId": "session-...", "title": "可选" }  -> { ok, seq }',
  'GET  /config  -> { ok, config }        客户端设置的兜底副本',
  'POST /config  <- { "enabled": false }  -> { ok, config }   只接受已知键与类型',
  '',
  '只监听 127.0.0.1。队列项 45s 后过期。',
  '配置落盘于应用数据目录（macOS: ~/Library/Application Support/DSHNotch，Windows: %APPDATA%\\DSHNotch）',
].join('\n');

// 这些函数是同步的（HTTP 处理里直接调），所以不能沿用 startBridge 里
// 那套 `await import()` —— 它拿到的是局部变量，外部看不见。
// 这里用 createRequire 一次性拿到同步句柄。
const requireSync = createRequire(import.meta.url);
const nodeFs = requireSync('node:fs');
const nodePath = requireSync('node:path');
const nodeOs = requireSync('node:os');

/**
 * 客户端配置的白名单：键 → 期望类型。
 *
 * 提到模块级是因为 `/health` 也要报它 —— 出现「设了没生效」时，
 * 第一件事就是核对这份清单（老进程的白名单里没有新加的键，
 * 写进去会被静默丢弃，症状完全一样）。
 *
 * `notchEnabled` / `jumpEnabled` / `hideWhenIdle` 是**物理刘海 app** 用的 ——
 * 它读同一个文件。不加进来的话 app 写进去的值会被当未知键忽略，两边永远对不上。
 */
const CONFIG_ALLOWED = {
  enabled: 'boolean',
  notchEnabled: 'boolean',
  jumpEnabled: 'boolean',
  hideWhenIdle: 'boolean',
  placement: 'string',
  platformMode: 'string',
  glowEffect: 'boolean',
  expandOnHover: 'boolean',
  showSubagentCount: 'boolean',
  scale: 'number',
  bridgeEnabled: 'boolean',
};

/**
 * 本插件与配套原生 app 约定的应用数据目录。
 *
 * ⚠️ 不能硬编码 `~/Library/Application Support/DSHNotch`：
 * 那是 **macOS 专属**路径。Windows 上 `~` 是 `C:\Users\<你>`，
 * 拼出来的 `C:\Users\<你>\Library\Application Support\DSHNotch` 是个
 * 不存在的目录 —— 看着能写，实际上和原生 app 各写各的（原生 app 读
 * `%APPDATA%`），两边永远对不上。这不是"以后再说"的问题：
 * Windows 版原生 app 一旦开工，第一个症状就是「设置改了没反应」。
 *
 * - macOS    `~/Library/Application Support/DSHNotch`
 * - Windows  `%APPDATA%\DSHNotch`（`AppData/Roaming`，与 Electron、
 *           VS Code 等工具的惯例一致）
 * - Linux    `$XDG_CONFIG_HOME/DSHNotch`（退回 `~/.config`）
 *
 * 原生侧对应实现：`swift/.../IslandConfig.swift` 的 `storeURL`
 * （用 `FileManager.applicationSupportDirectory`，mac 上落到同一个目录）。
 *
 * @returns {string} 目录绝对路径（不带尾斜杠）
 */
export function appDataDir() {
  const home = nodeOs.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
      || (process.env.USERPROFILE
        ? nodePath.join(process.env.USERPROFILE, 'AppData', 'Roaming')
        : null);
    return appData ? nodePath.join(appData, 'DSHNotch') : nodePath.join(home, 'DSHNotch');
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME;
    return nodePath.join(xdg && String(xdg).trim() ? xdg : nodePath.join(home, '.config'), 'DSHNotch');
  }
  // darwin，以及任何没见过的平台：都按 macOS 处理
  // （宿主是 Electron，实际只跑这三种）
  return nodePath.join(home, 'Library', 'Application Support', 'DSHNotch');
}

/** 配置兜底存储的位置。放应用数据目录，语义与 bridge.json 一致。 */
export function configFilePath() {
  return nodePath.join(appDataDir(), 'client-config.json');
}

/**
 * 读客户端设置的兜底副本。
 *
 * 这个文件**只是 `configForms` 的备份**，不是权威源：能用 `configForms`
 * 的 profile 仍以宿主配置为准，这里只在它缺席时接管。
 *
 * @returns {object} 读不到 / 坏了都返回 `{}`（配置丢失不该让插件出错）
 */
export function readConfig() {
  try {
    const v = JSON.parse(nodeFs.readFileSync(configFilePath(), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* 文件不存在是常态（首次启动），用默认值即可 */ }
  return {};
}

/**
 * 写客户端设置的兜底副本。
 *
 * 两条纪律：
 * 1. **只接受已知的键与类型**。这是本机回环上的 HTTP 端点，同机任何进程
 *    都能调，不校验就等于开了个任意写的口子（哪怕只写一个固定路径）。
 * 2. **原子替换**。直接覆写时若进程中途被杀，配置会变成半截 JSON，
 *    下次启动整个设置面板就废了。先写临时文件再 `rename`。
 *
 * @param {string|Buffer} raw 请求体（JSON 文本）
 * @returns {{ ok: boolean, config?: object, rejected?: Array<{key: string, why: string}>, error?: string }}
 */
export function writeConfig(raw) {
  let patch;
  try {
    patch = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + msg(e) };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: '配置必须是对象' };
  }

  const next = readConfig();
  // 记下被拒的键。**必须回报给调用方** ——
  // 静默丢弃会让「保存成功」的响应与实际结果不符，用户以为改好了，
  // 而行为完全没变（本项目踩过：老版本白名单里没有 notchEnabled，
  // 面板显示「已保存」，刘海却一直不动）。
  const rejected = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in CONFIG_ALLOWED)) { rejected.push({ key: k, why: '未知键' }); continue; }
    if (CONFIG_ALLOWED[k] === 'boolean' && typeof v !== 'boolean') { rejected.push({ key: k, why: '应为布尔' }); continue; }
    if (CONFIG_ALLOWED[k] === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) { rejected.push({ key: k, why: '应为数字' }); continue; }
    if (CONFIG_ALLOWED[k] === 'string' && typeof v !== 'string') { rejected.push({ key: k, why: '应为字符串' }); continue; }
    next[k] = v;
  }

  try {
    const file = configFilePath();
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    nodeFs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    nodeFs.renameSync(tmp, file);
    // 全部键都被拒时不能报成功 —— 那会让调用方以为设置生效了
    const nothingAccepted = rejected.length > 0 && Object.keys(patch).length === rejected.length;
    return {
      ok: !nothingAccepted,
      config: next,
      ...(rejected.length ? { rejected } : {}),
      ...(nothingAccepted ? { error: '没有可接受的键：' + rejected.map((r) => r.key + '(' + r.why + ')').join(', ') } : {}),
    };
  } catch (e) {
    return { ok: false, error: '写入失败：' + msg(e) };
  }
}

/**
 * 起一个跳转桥。
 *
 * 幂等：同一个插件实例重复调用会返回同一个桥，不会占第二个端口。
 *
 * @param {object} opts
 * @param {number} opts.port    起始端口
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<null | {
 *   port: number,
 *   portFile: string,
 *   enqueue: (item: { sessionId: string, title?: string }) => number,
 *   drain: () => Array<{ seq: number, sessionId: string, title: string, ts: number }>,
 *   pending: () => number,
 *   close: () => Promise<void>,
 * }>} 起不来时返回 null（调用方必须容错，桥只是增强功能）
 */
export async function startBridge({ port = BRIDGE_PORT, log = () => {} } = {}) {
  let http, fs, os, path;
  try {
    // 动态 import：万一宿主换了个不含 node: 内置模块的运行环境，
    // 也只是桥起不来，而不是整个插件加载失败。
    [http, fs, os, path] = await Promise.all([
      import('node:http'), import('node:fs'),
      import('node:os'), import('node:path'),
    ]);
  } catch (e) {
    log('bridge: 运行环境缺少 node 内置模块，跳过本机跳转桥 — ' + msg(e));
    return null;
  }
  const { createServer } = http.default ?? http;
  const { homedir } = os.default ?? os;
  const pathMod = path.default ?? path;

  /** @type {Array<{ seq: number, sessionId: string, title: string, ts: number }>} */
  const queue = [];
  let seq = 0;
  let live = null;         // 当前 http.Server
  let boundPort = 0;
  let portFile = '';

  const now = () => Date.now();
  // 启动时刻（ISO）：/health 报它，用来判断跑的是新代码还是老进程
  const startedAtIso = new Date().toISOString();

  /** 丢掉过期项。返回是否还剩东西。 */
  function prune() {
    const cutoff = now() - BRIDGE_ITEM_TTL_MS;
    while (queue.length && queue[0].ts < cutoff) queue.shift();
    return queue.length;
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...BRIDGE_CORS,
    });
    res.end(body);
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { req.destroy(); resolve(''); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  const server = createServer((req, res) => {
    // 解析 URL 时用固定 base：req.url 是 origin-form 路径，不会带协议头
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; }
    catch { pathname = '/'; }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, BRIDGE_CORS);
      res.end();
      return;
    }

    if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
      sendJson(res, 200, {
        ok: true, plugin: name, version: PLUGIN_VERSION,
        port: boundPort, pid: process.pid, pending: prune(),
        // 启动时刻：判断「跑的是新代码还是改动前那个老进程」最直接的凭据。
        // 之前没这个字段，只能靠 pid 或直接验端点行为，两者都不直观。
        startedAt: startedAtIso,
        // 白名单里有哪些键 —— 出现「设了没生效」时先核对这份清单
        keys: Object.keys(CONFIG_ALLOWED),
      });
      return;
    }

    if (req.method === 'GET' && (pathname === '/next' || pathname === '/jump/next')) {
      // 先 prune 再取：过期的请求**不能**投递给客户端。
      // 少了这一步，一条十分钟前的点击会在用户下次打开 DSH 时把他劫持到某个会话。
      prune();
      const items = queue.splice(0, queue.length);
      // 回显 plugin：app 侧与客户端都靠它确认「回环上这个服务真是本插件」，
      // 免得 47311 附近有别的服务时把别人的 200 当成桥。
      sendJson(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION, items });
      return;
    }

    if (req.method === 'POST' && (pathname === '/jump' || pathname === '/open')) {
      readBody(req).then((raw) => {
        let sessionId = '';
        let title = '';
        try {
          const j = JSON.parse(raw || '{}');
          sessionId = typeof j.sessionId === 'string' ? j.sessionId.trim() : '';
          title = typeof j.title === 'string' ? j.title : '';
        } catch { /* 非法 JSON 当作空 */ }
        if (!sessionId) {
          sendJson(res, 400, { ok: false, error: 'missing sessionId' });
          return;
        }
        prune();
        seq += 1;
        queue.push({ seq, sessionId, title, ts: now() });
        while (queue.length > BRIDGE_QUEUE_MAX) queue.shift();
        log('bridge: 收到跳转请求 ' + sessionId + '（队列 ' + queue.length + '）');
        // 同样回显 plugin：macOS app 侧会核对它才认这次投递（见 SessionJump.postToBridge）
        sendJson(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION, seq, pending: queue.length });
      });
      return;
    }

    if (req.method === 'GET' && (pathname === '/config' || pathname === '/config/dsh-vibe-island')) {
      sendJson(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION, config: readConfig() });
      return;
    }

    if (req.method === 'POST' && (pathname === '/config' || pathname === '/config/dsh-vibe-island')) {
      // 客户端设置面板的**兜底持久化通道**。
      //
      // 为什么需要它：客户端首选的 `configForms` 在很多 profile 上拿不到 ——
      // 它由 `@deepseek-ai/dsh-client-ui-settings` 提供，而用户可以在
      // profile 的 cordis.patch.yml 里把它 `enabled: false` 关掉（很常见，
      // 因为它带引导流程）。这时 `bindConfigScope` 返回 null，
      // `updateField` 里的 `if (scope && …)` 会**静默什么都不做** ——
      // 表现就是「开关点不动，勾号也不变」。
      //
      // 服务端半边是纯 Node 进程，能直接读写文件，所以由它兜底：
      // 渲染进程 POST 过来 → 落盘 → 下次启动读回。
      readBody(req).then((raw) => {
        const result = writeConfig(raw);
        sendJson(res, result.ok ? 200 : 400, { ...result, plugin: name, version: PLUGIN_VERSION });
      }).catch((e) => {
        sendJson(res, 400, { ok: false, error: msg(e), plugin: name, version: PLUGIN_VERSION });
      });
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/readme')) {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...BRIDGE_CORS,
      });
      res.end(BRIDGE_README);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found', path: pathname });
  });

  // 端口向后顺延：固定端口被别人占了不该让桥直接废掉
  for (let i = 0; i < BRIDGE_PORT_TRIES; i += 1) {
    const want = port + i;
    const ok = await new Promise((resolve) => {
      const onError = (e) => {
        server.removeListener('listening', onListening);
        if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) resolve(false);
        else { log('bridge: listen 失败 ' + msg(e)); resolve(false); }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 只绑回环：这座桥的作用域就是「本机同一个用户」
      server.listen(want, '127.0.0.1');
    });
    if (ok) { boundPort = want; break; }
  }

  if (!boundPort) {
    log('bridge: ' + BRIDGE_PORT_TRIES + ' 个端口都被占用，跳转桥未启动（点击会走降级方案）');
    try { server.close(); } catch { /* ignore */ }
    return null;
  }

  // 把实际端口告诉 app。写失败也不影响桥本身 —— app 会退回默认端口。
  try {
    portFile = pathMod.join(appDataDir(), 'bridge.json');
    fs.mkdirSync(pathMod.dirname(portFile), { recursive: true });
    const payload = {
      ok: true, plugin: name, version: PLUGIN_VERSION,
      host: '127.0.0.1', port: boundPort, pid: process.pid, startedAt: now(),
    };
    const tmp = portFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, portFile);   // 原子替换：app 不会读到写了一半的 JSON
    log('bridge: 已就绪 http://127.0.0.1:' + boundPort + ' → ' + portFile);
  } catch (e) {
    portFile = '';
    log('bridge: 端口文件写入失败（app 将退回默认端口 ' + BRIDGE_PORT + '）— ' + msg(e));
  }

  // 退出时清端口文件：留着会让 app 往一个没人监听的端口发请求
  const cleanup = () => {
    if (!portFile) return;
    try { fs.rmSync(portFile, { force: true }); } catch { /* ignore */ }
  };
  process.once('exit', cleanup);

  return {
    port: boundPort,
    portFile,
    enqueue(item) {
      prune();
      seq += 1;
      queue.push({
        seq,
        sessionId: String(item.sessionId || '').trim(),
        title: item.title || '',
        ts: now(),
      });
      while (queue.length > BRIDGE_QUEUE_MAX) queue.shift();
      return seq;
    },
    drain() { return queue.splice(0, queue.length); },
    pending() { return prune(); },
    async close() {
      cleanup();
      await new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
      // server.close 只等已建立的连接；空闲 keep-alive socket 会吊住 close 回调
      try { server.closeAllConnections?.(); } catch { /* 旧 Node 没有 */ }
    },
  };
}

function msg(e) {
  return (e && (e.message || e.code)) || String(e);
}

// ===========================================================================
// 自动安装 DSHNotch.app（仅 macOS）
// ===========================================================================

/** Release 仓库。asset 名由 build.sh 的 `package` 决定：`DSHNotch-<ver>-<arch>.zip`。 */
export const RELEASE_REPO = 'myYangyunfan/dsh-deepisland';
/** 国内网络下 release 附件的 CDN 域名被拦时的镜像前缀（字节一致）。 */
export const RELEASE_MIRROR = 'https://gh-proxy.com/';

/**
 * build.sh 用 `uname -m` 命名资产，Node 的 process.arch 叫法不同。
 * 只有这两个值对得上，其余一律不认。
 */
export function releaseArch(nodeArch) {
  if (nodeArch === 'arm64') return 'arm64';
  if (nodeArch === 'x64') return 'x86_64';
  return '';
}

/**
 * 走 node:https 而不是 fetch。
 *
 * 两个理由：
 * 1. **不依赖 undici**。宿主是 Electron 的 Node 模式（Node 24），fetch 在
 *    那里有；但插件代码没必要赌这个 —— node:https 在任何 Node 12+ 都在。
 * 2. **能离线自检**。作者本机的执行沙箱把 fetch 整个拦掉（连 github.com
 *    都 fail），改成 node:https 后下载环节能在本地真跑真验。
 *
 * 手写重定向是因为下面 `resolveLatestVersion` 需要**故意不跟随** 302。
 */
async function httpsGet(url, { timeoutMs = 30_000, maxRedirects = 5 } = {}) {
  const https = await import('node:https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'dsh-vibe-island/' + PLUGIN_VERSION },
    }, (res) => {
      const code = res.statusCode || 0;
      const loc = res.headers.location;
      if (code >= 300 && code < 400 && loc) {
        res.resume();   // 必须消费掉，否则 socket 泄漏
        if (maxRedirects <= 0) { reject(new Error('重定向过多（' + code + '）')); return; }
        let next;
        try { next = new URL(loc, url).toString(); } catch (e) { reject(e); return; }
        httpsGet(next, { timeoutMs, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        status: code,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时 ' + timeoutMs + 'ms')); });
    req.on('error', reject);
  });
}

/**
 * 解析仓库最新 Release 的 tag。
 *
 * 走 `releases/latest` 的 302 而不是问 API：本机 `api.github.com` 是 DNS
 * 污染 + SNI 阻断（`dig` 得到 199.59.148.9），而 `github.com` 本身通。
 * 代价是要**不跟随**重定向，自己读 Location。
 *
 * @returns {Promise<string>} 形如 `0.3.0` 的版本号（已去掉 v 前缀）
 */
export async function resolveLatestVersion({ timeoutMs = 20_000 } = {}) {
  const url = 'https://github.com/' + RELEASE_REPO + '/releases/latest';
  const res = await httpsGet(url, { timeoutMs, maxRedirects: 0 });
  if (res.status < 300 || res.status >= 400) {
    throw new Error('releases/latest 返回 HTTP ' + res.status + '（拿不到 Location）');
  }
  const loc = String(res.headers.location || '');
  // [^/\\\s] 而不是 [^/]：方括号里的 \s 排掉空白，防止万一拿到的是整段 header
  // 文本时 [^/] 跨行匹配，把下一行 set-cookie 也一起吞进来（实测踩过）。
  const m = loc.match(/\/releases\/tag\/v?([0-9][^\s/]*)/);
  if (!m) throw new Error('无法从 ' + (loc || '(空)') + ' 解析版本号');
  const ver = m[1];
  if (!/^[0-9][0-9A-Za-z.\-+]*$/.test(ver)) {
    throw new Error('版本号形状不对：' + JSON.stringify(ver));
  }
  return ver;
}

/**
 * 从 SHA256SUMS.txt 里取出某个文件的期望摘要。
 *
 * @param {string} sumsText `shasum -a 256` 的输出
 * @param {string} filename 资产文件名
 * @returns {string|null} 小写十六进制摘要
 */
export function parseSums(sumsText, filename) {
  for (const raw of String(sumsText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // shasum 输出是 `<64位hex>  <文件名>`，分隔符可能是两个空格或 " *"
    const m = line.match(/^([0-9a-fA-F]{64})\s+[* ]?(.+)$/);
    if (m && m[2].trim() === filename) return m[1].toLowerCase();
  }
  return null;
}

// ===========================================================================
// 自动安装 DSHNotch.app（仅 macOS）
// ===========================================================================

/**
 * 检测 app 是否已安装。判据是二进制与自带解压工具都在 —— 只看 .app 目录
 * 在是不够的，早期就发生过「包在但读不到会话」的事故（zstdlite 路径错位）。
 */
export function appInstallState(dir, fsp, pathMod) {
  const app = pathMod.join(dir, 'DSHNotch.app');
  const bin = pathMod.join(app, 'Contents', 'MacOS', 'DSHNotch');
  const zstd = pathMod.join(app, 'Contents', 'Resources', 'zstdlite');
  let hasApp = false, hasBin = false, hasZstd = false;
  try { hasApp = fsp.statSync(app).isDirectory(); } catch { /* 未安装 */ }
  try { hasBin = fsp.statSync(bin).isFile(); } catch { /* 缺二进制 */ }
  try { hasZstd = fsp.statSync(zstd).isFile(); } catch { /* 缺 zstdlite */ }
  return { app, hasApp, hasBin, hasZstd, ok: hasApp && hasBin && hasZstd };
}

/**
 * 确保 DSHNotch.app 就位：没有就下载、校验、装上、启动。
 *
 * 边界（都是有意为之，不是偷懒）：
 * - **只装缺失的**。已存在就一个字节都不动，绝不覆盖用户装过的版本 ——
 *   自动覆盖别人的 app 是不可接受的。
 * - **SHA256 对不上就中止**。下载损坏的二进制再执行，比不装危险得多。
 * - **非 darwin 直接跳过**。Windows 侧还没有 app 形态。
 * - 每一步都打日志：这是「在你机器上下载并运行外部程序」，必须可追溯。
 *
 * @returns {Promise<{ status: string, detail?: string, version?: string, dir?: string }>}
 */
export async function ensureAppInstalled({
  installDir = '/Applications',
  version = 'latest',
  log = () => {},
  dryRun = false,
  nodeArch = process.arch,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin') {
    return { status: 'skip', detail: '非 macOS（' + platform + '），没有 app 形态' };
  }

  const fsp = await import('node:fs/promises');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const crypto = await import('node:crypto');
  const cp = await import('node:child_process');
  const F = fs.default ?? fs;
  const P = pathMod.default ?? pathMod;
  const CP = cp.default ?? cp;
  const { homedir, tmpdir } = os.default ?? os;
  const spawn = CP.spawn;

  const arch = releaseArch(nodeArch);
  if (!arch) return { status: 'skip', detail: '未支持的架构 ' + nodeArch };

  // 目标目录：优先用户指定，不可用就退 ~/Applications（免 sudo 也能装）
  const candidates = [installDir, P.join(homedir(), 'Applications')];
  let target = null;
  for (const dir of candidates) {
    const st = appInstallState(dir, F, P);
    if (st.ok) return { status: 'present', detail: st.app, dir };
    if (st.hasApp) {
      return {
        status: 'broken',
        detail: st.app + ' 存在但不完整（bin=' + st.hasBin + ' zstdlite=' + st.hasZstd + '），不自动覆盖',
        dir,
      };
    }
    if (!target) {
      try { F.mkdirSync(dir, { recursive: true }); F.accessSync(dir, F.constants.W_OK); target = dir; }
      catch { /* 试下一个 */ }
    }
  }
  if (!target) return { status: 'error', detail: '没有可写的安装目录：' + candidates.join(' / ') };

  // 定版本
  let ver = version;
  if (!ver || ver === 'latest') {
    try { ver = await resolveLatestVersion(); log('install: 最新版本 v' + ver); }
    catch (e) { return { status: 'error', detail: '查不到最新版本 — ' + msg(e) }; }
  }
  const asset = 'DSHNotch-' + ver + '-' + arch + '.zip';
  const base = 'https://github.com/' + RELEASE_REPO + '/releases/download/v' + ver + '/';

  if (dryRun) {
    return { status: 'dry-run', version: ver, detail: '将下载 ' + asset + ' 并装到 ' + target };
  }

  // 逐个源试：直连优先，被墙/被拦时退镜像
  const sources = [base, RELEASE_MIRROR + base];
  const work = P.join(tmpdir(), 'dsh-vibe-island-install-' + process.pid);
  let sumsText = null, sumsFrom = null;
  for (const src of sources) {
    try {
      const r = await httpsGet(src + 'SHA256SUMS.txt', { timeoutMs: 20_000 });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const text = r.body.toString('utf8');
      if (!parseSums(text, asset)) throw new Error('校验文件里没有 ' + asset);
      sumsText = text;
      sumsFrom = src;
      break;
    } catch (e) {
      log('install: 校验文件取不到（' + src.slice(0, 40) + '…）— ' + msg(e));
      sumsText = null;
    }
  }
  if (!sumsText || !sumsFrom) {
    return { status: 'error', detail: '两个源都取不到 SHA256SUMS.txt（' + asset + ' 可能还没发布）' };
  }
  const expect = parseSums(sumsText, asset);
  if (!expect) return { status: 'error', detail: '校验文件里没有 ' + asset };

  // 下载 zip
  F.rmSync(work, { recursive: true, force: true });
  F.mkdirSync(work, { recursive: true });
  const zipPath = P.join(work, asset);
  let bytes = 0;
  try {
    log('install: 下载 ' + asset + ' ← ' + sumsFrom.slice(0, 48) + '…');
    const r = await httpsGet(sumsFrom + asset, { timeoutMs: 180_000 });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const buf = r.body;
    bytes = buf.length;
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== expect) {
      F.rmSync(work, { recursive: true, force: true });
      return { status: 'error', detail: 'SHA256 不符，已中止安装\n  期望 ' + expect + '\n  实际 ' + got };
    }
    F.writeFileSync(zipPath, buf);
    log('install: 校验通过 ' + bytes + ' 字节');
  } catch (e) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '下载失败 — ' + msg(e) };
  }

  // 解压（ditto 保留可执行位与代码签名，unzip 会丢）
  const un = P.join(work, 'unpacked');
  F.mkdirSync(un, { recursive: true });
  const ditto = await new Promise((res) => {
    const c = spawn('ditto', ['-x', '-k', zipPath, un], { stdio: ['ignore', 'pipe', 'pipe'] });
    let e2 = '';
    c.stderr.on('data', (d) => { e2 += d.toString(); });
    c.on('error', (error) => res({ code: -1, err: msg(error) }));
    c.on('close', (code) => res({ code, err: e2.trim() }));
  });
  if (ditto.code !== 0) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '解压失败 — ' + (ditto.err || ditto.code) };
  }

  const src = P.join(un, 'DSHNotch.app');
  const st = appInstallState(un, F, P);
  if (!st.ok) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '包里缺 ' + (!st.hasBin ? '主程序' : 'zstdlite') + '，不是可用包' };
  }

  // 下载来的包带 quarantine，Gatekeeper 会直接拦；这是「别人双击装不上」的根因
  try { spawn('xattr', ['-dr', 'com.apple.quarantine', src]); } catch { /* 无所谓 */ }

  // 落位。此刻 target 下确认仍无同名 app —— 宁可失败也不覆盖。
  const dest = P.join(target, 'DSHNotch.app');
  if (F.existsSync(dest)) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: dest + ' 在下载期间被人装上了，放弃以免覆盖' };
  }
  try {
    await fsp.promises.cp(src, dest, { recursive: true, preserveTimestamps: true });
  } catch (e) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '复制到 ' + target + ' 失败 — ' + msg(e) };
  }
  F.rmSync(work, { recursive: true, force: true });
  log('install: 已安装 ' + dest + '（v' + ver + '）');

  // 启动：让用户立刻看到岛，不需要手动双击
  try { spawn('open', [dest], { stdio: 'ignore' }); } catch { /* 装好即可，启动失败不致命 */ }

  return { status: 'installed', version: ver, dir: target, detail: dest };
}

// ===========================================================================
// 生命周期入口
// ===========================================================================

/**
 * 服务端插件入口。
 *
 * 三件事，任何一件失败都只记日志、绝不阻断宿主启动：
 * 1. 注册 settings 命名空间
 * 2. 起本机跳转桥
 * 3. 异步确保 DSHNotch.app 已安装
 */
export function apply(ctx, config) {
  const log = (m) => {
    try { console.log('[dsh-vibe-island] ' + m); } catch { /* ignore */ }
  };

  // ---- 1) 配置 ---------------------------------------------------------
  let handle = null;
  try {
    if (ctx.settings && typeof ctx.settings.register === 'function') {
      handle = ctx.settings.register(NS, Config, { base: config || {} });
    } else {
      console.warn('[dsh-vibe-island] settings 服务不可用，配置将不可持久化');
    }
  } catch (error) {
    // 重复注册（热重载）或存储 section 非法：降级为默认配置，不阻断启动。
    console.warn('[dsh-vibe-island] settings registration fallback: ' + msg(error));
  }

  // 读生效配置。register 的返回形态各版本不一，逐个试，拿不到就用 base。
  const cfg = (() => {
    const base = config && typeof config === 'object' ? config : {};
    if (!handle || typeof handle !== 'object') return base;
    for (const key of ['get', 'value', 'snapshot', 'getSnapshot']) {
      try {
        const raw = typeof handle[key] === 'function' ? handle[key]() : handle[key];
        if (raw && typeof raw === 'object') return { ...base, ...raw };
      } catch { /* 换下一种形态 */ }
    }
    return base;
  })();

  const bridgeEnabled = cfg.bridgeEnabled !== false;
  const bridgePort = Number.isInteger(cfg.bridgePort) && cfg.bridgePort > 1023 ? cfg.bridgePort : BRIDGE_PORT;
  const autoInstall = cfg.autoInstallApp !== false;
  const installDir = typeof cfg.appInstallDir === 'string' && cfg.appInstallDir ? cfg.appInstallDir : '/Applications';

  // ---- 2) 跳转桥 -------------------------------------------------------
  // 异步启动：listen 是异步的，绝不能挡住 apply 返回。
  const bridgeReady = (async () => {
    if (!bridgeEnabled) { log('bridge: 配置关闭，跳转桥未启动'); return null; }
    try {
      return await startBridge({ port: bridgePort, log });
    } catch (e) {
      log('bridge: 启动失败，点击将走降级方案 — ' + msg(e));
      return null;
    }
  })();

  // 把桥挂到 ctx 上：客户端虽在另一个进程用不了，但同进程调试与自检能取到
  try { if (ctx && typeof ctx === 'object') ctx.vibeIsland = { bridgeReady, log, cfg }; }
  catch { /* ctx 可能是只读代理 */ }

  // ---- 3) 自动安装 app -------------------------------------------------
  if (autoInstall) {
    // 丢到微任务之后：apply 必须先返回，下载更不能占着插件加载
    Promise.resolve().then(async () => {
      try {
        const r = await ensureAppInstalled({ installDir, log });
        log('install: ' + r.status + (r.detail ? ' — ' + r.detail : '') + (r.version ? '（v' + r.version + '）' : ''));
      } catch (e) {
        log('install: 异常 — ' + msg(e));
      }
    });
  } else {
    log('install: 配置关闭，未检查 app');
  }
}

/** 停插件时收尾：关桥、清端口文件。 */
export function dispose(ctx) {
  const holder = ctx && ctx.vibeIsland;
  if (!holder || !holder.bridgeReady) return;
  holder.bridgeReady.then((b) => { if (b) b.close(); }).catch(() => {});
}
