'use strict';
/**
 * 岛的运行配置 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/IslandConfig.swift`，语义一一对应。
 *
 * ## 这份文件为什么存在
 *
 * 插件的设置面板（渲染进程）改不了本机 app，app 也不该反过来依赖插件在跑。
 * 于是两边共用**同一份文件**：
 *
 * ```text
 * 设置面板 ──POST /config──▶ 插件服务端（Node）──▶ client-config.json
 *                                                        │
 *                              本 app（Electron）◀── 读同一份 ◀──┘
 * ```
 *
 * ## 路径必须与插件服务端一致
 *
 * `lib/index.js` 的 `appDataDir()` 在 Windows 上取
 * `%APPDATA%\DSHNotch`（`APPDATA` 缺失时退 `%USERPROFILE%\AppData\Roaming`）。
 * 这里照抄同一套判定，否则会出现「设置里点了没反应」—— 那是本仓库早期
 * 在 macOS 上真发生过的事故（两边各写各的目录）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * 允许写回的键。与插件服务端 `CONFIG_ALLOWED` 白名单保持一致 ——
 * 写进去会被忽略的键不该留在文件里误导下一个人。
 */
const WHITELIST = [
  'enabled', 'notchEnabled', 'jumpEnabled', 'hideWhenIdle', 'scale',
  'placement', 'platformMode', 'glowEffect', 'expandOnHover',
  'showSubagentCount', 'bridgeEnabled',
];

/** `%APPDATA%\DSHNotch` —— 与 `lib/index.js` 的 `appDataDir()` 同判定。 */
function appDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
      || (process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming')
        : null);
    return appData
      ? path.join(appData, 'DSHNotch')
      : path.join(os.homedir(), 'DSHNotch');
  }
  // 非 Windows（比如有人在 macOS 上跑自检）：退回 macOS 侧的位置，方便对照
  return path.join(os.homedir(), 'Library', 'Application Support', 'DSHNotch');
}

/**
 * 配置文件路径。`DSH_NOTCH_CONFIG` 只给自检用 —— 自检必须在沙箱路径上跑，
 * 否则一跑就把用户的真实设置搅了。
 */
function storePath() {
  if (process.env.DSH_NOTCH_CONFIG) return path.resolve(process.env.DSH_NOTCH_CONFIG);
  return path.join(appDataDir(), 'client-config.json');
}

/** 默认值。**缺字段不等于关闭** —— 这是 Swift 版定下的口径，别改。 */
function defaultValue() {
  return {
    domIslandEnabled: true,   // 窗口内 DOM 岛（已废弃，仅兼容旧配置）
    notchEnabled: true,       // 本机岛是否显示 —— 设置面板真正控制的是这个
    jumpEnabled: true,        // 点岛上的对话是否直接跳会话
    idleHide: true,           // 空闲自动收起
    scale: 1.0,
    raw: {},
    fileExists: false,
  };
}

let cache = null;
let cachedStamp = '';

/**
 * "mtime-大小"。不用 mtime 单独判：某些文件系统只精确到秒，
 * 同一秒内改两次会漏。拼上大小几乎不可能撞。
 */
function currentStamp(file) {
  try {
    const st = fs.statSync(file);
    return Math.floor(st.mtimeMs) + '-' + st.size;
  } catch {
    return '';
  }
}

/** 读配置。结果缓存到文件变化为止（每 250ms 调用也只是一次 stat）。 */
function load() {
  const file = storePath();
  const stamp = currentStamp(file);
  if (cache && stamp === cachedStamp) return cache;

  const value = defaultValue();
  value.fileExists = stamp !== '';

  if (stamp !== '') {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (obj && typeof obj === 'object') {
        value.raw = obj;
        // 只认真正的 Bool。JSON 里 "false" 之类不该当布尔用 ——
        // 服务端已做白名单，这里再挡一层，防手改文件写坏类型。
        if (typeof obj.enabled === 'boolean') value.domIslandEnabled = obj.enabled;
        if (typeof obj.notchEnabled === 'boolean') value.notchEnabled = obj.notchEnabled;
        if (typeof obj.jumpEnabled === 'boolean') value.jumpEnabled = obj.jumpEnabled;
        if (typeof obj.hideWhenIdle === 'boolean') value.idleHide = obj.hideWhenIdle;
        if (typeof obj.scale === 'number' && obj.scale >= 0.5 && obj.scale <= 2.0) {
          value.scale = obj.scale;
        }
      }
    } catch { /* 文件半截/损坏 → 用默认值，不崩 */ }
  }

  cache = value;
  cachedStamp = stamp;
  return value;
}

/** 强制下次 `load()` 重新读盘（自检用；正常路径靠 stamp 自动失效）。 */
function invalidate() {
  cache = null;
  cachedStamp = '';
}

/**
 * 写回磁盘，让插件设置面板下次读到。
 *
 * 原子替换：直接覆写时中途被杀会留下半截 JSON，下次读失败就悄悄退回默认值，
 * 用户会以为设置丢了。Windows 上 `renameSync` 覆盖已存在的文件是被允许的，
 * 但偶尔会因为句柄占用给 EBUSY —— 那时退 copyFile。
 */
function save(value) {
  const obj = { ...(value.raw || {}) };
  obj.enabled = value.domIslandEnabled;
  obj.notchEnabled = value.notchEnabled;
  obj.jumpEnabled = value.jumpEnabled;
  obj.hideWhenIdle = value.idleHide;
  obj.scale = value.scale;
  for (const k of Object.keys(obj)) {
    if (!WHITELIST.includes(k)) delete obj[k];
  }

  const file = storePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch { /* 留着也无碍 */ }
    }
    invalidate();
    return true;
  } catch (e) {
    console.error('[dsh-notch] 配置写入失败:', e && e.message);
    return false;
  }
}

/** 当前是否该显示岛。 */
function notchVisible() {
  return load().notchEnabled;
}

/** 切换岛的显示，返回切换后的值。 */
function toggleNotch() {
  const v = { ...load() };
  v.notchEnabled = !v.notchEnabled;
  return save(v) ? v.notchEnabled : load().notchEnabled;
}

/** 只比影响行为的字段（自检用）。raw 不参与 —— 见 Swift 版注释。 */
function equalBehavior(a, b) {
  return a.domIslandEnabled === b.domIslandEnabled
    && a.notchEnabled === b.notchEnabled
    && a.jumpEnabled === b.jumpEnabled
    && a.idleHide === b.idleHide
    && a.scale === b.scale
    && a.fileExists === b.fileExists;
}

module.exports = {
  WHITELIST,
  appDataDir,
  storePath,
  defaultValue,
  load,
  invalidate,
  save,
  notchVisible,
  toggleNotch,
  equalBehavior,
};
