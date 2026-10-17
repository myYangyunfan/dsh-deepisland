'use strict';
/**
 * 活动状态与增量游标 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/Activity.swift` 与 `SessionEvent.swift`。
 *
 * ## ⚠️ 真实数据上的重要落差（别假装不存在）
 *
 * Swift 版的状态是从事件流里的 `tool/call` / `tool/result` / `turn/end`
 * 推出来的。但本机实测的 Windows 会话文件里，**`type` 只有 `session` 一种**
 * —— 拿不到任何 `tool/*`。也就是说：
 *
 * - 这一整套游标在真实数据上**跑不出状态**（永远 idle）；
 * - 真正能用的判定在 `monitor.js` 的 `inferFromProjection()`（读投影的
 *   `openStep` / `pendingCalls` / `seq`）。
 *
 * 那为什么还把它完整搬过来？两个理由：
 * 1. DSH 以后把 `tool/*` 事件写进这个文件，这里**不用改一行**就能重新生效；
 * 2. 删掉它等于把「我们其实拿不到工具事件」这个事实藏起来 —— 留着，
 *    并在 README 里写清楚，下一个人一眼能看见落差在哪。
 */

const STALE_MS = 90_000;      // 与 Swift 版 `staleAfterMs` 一致
const DONE_HOLD_MS = 5_000;   // 与 Swift 版 `doneHoldMs` 一致

/** 状态枚举（字符串值即 Swift 的 rawValue）。 */
const STATUS = {
  IDLE: 'idle',
  THINKING: 'thinking',
  TOOL: 'tool',
  WAITING: 'waiting',
  DONE: 'done',
};

/** 各状态的兜底标题 / 角标 / 光晕色 —— 与插件端 CSS 一致。 */
const STATUS_META = {
  idle: { title: 'DeepSeek 待命', detail: '等待指令输入', badge: 'Ready', glow: '#50505A', priority: 4 },
  thinking: { title: '深度思考中...', detail: '解析任务上下文中', badge: 'Thinking', glow: '#4E7CFF', priority: 2 },
  tool: { title: '执行中', detail: '', badge: 'Executing Tool', glow: '#00D2AA', priority: 1 },
  waiting: { title: '等待人工确认', detail: '', badge: 'Action Required', glow: '#FFAA00', priority: 0 },
  done: { title: '任务已完成', detail: '', badge: 'Done', glow: '#4ADE80', priority: 3 },
};

/** 一次采样的完整快照。字段与 Swift `Activity` 逐一对应。 */
function newActivity() {
  return {
    status: STATUS.IDLE,
    title: STATUS_META.idle.title,
    detail: STATUS_META.idle.detail,
    currentTool: null,
    toolCount: 0,
    isWaitingApproval: false,
    turnStartTime: null,
    turn: null,
    step: null,
    pendingAgents: 0,
    pendingTools: 0,
    proj: null,
  };
}

/** 是否处于活跃态（决定岛收不收起）。`.done` 也算 —— 要让用户看见结果。 */
function isActive(a) {
  return !!a && a.status !== STATUS.IDLE;
}

/** 毫秒 → mm:ss（超一小时给 h:mm:ss）。 */
function formatDuration(ms) {
  if (!(ms > 0) || !Number.isFinite(ms)) return '00:00';
  const total = Math.floor(ms / 1000);
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ───────────────────────── 事件参数的可展示文本 ─────────────────────────

/**
 * 把 `data.arguments`（可能是对象，也可能是「内嵌 JSON 的字符串」）
 * 变成一行人看得懂的字。Swift 版 `FlexibleJSON.displayText` 的直译。
 */
function displayText(value) {
  if (value === null || value === undefined) return null;
  let obj = value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') return pickFrom(parsed);
      } catch { /* 不是 JSON，当纯文本 */ }
    }
    return s;
  }
  if (typeof value !== 'object') return null;
  if (Array.isArray(value)) return null;
  return pickFrom(value);
}

/** 按优先级取一个能代表这次调用的字段。 */
function pickFrom(obj) {
  const first = (...keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
  };
  const c = first('command');
  if (c) return c;
  const p = first('file_path', 'path', 'filePath');
  if (p) return p;
  const pat = first('pattern');
  if (pat) return '搜索 "' + pat + '"';
  const q = first('question');
  if (q) return '提问: ' + q;
  const d = first('description');
  if (d) return d;

  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return null;
  const parts = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    parts.push(k + ': ' + String(v));
  }
  return parts.length ? parts.join(', ') : null;
}

/** 提取助手的思考或文本片段，优先取深度思考 reasoning */
function extractMessageText(d) {
  if (!d) return null;
  if (typeof d.text === 'string' && d.text.trim()) return d.text.trim();
  if (d.message && Array.isArray(d.message.content)) {
    let reasoning = null;
    let normalText = null;
    for (const part of d.message.content) {
      if (part && typeof part.text === 'string' && part.text.trim()) {
        if (part.type === 'reasoning') reasoning = part.text.trim();
        else if (part.type === 'text' || !part.type) normalText = part.text.trim();
      }
    }
    return reasoning || normalText;
  }
  return null;
}

// ────────────────────────────── 游标 ──────────────────────────────

/**
 * 增量事件游标：按 `seq` 单调推进，只处理新事件。
 *
 * 与 Swift 版同一套原则 —— 游标不能依赖数组引用，每次可喂全量事件，
 * 靠 `seq` 去重，所以即使每拍重新解压整个文件也不会重复处理。
 */
class ActivityCursor {
  constructor() {
    this.lastSeq = 0;
    this.toolCount = 0;
    this.turnStart = null;
    this.current = newActivity();
    this.sawTurnEnd = false;
    this.everSawEvent = false;
    this.doneAt = null;
    this.lastEventTime = null;
    this.callNames = new Map();
  }

  /** 被派发子代理的工具名（命中即在「在飞调用」里计入子代理数）。 */
  static get agentTools() {
    return ['subagent', 'send_message'];
  }

  reset() {
    this.lastSeq = 0;
    this.toolCount = 0;
    this.turnStart = null;
    this.current = newActivity();
    this.sawTurnEnd = false;
    this.everSawEvent = false;
    this.doneAt = null;
    this.lastEventTime = null;
    this.callNames.clear();
  }

  /**
   * 推进游标并返回最新快照。
   * @param {Array<object>} events 事件流（可给全量）
   * @param {number} now 当前毫秒时间戳
   * @param {object|null} proj 投影快照
   */
  apply(events, now, proj = null) {
    const list = Array.isArray(events) ? events : [];

    // 文件被截断/替换 → 游标失效，重来
    let maxSeq = -Infinity;
    for (const e of list) {
      if (e && typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
    }
    if (Number.isFinite(maxSeq) && maxSeq < this.lastSeq) this.reset();

    for (const ev of list) {
      if (!ev || typeof ev.seq !== 'number' || ev.seq <= this.lastSeq) continue;
      this.lastSeq = ev.seq;
      this.everSawEvent = true;
      this.lastEventTime = (typeof ev.time === 'number' ? ev.time : now);
      this.handle(ev, now);
    }
    if (!this.everSawEvent) return newActivity();

    // toolCount 是游标的私有累计量，必须显式写进快照
    // （早期漏了这步 → HUD 里「工具调用」永远显示 0 次）
    this.current.toolCount = this.toolCount;

    // 回合结束后的静默期：到点自动转回待命（岛收起）
    if (this.current.status === STATUS.DONE && this.doneAt !== null
        && now - this.doneAt > DONE_HOLD_MS) {
      this.current.status = STATUS.IDLE;
      this.current.title = STATUS_META.idle.title;
      this.current.detail = STATUS_META.idle.detail;
      this.current.currentTool = null;
      this.doneAt = null;
    }

    this.merge(proj);
    return this.current;
  }

  /** 把投影指标并进快照。 */
  merge(p) {
    if (!p) {
      this.current.proj = null;
      this.current.pendingAgents = 0;
      this.current.pendingTools = 0;
      return;
    }
    this.current.proj = p;
    if (this.current.turn === null || this.current.turn === undefined) this.current.turn = p.turns;
    if (this.current.step === null || this.current.step === undefined) this.current.step = p.steps;

    const ids = Array.isArray(p.pendingCallIds) ? p.pendingCallIds : [];
    this.current.pendingTools = ids.length;
    let agents = 0;
    for (const id of ids) {
      const name = this.callNames.get(id);
      if (name && ActivityCursor.agentTools.includes(name)) agents += 1;
    }
    this.current.pendingAgents = agents;
  }

  handle(ev, now) {
    const t = ev.type;
    const d = (ev.data && typeof ev.data === 'object') ? ev.data : {};
    const cur = this.current;

    // 带 turn/step 的事件一律同步
    if (typeof d.turn === 'number') cur.turn = d.turn;
    if (typeof d.step === 'number') cur.step = d.step;

    // 登记 callId → 工具名（用于把投影的在飞 callId 翻成工具名）
    if (t === 'tool/call' && d.callId && d.name) {
      this.callNames.set(d.callId, d.name);
      if (this.callNames.size > 512) this.callNames.clear();
    }

    if (t === 'turn/start' || t === 'user/message') {
      this.toolCount = 0;
      this.sawTurnEnd = false;
      this.doneAt = null;
      // 时间戳在事件顶层（ev.time），不在 ev.data 里
      this.turnStart = (typeof ev.time === 'number' ? ev.time : now);
      cur.turnStartTime = this.turnStart;
      cur.status = STATUS.THINKING;
      cur.title = '正在分析与规划...';
      cur.detail = t === 'user/message' ? '收到指令，正在思考...' : '解析任务上下文中';
      cur.currentTool = null;
      cur.isWaitingApproval = false;
      cur.step = null;
      return;
    }

    if (t === 'step/start') {
      if (cur.status !== STATUS.TOOL && cur.status !== STATUS.WAITING) {
        cur.status = STATUS.THINKING;
        if (cur.title !== '正在分析与规划...') cur.title = STATUS_META.thinking.title;
      }
      return;
    }

    if (t === 'assistant/message' || (typeof t === 'string' && t.startsWith('model/'))) {
      if (cur.status !== STATUS.TOOL) {
        cur.status = STATUS.THINKING;
        if (cur.title !== '正在分析与规划...') cur.title = STATUS_META.thinking.title;
      }
      const msgText = extractMessageText(d);
      if (msgText) {
        cur.detail = msgText.slice(-60);
      }
      return;
    }

    if (t === 'tool/call') {
      const name = d.name || '工具';
      this.toolCount += 1;
      cur.status = STATUS.TOOL;
      cur.currentTool = name;
      const arg = displayText(d.arguments) || name;
      cur.title = '执行 ' + name;
      cur.detail = arg.slice(0, 100);
      // 带 question 的调用表示在等人工确认
      if (arg.startsWith('提问:')) {
        cur.status = STATUS.WAITING;
        cur.isWaitingApproval = true;
      }
      return;
    }

    if (t === 'tool/result') {
      cur.isWaitingApproval = false;
      if (cur.status === STATUS.TOOL || cur.status === STATUS.WAITING) {
        cur.status = STATUS.THINKING;
        cur.title = '分析工具执行结果...';
      }
      return;
    }

    if (t === 'turn/end' || t === 'model/done') {
      cur.status = STATUS.DONE;
      cur.title = STATUS_META.done.title;
      cur.detail = '调用 ' + this.toolCount + ' 次工具';
      cur.currentTool = null;
      cur.isWaitingApproval = false;
      this.sawTurnEnd = true;
      // 用**事件自己的时间**而非 now：App 启动重放历史时，几小时前结束的
      // 回合不该在这里获得一段新的 5 秒回执期
      this.doneAt = (typeof ev.time === 'number' ? ev.time : now);
      return;
    }

    if ((typeof t === 'string' && t.includes('error')) || d.isError === true) {
      cur.status = STATUS.DONE;
      cur.title = '执行遇到注意项';
      cur.detail = '工具返回警告';
      this.doneAt = (typeof ev.time === 'number' ? ev.time : now);
      return;
    }

    // 兜底：兜住「回合已结束但没有 turn/end」的异常序列
    if (cur.status === STATUS.IDLE && !this.sawTurnEnd && this.turnStart !== null) {
      cur.status = STATUS.THINKING;
    }
  }
}

/**
 * 停摆降级：事件流很久没推进 → 把「正在干活」改成待命。
 *
 * 只改快照、不动游标 —— 该会话真收到新事件时会自然恢复。
 * 三种情况不降级：本来就是待命 / `.done`（回执期由 doneAt 管）/ 不知道最后事件时间。
 */
function demoteIfStale(activity, lastEventTime, now) {
  if (!isActive(activity) || activity.status === STATUS.DONE) return activity;
  if (typeof lastEventTime !== 'number') return activity;
  if (now - lastEventTime <= STALE_MS) return activity;
  const a = { ...activity };
  a.status = STATUS.IDLE;
  a.title = STATUS_META.idle.title;
  a.detail = STATUS_META.idle.detail;
  a.currentTool = null;
  a.isWaitingApproval = false;
  a.pendingAgents = 0;
  a.pendingTools = 0;
  return a;
}

module.exports = {
  STATUS,
  STATUS_META,
  STALE_MS,
  DONE_HOLD_MS,
  newActivity,
  isActive,
  formatDuration,
  displayText,
  pickFrom,
  ActivityCursor,
  demoteIfStale,
};
