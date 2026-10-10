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
// apply() 是**同步**函数，写诊断日志不能靠 await import()，必须是顶层静态引入。
// （第一版在函数里写 require('node:fs') —— ESM 作用域没有 require，
//  抛的 ReferenceError 被 catch 吞掉 → 日志永远不生成且无任何痕迹。）
import fsSync from 'node:fs';
import pathSync from 'node:path';

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
const nodeTls = requireSync('node:tls');

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
export async function startBridge({
  port = BRIDGE_PORT,
  log = () => {},
  /**
   * 取「自动安装走到哪一步了」。可选。
   *
   * 为什么由外部注入而不是桥自己维护：安装是 apply() 的活，桥只是把它
   * **报出来** —— 两件事分开，桥才能在自检里单独跑（不需要真去下载）。
   */
  installState = null,
} = {}) {
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
        // 自动安装进度。客户端只有这一个渠道能区分「岛还没出现是因为
        // 正在下载」和「已经失败了」—— 而这两件事该做的处理完全不同。
        install: (() => {
          try { return (typeof installState === 'function' ? installState() : null) || null; }
          catch { return null; }
        })(),
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
// 自动安装 DSHNotch（macOS: .app / Windows: exe）
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
/** `systemCACertificates()` 的进程内缓存；null = 还没读过。 */
let _systemCACache = null;
/** Windows 上读到了几张、从哪读的 —— 诊断用。 */
let _winCaDetail = '';
/**
 * 「经代理隧道现取」的那张签发者 CA —— 进程内缓存。
 *
 * 单独一个缓存而不是并进 `_systemCACache`：这条路的**代价**是发一次网络
 * 请求，而且它只在「存储读不到 + 确实连不上」时才该被触发。混在一起会
 * 让每次调用都去探一遍。
 */
let _proxyIssuerCache = null;

/** 测试用：清掉系统 CA 缓存（真实调用方不需要）。 */
export function resetSystemCACache() {
  _systemCACache = null;
  _winCaDetail = '';
  _proxyIssuerCache = null;
}

/** 诊断：系统 CA 是怎么读出来的（Windows 上用于回答「为什么一张都没读到」）。 */
export function systemCADetail() {
  return _winCaDetail;
}

/**
 * 本进程还能不能起子进程？
 *
 * 为什么要专门探这件事：`certutil` / `powershell` 这条路一旦被环境掐死，
 * 症状是「系统 CA 读到 0 张」，而这个结果和「这台机器真的没装额外 CA」
 * **完全同形**。分不清就会朝错的方向修 —— 本仓库 2026-10-10 实测：
 * 沙箱里 `spawnSync` 起 cmd / certutil / node / where **全部** EBUSY，
 * 于是 certutil 分支永远返回 0 张，看上去像「Windows 证书存储是空的」。
 *
 * 探测用 `where.exe`（Windows 自带、极快、无副作用、不写任何东西）。
 * 结果缓存 —— 这是环境属性，一次加载期内不会变。
 */
let _spawnBlocked = null;
function spawnBlocked() {
  if (_spawnBlocked !== null) return _spawnBlocked;
  try {
    const cp = requireSync('node:child_process');
    const r = cp.spawnSync('where.exe', ['cmd'], { windowsHide: true, timeout: 5_000 });
    // spawn 本身失败（EPERM/EBUSY）时 error 有值；能起但没找到文件也算「能起」。
    _spawnBlocked = !!(r && r.error);
  } catch { _spawnBlocked = true; }
  return _spawnBlocked;
}

/**
 * 经代理隧道探一次对端证书，**只用来诊断**：把「谁在中间签发」问出来。
 *
 * ## 为什么是「诊断」而不是「修复」
 *
 * 曾经想把它当成修复手段：既然系统证书存储读不到，那就顺手在隧道里把
 * 对端证书捞出来、把签发者存成 CA 用。**这条路是死的**，已实测推翻：
 *
 * 本机代理（SteamTools）在握手里**只发 leaf，不发中间证书也不发根** ——
 * 实测 `getPeerCertificate()` 沿 `issuerCertificate` 上溯，链长 = 1。
 * 而 leaf 的长相是：
 *
 *     subject = CN=github.com
 *     issuer  = CN=SteamTools Certificate, OU=Technical Department,
 *               O=BeyondDimension, C=CN
 *     x.ca    = false            ← 不是 CA 证书
 *     x.subject === x.issuer     → false（不是自签）
 *     x.verify(x.publicKey)      → false（自己的公钥验不过自己）
 *
 * 也就是说 **issuer 的公钥根本不在网络上传输**。没有它就没法构造信任锚，
 * 把 leaf 本身塞进 `ca` 也验不通（实测 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。
 *
 * 所以能拿到的只有**名字**。名字有用：它让错误信息从
 * 「unable to verify the first certificate」（用户完全不知道发生了什么）
 * 变成「中间签发者叫 SteamTools Certificate，去它的设置里导出根证书」——
 * 这才是用户能照着做的下一步。
 *
 * 真正的修复方式只有两条，都该由用户做（我们不替他放宽安全边界）：
 *   1. 在该代理/抓包工具里把根证书导出，装进 Windows 证书存储
 *      （「受信任的根证书颁发机构」），certutil 那条路就能读到；
 *   2. 或者导出 PEM 后设 `NODE_EXTRA_CA_CERTS` 环境变量。
 *
 * ⚠️ 这里的 `rejectUnauthorized: false` 是**只读探测**：连接建立后立刻
 * 取证书、立刻断开，不用它传输任何数据。任何**实际请求**都必须走
 * 严格校验（见 httpsGet），这条纪律有断言锁着。
 *
 * @returns {Promise<{issuer:string, subject:string, host:string}|null>}
 */
export async function proxyIssuerName({
  proxy = null,
  host = null,
  port = 443,
  timeoutMs = 8_000,
} = {}) {
  if (_proxyIssuerCache !== null) return _proxyIssuerCache;
  const px = proxy || resolveProxy();
  if (!px) { _proxyIssuerCache = null; return null; }
  // 探谁？优先调用方给的目标（它就是要访问的那个），否则用 GitHub ——
  // 插件的整个下载环节都在 github.com 上，探它最有代表性。
  const probeHost = host || 'github.com';
  const probePort = Number(port) || 443;

  const tls = await import('node:tls');
  let socket = null;
  try {
    socket = await connectThroughProxy(probeHost, probePort, px, timeoutMs);
    const leaf = await new Promise((resolve, reject) => {
      const s = tls.connect({
        socket,
        servername: probeHost,
        // 只读探测，见函数头说明 —— 连上就取、取完就断，不传数据。
        rejectUnauthorized: false,
      }, () => {
        try { resolve(s.getPeerCertificate(false)); } catch (e) { reject(e); }
      });
      s.once('error', reject);
      s.setTimeout(timeoutMs, () => reject(new Error('TLS 探测超时 ' + timeoutMs + 'ms')));
    });
    if (!leaf || !leaf.raw) { _proxyIssuerCache = null; return null; }
    const crypto = await import('node:crypto');
    const x = new crypto.X509Certificate(leaf.raw);
    const cnOf = (s) => {
      const l = String(s || '').split('\n').find((v) => v.startsWith('CN='));
      return l ? l.slice(3) : String(s || '');
    };
    _proxyIssuerCache = {
      issuer: cnOf(x.issuer),
      subject: cnOf(x.subject),
      host: probeHost,
    };
    return _proxyIssuerCache;
  } catch {
    _proxyIssuerCache = null;
    return null;
  } finally {
    try { if (socket) socket.destroy(); } catch { /* 已经关了 */ }
  }
}

/**
 * 读出**系统信任的根证书**（macOS 钥匙串 / Windows 证书存储）。
 *
 * ## 为什么需要它
 *
 * 有些环境会把 TLS 换掉：企业 MITM 网关、抓包工具、部分加速器。
 * 这类 CA 装在**系统证书存储**里、被系统和浏览器信任，但 `node:https`
 * 只认自己内置的那份 Mozilla CA 包 —— 于是报
 * `unable to verify the first certificate`。Node 自己的错误提示就是
 * `try running Node.js with --use-system-ca`，本函数是那件事的等价物。
 *
 * ## Windows 和 macOS 一样会遇到
 *
 * 这不是「只有 Mac 才有的问题」：抓包工具（Fiddler/Charles）与部分企业/加速
 * 代理在 Windows 上同样把 CA 装进系统存储。本机实测就有：
 * `http_proxy=127.0.0.1:61770`，走该代理访问 api.github.com 报
 * `unable to verify the first certificate`，而完全不配 CA 就走不通，
 * 自动安装会直接失败。所以 Windows 分支是**必需**的，不是补好看的。
 *
 * ## ⚠️ 这不是「放宽校验」
 *
 * 证书链仍然照常严格校验（签名、有效期、主机名一个都不少），
 * 只是把「系统认可」的那部分也纳入信任集合。与「把证书校验整个关掉」
 * （rejectUnauthorized 置假）性质完全不同 ——
 * 后者在本仓库是被明令禁止的（见 test-contract 的断言）。
 *
 * 读不到时返回空数组，调用方退回 Node 默认行为。
 *
 * @returns {string[]} PEM 格式证书数组
 */
export function systemCACertificates() {
  if (_systemCACache !== null) return _systemCACache;
  const out = [];
  if (process.platform === 'darwin') {
    // SystemRootCertificates：Apple 预置根证书。
    // System：用户与软件后来装的 —— MITM 代理的 CA 通常落在这里。
    for (const keychain of [
      '/System/Library/Keychains/SystemRootCertificates.keychain',
      '/Library/Keychains/System.keychain',
    ]) {
      try {
        const cp = requireSync('node:child_process');
        const pem = cp.execFileSync(
          '/usr/bin/security',
          ['find-certificate', '-a', '-p', keychain],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
        );
        const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
        let m;
        while ((m = re.exec(pem))) out.push(m[0]);
      } catch { /* 单个钥匙串读不到（锁定/无权限）不影响其余的 */ }
    }
  } else if (process.platform === 'win32') {
    // 用 certutil 把**系统信任存储**里的证书导成 base64。
    //
    // 为什么不用 PowerShell 的 `cert:` 提供程序：它要靠 `powershell.exe`
    // 起子进程，而子进程调用可能在受限环境下直接失败（本仓库实测：
    // `spawnSync powershell.exe EBUSY`）。证书读取是自动安装的**前置步骤**，
    // 一旦它挂掉，症状就是「自动安装永远报证书错」，而且看不出是环境问题。
    // certutil 是 Windows 自带的独立可执行文件，没有 PowerShell 那层宿主依赖。
    //
    // `-silent -split -user`：只导当前用户的存储（这正是 MITM/抓包 CA 的落点），
    // 不弹窗，每张证书输出一行 base64 DER。
    //
    // 必须**逐行看输出而不看退出码**：certutil 在存储为空或部分读取失败时
    // 仍然返回 0，但只打印中文提示。所以判据是「这一行长不长、像不像 base64」。
    for (const store of ['ROOT', 'CA']) {
      try {
        const cp = requireSync('node:child_process');
        const out = cp.execFileSync(
          'certutil.exe',
          ['-user', '-store', store, '-silent', '-split'],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
        );
        for (const line of out.split(/\r?\n/)) {
          const t = line.trim();
          // 证书 DER 的 base64 至少几百字符；短行是标题/提示/分隔线。
          if (t.length < 256 || !/^[A-Za-z0-9+/=]+$/.test(t)) continue;
          out.push('-----BEGIN CERTIFICATE-----\n'
            + (t.match(/.{1,64}/g) || []).join('\n')
            + '\n-----END CERTIFICATE-----');
        }
      } catch { /* 某个存储读不到（权限/策略）不影响另一个 */ }
    }
    _winCaDetail = out.length + ' 张（certutil -user ROOT/CA）';
    if (!out.length) {
      // 读不到有两种原因，**必须分开说**，否则用户和作者都分不清是
      // 「这台机器本来就没装额外的 CA」还是「certutil 根本起不来」：
      //   - 沙箱/安全策略禁止起子进程（本仓库实测 spawnSync 一律 EBUSY）
      //   - 存储确实为空
      // 两者的处置完全不同：前者换个环境就好，后者要去装根证书。
      _winCaDetail += spawnBlocked() ? '；子进程被禁（读取路径不可用）' : '；存储为空';
    }
  }
  _systemCACache = out;
  return _systemCACache;
}

/**
 * 构造 `https.request` 的 `ca` 选项：Node 内置 CA ∪ 系统存储 CA。
 *
 * 没有额外系统 CA 时返回 `undefined`，让调用点写成一行
 * `if (ca) opts.ca = ca`，保持默认行为不变。
 */
function tlsTrustOptions() {
  const extra = systemCACertificates();
  if (!extra.length) return undefined;
  return [...nodeTls.rootCertificates, ...extra];
}

/**
 * 读出本机的 HTTPS 代理设置。
 *
 * 为什么要这个：`node:https` **不读** `HTTPS_PROXY`（只有 curl / fetch 的
 * undici 会）。而国内网络、以及很多带 MITM 的开发环境，`github.com`
 * 直连根本不通 —— 于是插件下载 app 那一步静默失败，用户只看到
 * 「装完没反应」。
 *
 * 读三个来源，按优先级：
 * 1. `node:https` 全局的 `globalAgent` 上挂的 proxy（宿主注入的）
 * 2. `HTTPS_PROXY` / `https_proxy`
 * 3. `HTTP_PROXY` / `http_proxy`
 *
 * ⚠️ **不做「信任所有证书」**。MITM 代理换掉了对端证书（作者机器上实测
 * issuer 是 `SteamTools Certificate`），那属于用户自己装的环境；
 * 我们只负责**按用户的代理设置走**，不负责替他们放宽校验 ——
 * 那是安全边界，不是可用性旋钮。
 *
 * @returns {{host:string, port:number, auth?:string}|null}
 */
export function resolveProxy(env = process.env) {
  // 1) 宿主注入的（Electron / cordis 有时会设 globalAgent proxy）
  try {
    const g = globalThis.https?.globalAgent;
    const p = g && g.proxy;
    if (p) {
      const u = p instanceof URL ? p : new URL(typeof p === 'string' ? p : p.href);
      const auth = u.username
        ? Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64')
        : undefined;
      return { host: u.hostname, port: Number(u.port) || 80, auth };
    }
  } catch { /* 取不到就走env */ }

  // 2/3) 环境变量。NO_PROXY 命中就明确不用代理（本地 profile 也要能跑）。
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (!raw.trim()) return null;
  let u;
  try { u = new URL(/^\w+:\/\//.test(raw) ? raw : 'http://' + raw); } catch { return null; }
  const host = u.hostname;
  if (!host) return null;
  const noProxy = String(env.NO_PROXY || env.no_proxy || '');
  if (noProxy.split(/[\s,]+/).some((e) => e && (host === e.trim() || host.endsWith('.' + e.trim())))) {
    return null;
  }
  const auth = u.username
    ? Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')).toString('base64')
    : undefined;
  return { host, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), auth };
}

/**
 * 向 HTTP 代理发 CONNECT，在返回的 socket 上做 TLS。
 *
 * 只支持 `http://` 代理（CONNECT over plain HTTP）—— 这是
 * `HTTPS_PROXY=http://127.0.0.1:port` 这种本地代理的常见形态。
 * `https://` 代理（代理本身走 TLS）不处理：Node 没有内置客户端，
 * 自己实现不划算，交给用户设 `NODE_EXTRA_CA_CERTS` 走直连即可。
 */
async function connectThroughProxy(targetHost, targetPort, proxy, timeoutMs) {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: {
        Host: targetHost + ':' + targetPort,
        ...(proxy.auth ? { 'Proxy-Authorization': 'Basic ' + proxy.auth } : {}),
      },
    });
    const onFail = (e) => reject(e);
    req.once('connect', (res, socket) => {
      req.removeListener('error', onFail);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理 CONNECT 返回 ' + res.statusCode));
        return;
      }
      resolve(socket);
    });
    req.once('error', onFail);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('代理连接超时 ' + timeoutMs + 'ms')); });
    req.end();
  });
}

async function httpsGet(url, {
  timeoutMs = 30_000,
  maxRedirects = 5,
  followRedirects = true,
  _viaProxy = false,
} = {}) {
  const https = await import('node:https');
  const u = new URL(url);
  // 系统钥匙串里被信任的根证书；没有就算出 undefined，保持 Node 默认行为。
  const trustCA = tlsTrustOptions();

  // 单次请求。`socket` 非空时走已有隧道（代理模式）。
  const once = (socket) => new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': 'dsh-vibe-island/' + PLUGIN_VERSION },
      ...(socket ? { socket, agent: false, host: u.hostname, port: Number(u.port) || 443, servername: u.hostname } : {}),
    };
    // 把「系统已信任的 CA」也纳入信任集合 —— 企业 MITM / 抓包环境必需。
    // 注意这**不是**「关掉证书校验」（rejectUnauthorized 置假）：证书链
    // 照常严格校验，只是信任源多了系统钥匙串那一份
    // （见 systemCACertificates 的说明）。
    if (trustCA) opts.ca = trustCA;
    const req = socket ? https.request(opts) : https.get(url, opts);
    const onErr = (e) => { req.destroy(); reject(e); };
    req.once('response', (res) => {
      const code = res.statusCode || 0;
      const loc = res.headers.location;
      if (code >= 300 && code < 400 && loc) {
        res.resume();   // 必须消费掉，否则 socket 泄漏
        if (socket) socket.destroy();
        // 调用方明确要求「别跟随，把这一跳原样给我」。
        //
        // 与 `maxRedirects` 是**两回事**：后者是"跟随额度用完了"（该报错），
        // 这里是"根本不该跟"（该交回 302）。混在一起会坏掉
        // `resolveLatestVersion` —— 它正是靠读 302 的 Location 解析版本号，
        // 跟随了反而看不到那一跳。
        // （2026-10-09 实测：它原本传 maxRedirects:0 想表达这个意思，
        //   证书一修好、TLS 通了，立刻撞上这个错。）
        if (!followRedirects) {
          resolve({ status: code, headers: res.headers, body: Buffer.alloc(0) });
          return;
        }
        if (maxRedirects <= 0) { reject(new Error('重定向过多（' + code + '）')); return; }
        let next;
        try { next = new URL(loc, url).toString(); } catch (e) { reject(e); return; }
        // 重定向换host 时回到「直连优先」：下一跳要重新决定走不走代理
        httpsGet(next, { timeoutMs, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        if (socket) socket.destroy();
        resolve({ status: code, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => { if (socket) socket.destroy(); reject(e); });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时 ' + timeoutMs + 'ms')); });
    req.once('error', onErr);
    if (!socket) req.end();
  });

  const proxy = _viaProxy ? null : resolveProxy();
  if (!proxy) return once(null);

  // 有代理设置：**先直连**（代理也可能不可用），
  // 只有直连失败才回退到隧道，并把两次的错误都带上 —— 这样诊断日志里
  // 能看出「是直连失败还是代理失败」，不给人一个无信息的 ECONNREFUSED。
  try {
    return await once(null);
  } catch (directErr) {
    let tunnel;
    try {
      tunnel = await connectThroughProxy(u.hostname, Number(u.port) || 443, proxy, timeoutMs);
    } catch (proxyErr) {
      throw new Error(
        '直连失败（' + msg(directErr) + '），走代理 ' + proxy.host + ':' + proxy.port
        + ' 也失败（' + msg(proxyErr) + '）'
      );
    }
    try {
      return await once(tunnel);
    } catch (tunnelErr) {
      // 走到这里说明「直连不通 + 隧道 TLS 建不起来」。Windows 且系统证书存储
      // 读不到时，最常见的成因就是**代理换上了自己的 CA**，而那份 CA 我们
      // 没能从存储里拿到（见 systemCACertificates）。
      //
      // ⚠️ 这里**不能靠隧道自己修**。曾试过「把隧道里拿到的 leaf 当 CA 用」，
      // 实测必然失败：代理只发 leaf、不发链，issuer 的公钥不在网上，
      // 而 leaf 又非自签、非 CA（详见 proxyIssuerName 的说明）。
      //
      // 能做的是**把原因说清楚**：探一次签发者名字，让错误从
      // 「unable to verify the first certificate」变成用户能照着做的指引。
      // 探测本身失败也没关系 —— 退回原来的错误，绝不因为诊断而改变结论。
      let hint = '';
      if (isCertError(tunnelErr) && process.platform === 'win32') {
        try {
          const found = await proxyIssuerName({
            proxy, host: u.hostname, port: Number(u.port) || 443, timeoutMs,
          });
          if (found && found.issuer) {
            hint = '\n  → 中间签发者「' + found.issuer + '」的根证书不在本插件的信任集合里。'
              + '\n    请在该代理/抓包工具里导出根证书并装入 Windows'
              + '「受信任的根证书颁发机构」，'
              + '\n    或导出 PEM 后设环境变量 NODE_EXTRA_CA_CERTS 指向它。';
          }
        } catch { /* 诊断失败不影响主结论 */ }
      }
      throw new Error('经代理 ' + proxy.host + ':' + proxy.port + ' 请求失败：' + msg(tunnelErr) + hint);
    }
  }
}

/** 这个错误是不是「证书链验不过」？只认这一类才去补 CA，别的一律直接报错。 */
function isCertError(e) {
  const c = String((e && (e.code || e.cause?.code)) || '');
  const m = msg(e);
  return c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || c === 'SELF_SIGNED_CERT_IN_CHAIN'
    || c === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || c === 'CERT_SIGNATURE_FAILURE'
    || /unable to verify the first certificate|self.signed certificate|unable to get local issuer/i.test(m);
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
  // followRedirects:false —— 要的就是这一跳本身（读它的 Location），
  // 不是它指向的目的地。见 httpsGet 里的说明。
  const res = await httpsGet(url, { timeoutMs, followRedirects: false });
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
// 自动安装 DSHNotch（macOS: .app / Windows: exe）
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
 * - **非 win32/darwin 直接跳过**。Linux 侧还没有 app 形态。
 * - 每一步都打日志：这是「在你机器上下载并运行外部程序」，必须可追溯。
 *
 * @returns {Promise<{ status: string, detail?: string, version?: string, dir?: string }>}
 */
function requestLaunch(spawnFn, target, log = () => {}) {
  // `open` 对**已在运行**的实例是幂等的：只会把它带到前台，不会起第二个进程。
  // 所以调用方无需先判断「在不在跑」—— 这正是敢无条件调用的原因。
  //
  // spawn 的失败是**异步**的（error 事件），try/catch 兜不住，必须挂监听；
  // 否则 ENOENT 会变成 unhandled 'error' 事件，把插件加载一起带崩。
  try {
    const child = spawnFn('open', [target], { stdio: 'ignore' });
    if (child && typeof child.on === 'function') {
      child.on('error', () => { /* 启动失败不致命，用户仍可手动双击打开 */ });
    }
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch (e) {
    log('install: 启动请求失败 — ' + msg(e));
    return false;
  }
}

/**
 * Windows 侧：检测 DSHNotch 是否就位。
 *
 * 判据与 macOS 侧同口径 —— **不只看目录在不在**：包在但主程序/资源缺了，
 * 症状是「托盘有图标、双击没反应」，早期在 mac 侧就出过这类事故。
 */
export function windowsInstallState(dir, F, P) {
  const exe = P.join(dir, 'DSHNotch.exe');
  const asar = P.join(dir, 'resources', 'app.asar');
  let hasExe = false, hasAsar = false;
  try { hasExe = F.statSync(exe).isFile(); } catch { /* 未安装 */ }
  try { hasAsar = F.statSync(asar).isFile(); } catch { /* 缺资源 */ }
  return { dir, exe, hasExe, hasAsar, ok: hasExe && hasAsar };
}

/**
 * 在 Windows 上启动已安装的 DSHNotch。
 *
 * 用 `spawn` 直接起 exe，而不是逐个窗口找进程去激活 ——
 * Electron 自己有单实例锁：已经在跑时再起一个，内核会把已有的那个带起来
 * 然后自己退出，效果就是「置前」，不会开第二个岛。
 */
function requestWindowsLaunch(spawn, exe, log = () => {}) {
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    if (child && typeof child.on === 'function') {
      child.on('error', (e) => { log('install: 启动失败 — ' + msg(e)); });
    }
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch (e) {
    log('install: 启动请求失败 — ' + msg(e));
    return false;
  }
}

/**
 * 确保 Windows 端的 DSHNotch 已安装并启动。
 *
 * 与 macOS 侧同样的三条纪律：**只装缺失的**、**SHA256 不符就中止**、
 * **每一步都打日志**。差别只在包形态与解压方式：
 *
 * | 环节 | macOS | Windows |
 * |------|-------|---------|
 * | 资产 | `DSHNotch-<ver>-<arch>.zip`（内含 .app） | `DSHNotch-<ver>-win-<arch>.zip`（内含卸载目录） |
 * | 解压 | `ditto` | `powershell Expand-Archive` |
 * | 去隔离 | `xattr -dr com.apple.quarantine` | 不需要（没有 Gatekeeper） |
 * | 装到 | `/Applications` 或 `~/Applications` | `%LOCALAPPDATA%\Programs\DSHNotch` |
 *
 * 装到用户目录而不是 `%ProgramFiles%`：后者要管理员权限，
 * 而插件跑在宿主进程里，不该弹 UAC。
 */
async function ensureWindowsAppInstalled({
  installDir = '',
  version = 'latest',
  log = () => {},
  dryRun = false,
  launch = true,
  spawnImpl = null,
  nodeArch = process.arch,
} = {}) {
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
  const spawn = spawnImpl || CP.spawn;

  // Electron 44 起不再出 32 位包，Windows 侧只认 x64 / arm64
  const archTag = nodeArch === 'x64' ? 'x64' : (nodeArch === 'arm64' ? 'arm64' : '');
  if (!archTag) return { status: 'skip', detail: '未支持的架构 ' + nodeArch };

  const localAppData = process.env.LOCALAPPDATA || P.join(homedir(), 'AppData', 'Local');
  const candidates = [];
  if (installDir && installDir !== '/Applications') candidates.push(installDir);
  candidates.push(P.join(localAppData, 'Programs', 'DSHNotch'));

  let target = null;
  for (const dir of candidates) {
    const st = windowsInstallState(dir, F, P);
    if (st.ok) {
      const launched = launch && !dryRun ? requestWindowsLaunch(spawn, st.exe, log) : false;
      log('install: DSHNotch 已在 — ' + st.exe + (launched ? '（已请求启动）' : ''));
      return { status: 'present', detail: st.exe, dir, launched };
    }
    if (st.hasExe || st.hasAsar) {
      return {
        status: 'broken',
        detail: dir + ' 不完整（exe=' + st.hasExe + ' app.asar=' + st.hasAsar + '），不自动覆盖',
        dir,
      };
    }
    if (!target) {
      // 预演（dryRun）只回答「会装到哪」，一个目录都不建 —— 否则在用户机器上
      // 凭空留个空壳目录，事后还得靠用户自己发现。
      if (dryRun) { target = dir; continue; }
      try { F.mkdirSync(dir, { recursive: true }); F.accessSync(dir, F.constants.W_OK); target = dir; }
      catch { /* 试下一个 */ }
    }
  }
  if (!target) return { status: 'error', detail: '没有可写的安装目录：' + candidates.join(' / ') };

  let ver = version;
  if (!ver || ver === 'latest') {
    try { ver = await resolveLatestVersion(); log('install: 最新版本 v' + ver); }
    catch (e) { return { status: 'error', detail: '查不到最新版本 — ' + msg(e) }; }
  }
  const asset = 'DSHNotch-' + ver + '-win-' + archTag + '.zip';
  const base = 'https://github.com/' + RELEASE_REPO + '/releases/download/v' + ver + '/';

  if (dryRun) {
    return { status: 'dry-run', version: ver, detail: '将下载 ' + asset + ' 并装到 ' + target };
  }

  const sources = [base, RELEASE_MIRROR + base];
  const work = P.join(tmpdir(), 'dsh-vibe-island-win-install-' + process.pid);
  let sumsText = null, sumsFrom = null;
  for (const src of sources) {
    try {
      const r = await httpsGet(src + 'SHA256SUMS.txt', { timeoutMs: 20_000 });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const text = r.body.toString('utf8');
      if (!parseSums(text, asset)) throw new Error('校验文件里没有 ' + asset);
      sumsText = text; sumsFrom = src; break;
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

  F.rmSync(work, { recursive: true, force: true });
  F.mkdirSync(work, { recursive: true });
  const zipPath = P.join(work, asset);
  try {
    log('install: 下载 ' + asset + ' ← ' + sumsFrom.slice(0, 48) + '…');
    const r = await httpsGet(sumsFrom + asset, { timeoutMs: 180_000 });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const buf = r.body;
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== expect) {
      F.rmSync(work, { recursive: true, force: true });
      return { status: 'error', detail: 'SHA256 不符，已中止安装\n  期望 ' + expect + '\n  实际 ' + got };
    }
    F.writeFileSync(zipPath, buf);
    log('install: 校验通过 ' + buf.length + ' 字节');
  } catch (e) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '下载失败 — ' + msg(e) };
  }

  // 解压。Windows 上不引入任何依赖：PowerShell 的 Expand-Archive 随系统带，
  // 且不需要保留可执行位（exe 的权限位在 zip 里本来也不存在）。
  const un = P.join(work, 'unpacked');
  F.mkdirSync(un, { recursive: true });
  const ps = await new Promise((res) => {
    const c = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zipPath)
        + ' -DestinationPath ' + JSON.stringify(un) + ' -Force',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('error', (error) => res({ code: -1, err: msg(error) }));
    c.on('close', (code) => res({ code, err: err.trim() }));
  });
  if (ps.code !== 0) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '解压失败 — ' + (ps.err || ps.code) };
  }

  // zip 里有一层以平台命名的目录（如 DSHNotch-win32-x64），定位到含 exe 的那层
  const exeInUnpacked = findFile(un, 'DSHNotch.exe', 3);
  if (!exeInUnpacked) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '包里没有 DSHNotch.exe，不是可用包' };
  }
  const src = P.dirname(exeInUnpacked);

  if (windowsInstallState(target, F, P).hasExe) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: target + ' 在下载期间被人装上了，放弃以免覆盖' };
  }
  try {
    await fsp.cp(src, target, { recursive: true, preserveTimestamps: true });
  } catch (e) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '复制到 ' + target + ' 失败 — ' + msg(e) };
  }
  F.rmSync(work, { recursive: true, force: true });

  const st = windowsInstallState(target, F, P);
  if (!st.ok) {
    return { status: 'error', detail: '装完校验不通过（exe=' + st.hasExe + ' asar=' + st.hasAsar + '）' };
  }
  log('install: 已安装 ' + st.exe + '（v' + ver + '）');

  if (launch) requestWindowsLaunch(spawn, st.exe, log);
  return { status: 'installed', version: ver, dir: target, detail: st.exe };
}

/** 在 dir 下找 name，最多往下 maxDepth 层。找不到返回 null。 */
export function findFile(dir, name, maxDepth) {
  const walk = (d, depth) => {
    if (depth > maxDepth) return null;
    let entries;
    try { entries = fsSync.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const full = pathSync.join(d, e.name);
      if (e.isFile() && e.name === name) return full;
      if (e.isDirectory()) {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(dir, 0);
}

export async function ensureAppInstalled({
  installDir = '/Applications',
  version = 'latest',
  log = () => {},
  dryRun = false,
  launch = true,
  spawnImpl = null,
  nodeArch = process.arch,
  platform = process.platform,
} = {}) {
  // Windows 走另一条路：包形态、解压方式、安装位置全都不一样，
  // 硬塞进 darwin 分支只会让它两边都难读。
  if (platform === 'win32') {
    return ensureWindowsAppInstalled({
      installDir, version, log, dryRun, launch, spawnImpl, nodeArch,
    });
  }
  if (platform !== 'darwin') {
    return { status: 'skip', detail: '未支持的平台（' + platform + '）' };
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
    if (st.ok) {
      // 「已装」不等于「在跑」。DSH 每次重启，app 不会自己回来 ——
      // 而用户的心理模型是「插件装好了、DSH 也重启了，就该有岛」，
      // 于是症状表现为「插件明明在、也重启了，却始终没有岛」。
      // 这里补上一次启动请求，让「装完即用」与「重启即用」都成立。
      const launched = launch && !dryRun
        ? requestLaunch(spawnImpl || spawn, st.app, log)
        : false;
      log('install: app 已在 — ' + st.app + (launched ? '（已请求启动）' : ''));
      return { status: 'present', detail: st.app, dir, launched };
    }
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
    // ⚠️ 这里 `fsp` 导的是 `node:fs/promises`，`cp` **直接挂在模块上**。
    // 写成 `fsp.promises.cp` 会取到 undefined（那是 `node:fs` 的形态，
    // 两者混用是常见坑）。2026-10-09 实测：证书修好、下载与校验都过了，
    // 就卡在这一行 —— 报 "Cannot read properties of undefined (reading 'cp')"。
    await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true });
  } catch (e) {
    F.rmSync(work, { recursive: true, force: true });
    return { status: 'error', detail: '复制到 ' + target + ' 失败 — ' + msg(e) };
  }
  F.rmSync(work, { recursive: true, force: true });
  log('install: 已安装 ' + dest + '（v' + ver + '）');

  // 启动：让用户立刻看到岛，不需要手动双击
  if (launch) requestLaunch(spawnImpl || spawn, dest, log);

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
  // 日志同时写 console 和文件。
  //
  // 为什么必须有文件那份：DSH 以 GUI 方式启动时插件的 console.log
  // **在终端里看不到**，出问题时（比如 app 下载失败）用户和作者都拿不到
  // 任何信息 —— 只能看到「没反应」。写进
  // `~/Library/Application Support/DSHNotch/plugin-diagnose.log`，
  // 重启 DSH 后直接读这个文件就知道卡在哪一步。
  //
  // 刻意**不记**请求 URL 以外的响应体与任何凭据；这是本地诊断文件。
  //
  // ⚠️ 这里必须用 node: 前缀的静态 import，**不能用 require()** ——
  // 本文件是 ESM（package.json 的 type: module），ESM 作用域里没有
  // `require`，调用它会抛 ReferenceError。第一版就是这么写的，
  // 而那个 ReferenceError 被外层 catch 吞掉 → logFile 恒为 null →
  // **诊断日志永远不生成**，而且看不出任何异常。
  const logFile = (() => {
    try {
      fsSync.mkdirSync(appDataDir(), { recursive: true });
      return pathSync.join(appDataDir(), 'plugin-diagnose.log');
    } catch { return null; }
  })();
  const stamp = () => {
    try { return new Date().toISOString().replace('T', ' ').slice(0, 19); } catch { return '?'; }
  };
  const log = (m) => {
    const line = '[dsh-vibe-island] ' + m;
    try { console.log(line); } catch { /* ignore */ }
    if (!logFile) return;
    try {
      // 首次写入时清空（每次 DSH 启动都是新的一轮排查），
      // 之后追加 —— 保留同一次启动内的先后顺序。
      fsSync.appendFileSync(logFile, stamp() + ' ' + line + '\n');
    } catch { /* 诊断本身不能影响主流程 */ }
  };
  if (logFile) {
    try { fsSync.writeFileSync(logFile, '=== DSH 启动 ' + stamp() + ' ===\n'); } catch { /* ignore */ }
    log('诊断日志: ' + logFile);
    log('平台=' + process.platform + ' arch=' + process.arch + ' node=' + process.version);
  }

  // ---- 1) 配置 ---------------------------------------------------------
  let handle = null;
  try {
    if (ctx.settings && typeof ctx.settings.register === 'function') {
      handle = ctx.settings.register(NS, Config, { base: config || {} });
    } else {
      log('settings 服务不可用，配置将不可持久化');
    }
  } catch (error) {
    // 重复注册（热重载）或存储 section 非法：降级为默认配置，不阻断启动。
    log('settings registration fallback: ' + msg(error));
  }

  // ---- 1b) 首次安装：预写一份正确默认配置 -----------------------------
  //
  // 为什么必须由服务端做这件事：
  //
  // `client-config.json` 是原生 app 的权威配置源，而设置面板开关的初始
  // 状态来自「读到的值」。文件**不存在**时读回来是空对象，于是客户端那套
  // 取反逻辑会走成：
  //
  //     读不到 → `cfg.notchEnabled !== false` 为 true（视为已开启）
  //     → 用户没看到岛、以为没开，点一下想开启
  //     → `!(true)` 写入 false → **真把岛关了**
  //
  // 这不是假想：本机 2026-10-09 连清两次环境、连装两次插件，每次新
  // 装完 `client-config.json` 都变成 `{"notchEnabled":false}`，症状
  // 与「插件没装好」完全一样，极难分辨。预先落一份明确值即可根治。
  //
  // 值取用户实测认可的状态（`notchEnabled:true` + 常驻不收起），
  // 与 app 侧默认（`notchEnabled=true`）一致，只是额外关掉空闲收起。
  //
  // **只在文件不存在时写**：文件已存在说明用户（或 app 菜单）表达过意愿，
  // 覆盖它等于把用户关掉的岛又打开 —— 那是另一个 bug。
  try {
    const cfgFile = configFilePath();
    if (!nodeFs.existsSync(cfgFile)) {
      const r = writeConfig(JSON.stringify({ notchEnabled: true, hideWhenIdle: false }));
      log('首次安装：写入默认配置 → ' + JSON.stringify(r.config || {}));
    }
  } catch (e) {
    log('写默认配置失败（不致命）: ' + msg(e));
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
  //
  // installResult 先声明在桥**之前**：桥的 /health 要把它报出去，
  // 而安装要等桥起来之后才跑（不能占着插件加载）。顺序反了就只能拿到 undefined。
  /** 自动安装进度，供 /health 与设置面板查看「装到哪一步了」。 */
  let installResult = { status: 'pending' };

  const bridgeReady = (async () => {
    if (!bridgeEnabled) { log('bridge: 配置关闭，跳转桥未启动'); return null; }
    try {
      return await startBridge({ port: bridgePort, log, installState: () => installResult });
    } catch (e) {
      log('bridge: 启动失败，点击将走降级方案 — ' + msg(e));
      return null;
    }
  })();

  // 把桥挂到 ctx 上：客户端虽在另一个进程用不了，但同进程调试与自检能取到
  try {
    if (ctx && typeof ctx === 'object') {
      ctx.vibeIsland = {
        bridgeReady, log, cfg,
        // 读安装进度要**函数**而不是值：安装是异步的，挂上去的那一刻
        // installResult 还是 pending，直接存值就永远停在 pending 了。
        installResult: () => installResult,
      };
    }
  } catch { /* ctx 可能是只读代理 */ }

  // ---- 3) 自动安装 app -------------------------------------------------
  if (autoInstall) {
    // 丢到微任务之后：apply 必须先返回，下载更不能占着插件加载
    Promise.resolve().then(async () => {
      try {
        // 第 1 步先探「在不在」—— 这是**同步**的，其实在 ensureAppInstalled 里
        // 也做了一遍；这里提前做是为了在**下载开始之前**就把状态说清楚。
        // 这个功能是「往你机器上下载并运行外部程序」，用户有权知道正在发生什么。
        installResult = { status: 'checking' };
        const r = await ensureAppInstalled({ installDir, log });
        installResult = r;
        log('install: ' + r.status + (r.detail ? ' — ' + r.detail : '') + (r.version ? '（v' + r.version + '）' : ''));
      } catch (e) {
        installResult = { status: 'error', detail: msg(e) };
        log('install: 异常 — ' + msg(e));
      }
    });
  } else {
    installResult = { status: 'skip', detail: '配置关闭' };
    log('install: 配置关闭，未检查 app');
  }
}

/** 停插件时收尾：关桥、清端口文件。 */
export function dispose(ctx) {
  const holder = ctx && ctx.vibeIsland;
  if (!holder || !holder.bridgeReady) return;
  holder.bridgeReady.then((b) => { if (b) b.close(); }).catch(() => {});
}
