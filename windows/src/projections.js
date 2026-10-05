'use strict';
/**
 * 投影读取 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/ProjectionCache.swift`。
 *
 * ## 关键认知：投影不是自己算的，是读 DSH 写的快照
 *
 * 最初的设想是「解析 session.v4.jsonl.zstd 的事件流自己算状态」，
 * 实测发现**做不到也不必做**：
 *
 * 1. 真实会话文件里 `type` 只有 `session` 一种（9 个会话全如此），
 *    拿不到 `tool/call` 之类的事件 —— 那类事件在别的存储里。
 * 2. DSH 自己把算好的投影写在
 *    `~/.dsh/storages/session_projcache/sessions/<id>.json`，
 *    里面有 token 用量、上下文占用、待办、标题、权限预设……
 *    **直接读它比自己算准确得多**（DSH 的口径就是权威口径）。
 *
 * 所以这里是「读快照 + 宽松解析」，不是「算」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshRoot } = require('./session-source.js');

/** mtime+size 缓存：投影每 250ms 查一次，不能每次都读盘解析。 */
const cache = new Map();

/**
 * 会话 id → 投影文件路径。
 *
 * 命名有**两种历史形态**：`session-<id>.json` 与 `<id>.json`
 * —— 实测 15 个文件里两种都有（`75bd1b20-….json` 和
 * `session-19810e4b-….json` 同时存在），所以两种都要试。
 *
 * 兜底再扫一遍目录按子串匹配：命名规则若再变也能命中。
 *
 * @param {string} sessionFile 会话文件路径（`…/<会话目录>/session.v4.jsonl.zstd`）
 * @returns {string|null}
 */
function projectionURL(sessionFile) {
  const dirName = path.basename(path.dirname(sessionFile));
  const id = dirName.startsWith('session-') ? dirName.slice(8) : dirName;
  const base = path.join(dshRoot(), 'storages', 'session_projcache', 'sessions');

  for (const name of [`session-${id}.json`, `${id}.json`]) {
    const u = path.join(base, name);
    if (fs.existsSync(u)) return u;
  }
  // 兜底：按 id 子串匹配
  let listing;
  try {
    listing = fs.readdirSync(base);
  } catch {
    return null;   // 目录不存在 = DSH 没写过投影
  }
  const hit = listing.find((n) => n.includes(id) && n.endsWith('.json'));
  return hit ? path.join(base, hit) : null;
}

/**
 * 读并解析投影。文件未变化时直接返回缓存。
 * @returns {object|null} 解析成功返回投影对象；找不到/坏了返回 null
 */
function load(sessionFile) {
  const url = projectionURL(sessionFile);
  if (!url) return null;

  let st;
  try {
    st = fs.statSync(url);
  } catch {
    return null;
  }
  const hit = cache.get(url);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;

  let data;
  try {
    data = fs.readFileSync(url, 'utf8');
  } catch {
    return null;
  }
  const value = parse(data);
  if (value) cache.set(url, { value, mtimeMs: st.mtimeMs, size: st.size });
  return value;
}

/**
 * 宽松解析：字段缺失/类型变化都不抛错，能拿多少拿多少。
 *
 * 与 Swift 版逐字段对应。`row()` 同时把 seq 推高 —— seq 是
 * 「投影推进到哪一步」的标尺，UI 用它判断数据是否在动。
 */
function parse(text) {
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object') return null;
  const record = root.record;
  if (!record || typeof record !== 'object') return null;
  const rows = record.rows;
  if (!rows || typeof rows !== 'object') return null;

  const p = {
    seq: 0,
    outputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    contextUsed: null,
    contextWindow: null,
    turns: null,
    steps: null,
    llmMs: null,
    toolMs: null,
    hasOpenStep: false,
    pendingCallIds: [],
    pendingAgents: 0,
    todoTotal: 0,
    todoDone: 0,
    todoCurrent: null,
    provider: null,
    modelName: null,
    planActive: false,
    permissionPreset: null,
    title: null,
  };

  /**
   * 取一个 row，并顺带把 seq 推高。
   *
   * ⚠️ `val` **不一定是对象** —— 实测真实文件里：
   *   title    → `val: "高难度数学试卷出题"`   ← 裸字符串！
   *   todos    → `val: null`
   *   plan     → `val: {…}`                    ← 对象
   *
   * 所以这里**不能**只返回 `r.val`（假设它是对象）。
   * Swift 版没这个问题是因为 `JSONSerialization` 产出 `[String: Any]`，
   * 字符串和对象都能承接，`as? [String: Any]` 对字符串会返回 nil，
   * 于是它走了别的分支 —— 但 JS 里若照抄「只认对象」，标题就会整个丢掉。
   *
   * @returns {{ val: any, seq: number|null }}
   */
  const row = (key) => {
    const r = rows[key];
    if (!r || typeof r !== 'object') return null;
    const s = toInt(r.seq);
    if (s !== null) p.seq = Math.max(p.seq, s);
    return { val: r.val, seq: s };
  };

  /** 取 row.val 里的对象形态；不是对象则 null。 */
  const rowObj = (key) => {
    const r = row(key);
    if (!r) return null;
    return (r.val && typeof r.val === 'object' && !Array.isArray(r.val)) ? r.val : null;
  };

  /** 取 row.val 里的字符串形态（含数字的紧凑写法）。 */
  const rowStr = (key) => {
    const r = row(key);
    if (!r) return null;
    return str(r.val);
  };

  const str = (v) => {
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return null;
  };
  const bool = (v) => (typeof v === 'boolean' ? v : null);

  // tokenUsage → totals
  const tu = rowObj('tokenUsage');
  if (tu && typeof tu.totals === 'object' && tu.totals) {
    p.outputTokens = toInt(tu.totals.outputTokens);
    p.uncachedInputTokens = toInt(tu.totals.uncachedInputTokens);
    p.cacheReadTokens = toInt(tu.totals.cacheReadTokens);
  }

  // contextPressure
  const cp = rowObj('contextPressure');
  if (cp) {
    p.contextUsed = toInt(cp.surfaceTokens) ?? toInt(cp.pressureTokens);
    p.contextWindow = toInt(cp.contextWindow);
  }

  // sessionStats：磁盘上有 openStep / pendingCalls，UI 不显示但状态判定要用
  const ss = rowObj('sessionStats');
  if (ss) {
    p.turns = toInt(ss.turns ?? ss.turn);
    p.steps = toInt(ss.steps ?? ss.step);
    p.llmMs = toFloat(ss.llmMs);
    p.toolMs = toFloat(ss.toolMs);
    // ⚠️ openStep 真实形态是 `null`（不是 false/缺省）。
    // 「非 null 即为真」—— 这是 Swift 版 `!(v is NSNull) && v != nil` 的直译。
    p.hasOpenStep = ss.openStep !== null && ss.openStep !== undefined;
    // ⚠️ pendingCalls 真实形态是**对象** `{ callId: {…} }`，不是数组。
    // （Swift 版读 `pending.keys.sorted()` —— 我第一版照抄成数组，
    //   结果真实文件上永远拿到 0 条，状态判定不出「正在执行」。）
    const pc = ss.pendingCalls;
    if (pc && typeof pc === 'object' && !Array.isArray(pc)) {
      p.pendingCallIds = Object.keys(pc).sort();
    } else if (Array.isArray(pc)) {
      // 兜住另一种可能的形态（数组 of string / of {callId}）
      p.pendingCallIds = pc.map((c) => (typeof c === 'string' ? c : c && c.callId)).filter(Boolean);
    }
  }

  // todos
  const td = rowObj('todos');
  if (td) {
    const list = Array.isArray(td.list) ? td.list
      : Array.isArray(td.todos) ? td.todos
        : Array.isArray(td.items) ? td.items : null;
    if (Array.isArray(list)) {
      p.todoTotal = list.length;
      p.todoDone = list.filter((t) => t && t.status === 'completed').length;
      const cur = list.find((t) => t && t.status === 'in_progress');
      p.todoCurrent = (cur && str(cur.content))
        || (list.find((t) => t && t.status === 'pending') && str(list.find((t) => t.status === 'pending').content))
        || null;
    }
  }

  // 标题：实测 `title.val` 是**裸字符串**（不是对象），必须用 rowStr 取
  p.title = rowStr('title');
  if (!p.title) {
    // titleInput 是用户输入的原文（比 title 糙），只在 title 缺失时用。
    // 形态：{ first: { text: "..." }, count: n, lastSeq: m } —— 取 first.text
    const tii = rowObj('titleInput');
    if (tii) {
      if (tii.first && typeof tii.first === 'object') p.title = str(tii.first.text);
      if (!p.title) p.title = str(tii.text) || str(tii.input);
    }
  }

  // 权限预设
  const perm = rowObj('permissions');
  if (perm) {
    p.permissionPreset = str(perm.preset) || str(perm.permissionPreset) || str(perm.mode);
  }

  // 沙箱 / 模型（若存在）
  const sm = rowObj('sandboxMode');
  if (sm) p.provider = p.provider || str(sm.mode);

  // plan 是否激活
  const plan = rowObj('plan');
  if (plan) {
    p.planActive = bool(plan.active) ?? (plan.state === 'active') ?? false;
  }

  return p;
}

/** 宽松取整数：JSON 里可能是 number，也可能是字符串化的数字。 */
function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function toFloat(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ───────────────────────────── 派生量 ─────────────────────────────

/** 上下文占用比例 0…1。宿主 UI 里那颗"上下文环"就是这个算法。 */
function contextFraction(p) {
  if (!p || !p.contextUsed || !p.contextWindow || p.contextWindow <= 0) return null;
  return Math.min(1, p.contextUsed / p.contextWindow);
}

/** 累计输入（未命中缓存 + 缓存命中）。 */
function totalInputTokens(p) {
  if (!p) return null;
  if (p.uncachedInputTokens === null && p.cacheReadTokens === null) return null;
  return (p.uncachedInputTokens || 0) + (p.cacheReadTokens || 0);
}

/**
 * token 数的紧凑写法：1234 → "1.2k"，39369 → "39.4k"，2106768 → "2.1M"。
 * 与 Swift 版 `Projections.shortTokens` 逐档一致。
 */
function shortTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  if (n < 1000) return String(n);
  if (n < 999500) {
    const k = n / 1000;
    return k < 100 ? k.toFixed(1) + 'k' : Math.round(k) + 'k';
  }
  const m = n / 1e6;
  return m < 100 ? m.toFixed(1) + 'M' : Math.round(m) + 'M';
}

/** 投影是否至少有一个字段可用（全空时 UI 退化为纯事件流展示）。 */
function isEmpty(p) {
  return !!p && p.outputTokens === null && p.contextUsed === null && p.turns === null
    && p.todoTotal === 0 && !p.modelName && !p.title && !p.permissionPreset;
}

function invalidate() {
  cache.clear();
}

module.exports = {
  projectionURL,
  load,
  parse,
  contextFraction,
  totalInputTokens,
  shortTokens,
  isEmpty,
  invalidate,
};
