'use strict';
/**
 * 会话数据源 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/SessionSource.swift`，行为一一对应。
 * 那一侧有详细的中文注释说明「为什么这么设计」，这里只保留决策要点，
 * 需要看完整推导去读 Swift 版。
 *
 * DSH 的目录布局：
 * ```
 * ~/.dsh/sessions/<项目目录名>/<会话目录名>/session.v4.jsonl.zstd
 *     --Users-delinger-Desktop-office--   session-a59ae858-…
 * ```
 *
 * ## 与 macOS 版的关键差异：zstd
 *
 * macOS 版要**自带 zstdlite 二进制**（系统与 DSH 运行时都不提供 libzstd），
 * Windows 版不需要 —— Node 22+ 的 `zlib.zstdDecompressSync` 内置 zstd 解压。
 * 已在宿主自带的 Node 24.18.1 与开发用 Node 22 上各验过真实会话文件。
 *
 * 若运行环境的 Node < 22.15（zstd 落地版本），`decompress()` 会返回 null
 * 并给出明确原因 —— 表现为「读不到会话」，而不是崩。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

/** 同时监控的会话数上限。超过就只取 mtime 最新的几个。与 Swift 版一致。 */
const MAX_SESSIONS = 6;

/**
 * 「活跃」窗口：最近这个时间内有写入的会话才进候选。
 * 30 分钟足够覆盖「同时开着的几个对话」。
 * 与 Swift 版 `SessionSource.activeWindow` 一致。
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/** DSH 根目录（`~/.dsh`）。可用 `DSH_ROOT` 覆盖，测试用。 */
function dshRoot() {
  return process.env.DSH_ROOT
    ? path.resolve(process.env.DSH_ROOT)
    : path.join(os.homedir(), '.dsh');
}

/**
 * 会话文件及其元信息。
 * @typedef {{ id: string, project: string, file: string, mtimeMs: number, size: number }} SessionFileInfo
 */

/** 按 mtime 倒序返回候选会话文件。 */
function sessionFiles(opts = {}) {
  const maxCount = opts.maxCount ?? MAX_SESSIONS;
  const activeWithin = opts.activeWithin ?? ACTIVE_WINDOW_MS;

  const all = scanAllSessionFiles();
  const cutoff = Date.now() - activeWithin;

  let recent = all.filter((f) => f.mtimeMs >= cutoff).sort((a, b) => b.mtimeMs - a.mtimeMs);
  // 活跃窗口内一个都没有（刚开机、DSH 还没开始干活）→ 退化为全量最新 1 个，
  // 面板仍然有东西可显示，而不是空白。
  if (recent.length === 0) {
    recent = all.slice().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 1);
  }
  return recent.slice(0, maxCount);
}

/** 最新的单个会话文件（单目标场景用）。 */
function latestSessionFile() {
  const f = sessionFiles({ maxCount: 1 });
  return f.length ? f[0].file : null;
}

let cachedScan = null;
let lastScanTime = 0;
const SCAN_CACHE_MS = 800;

/** 递归找出所有 `session.v4.jsonl.zstd`。带 800ms 快速缓存，避免 250ms 高频全盘递归。 */
function scanAllSessionFiles() {
  const now = Date.now();
  if (cachedScan && (now - lastScanTime < SCAN_CACHE_MS)) {
    // 命中短期缓存：仅快速刷新前 3 个活跃文件的 stat，毫秒级返回
    for (let i = 0; i < Math.min(3, cachedScan.length); i++) {
      try {
        const st = fs.statSync(cachedScan[i].file);
        cachedScan[i].mtimeMs = st.mtimeMs;
        cachedScan[i].size = st.size;
      } catch {}
    }
    return cachedScan.slice();
  }

  const sessionsDir = path.join(dshRoot(), 'sessions');
  const out = [];
  if (!fs.existsSync(sessionsDir)) {
    cachedScan = out;
    lastScanTime = now;
    return out;
  }

  // 手写递归而不是用 withFileTypes 的迭代器：DSH 的目录层级很浅
  // （sessions/<项目>/<会话>/文件），但项目目录可能很多，
  // 迭代器在深层目录上有踩坑记录，这里只要三层。
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;   // 权限/竞态：跳过这一层，不影响其它
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;         // 跳过隐藏
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (e.name !== 'session.v4.jsonl.zstd') continue;

      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const sessionDir = path.dirname(full);
      out.push({
        id: path.basename(sessionDir),          // = 会话 id
        project: path.basename(path.dirname(sessionDir)),
        file: full,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  };
  walk(sessionsDir, 0);

  cachedScan = out;
  lastScanTime = now;
  return out;
}

/**
 * 把 DSH 的项目目录名还原成人看得懂的名字（**兜底**用）。
 *
 * `--Users-delinger-Desktop-deepisland--` → `deepisland`
 * 规则：去掉首尾连字符（DSH 用 `--` 包裹路径），再把 `-` 当分隔符取最后一段。
 *
 * 与 Swift 版 `prettyProject` 行为一致（注意它要求末段长度 ≥ 2）。
 */
function prettyProject(raw) {
  const trimmed = String(raw || '').replace(/^-+|-+$/g, '');
  if (!trimmed) return null;
  const parts = trimmed.split('-').filter(Boolean);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1];
  if (last.length < 2) return null;
  return last;
}

// ────────────────────────────── 读取与解压 ──────────────────────────────

/** mtime+size 缓存：避免每 250ms 重新解压同一个文件。 */
const eventCache = new Map();

/** zstd 帧标准魔数 0xFD2FB528 (小端序 28 b5 2f fd) */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 读并解码某个会话文件的事件流。
 * @returns {Array<object>|null} 解码成功的事件数组；读不到/解压失败返回 null
 */
function loadEvents(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;   // 会话刚被删/正在写
  }

  const hit = eventCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;

  const raw = decompress(file);
  if (raw === null) return null;

  const events = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch { /* 单行坏掉不该让整份失效 */ }
  }
  eventCache.set(file, { events, mtimeMs: st.mtimeMs, size: st.size });
  return events;
}

/** 读最新会话的事件流。 */
function loadLatestEvents() {
  const f = latestSessionFile();
  return f ? (loadEvents(f) || []) : [];
}

/**
 * zstd 多帧串联流解压。
 * DSH 在会话过程中是按帧追加写入的（multi-frame concatenated zstd stream）。
 * Node 内置的 zlib.zstdDecompressSync 单次只解压第 1 帧，必须切片解压全部帧并合并。
 * @returns {string|null} 解压后的文本；不可用/失败返回 null
 */
function decompress(file) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return null;
  }
  // 极小文件直接判空（仅 zstd 帧头）—— 与 Swift 版一致
  if (data.length <= 32) return '';

  // Node 22.15+ / 23.8+ / 24+ 内置 zstd。Electron 自带的 Node 属于这一档。
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return null;
  }

  // 1. 快速单帧探测
  const first = data.indexOf(ZSTD_MAGIC);
  if (first === -1) {
    try {
      return zlib.zstdDecompressSync(data).toString('utf8');
    } catch {
      return null;
    }
  }

  const second = data.indexOf(ZSTD_MAGIC, first + 4);
  if (second === -1) {
    // 只有 1 个标准帧
    try {
      return zlib.zstdDecompressSync(data).toString('utf8');
    } catch {
      return null;
    }
  }

  // 2. 多帧流：定位所有帧魔数并循环解压合并
  const chunks = [];
  const offsets = [];
  let pos = first;
  while (pos !== -1) {
    offsets.push(pos);
    pos = data.indexOf(ZSTD_MAGIC, pos + 4);
  }

  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = (i + 1 < offsets.length) ? offsets[i + 1] : data.length;
    const slice = data.subarray(start, end);
    try {
      chunks.push(zlib.zstdDecompressSync(slice).toString('utf8'));
    } catch {
      // 容错：写到一半的文件末尾帧可能被截断，跳过不崩溃
    }
  }

  return chunks.length > 0 ? chunks.join('') : null;
}

/** 清空缓存（自检用；正常路径靠 mtime 自动失效）。 */
function invalidate() {
  eventCache.clear();
  cachedScan = null;
  lastScanTime = 0;
}

module.exports = {
  MAX_SESSIONS,
  ACTIVE_WINDOW_MS,
  dshRoot,
  sessionFiles,
  latestSessionFile,
  scanAllSessionFiles,
  prettyProject,
  loadEvents,
  loadLatestEvents,
  decompress,
  invalidate,
};
