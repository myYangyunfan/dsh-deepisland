'use strict';
/**
 * 多会话监控器 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/SessionMonitor.swift`，
 * 并**新增**了 `inferFromProjection()` —— 这一块是 Windows 版独有的，原因见下。
 *
 * ## 为什么要自己推状态
 *
 * Swift 版的状态来自事件流里的 `tool/call` / `turn/end`。但本机实测的
 * Windows 会话文件里 `type` 只有 `session` 一种，游标跑不出任何状态
 * （`activity.js` 里完整保留了游标，是为了 DSH 以后补上事件时能直接生效）。
 *
 * 于是这里改成**读投影推进状态**：投影里有 `openStep`（当前有没有开着的步骤）
 * 与 `pendingCalls`（在飞的调用 id），这两项足以区分「在跑 / 不在跑」。
 * 口径是 DSH 自己写的，比我们自己猜准。
 *
 * ## 仍然做不到的事（别装作能做到）
 *
 * - 拿不到**具体工具名**：投影只给 callId，事件流不给 callId→名字的映射。
 *   所以在飞时只能显示「N 个调用在飞」，不能显示「执行 bash」。
 * - 拿不到「回合结束」事件：`.done` 是由「刚才还在跑、现在不跑了」反推的，
 *   保留 5 秒回执期。它表示「刚才那轮结束了」，不代表 DSH 主动宣告完成。
 */

const fs = require('node:fs');
const source = require('./session-source.js');
const projections = require('./projections.js');
const act = require('./activity.js');

const { STATUS, STATUS_META, STALE_MS, DONE_HOLD_MS, ActivityCursor, demoteIfStale } = act;

/** 非主会话每多少个 tick 刷新一次（主会话每 tick 都刷）。与 Swift 版一致。 */
const SECONDARY_REFRESH_EVERY = 4;

/**
 * 投影的 seq 停摆多久就不再当「在跑」（毫秒）。
 *
 * 比 STALE_MS 短得多，因为 seq 是「DSH 推进到哪一步」的直接标尺：
 * 它在动就说明这一轮还活着。文件 mtime 会因为别的原因变，seq 不会。
 */
const SEQ_STALE_MS = 20_000;

/**
 * 「会话文件刚被写过」的判定窗口（毫秒）。
 *
 * ## 为什么要有这个兜底（这是实测逼出来的，不是拍脑袋）
 *
 * 扫过本机 174 份历史投影：
 * - `hasOpenStep = true` 的只有 **3 份**；
 * - `pendingCalls > 0` 的 **0 份**。
 *
 * 也就是说「有调用在飞」这个信号在这台机器上从来没被抓到过 —— 只靠
 * openStep/pendingCalls 判定，岛会几乎恒为「待命」，那就失去了存在的意义。
 *
 * 于是补一条：**会话文件在 8 秒内被写过** 就算在跑。DSH 干活时会持续往
 * `session.v4.jsonl.zstd` 追加事件，这个信号是「真的在动」的直接证据，
 * 比任何投影字段都即时。
 *
 * ⚠️ 它是**启发式**，不是 DSH 的权威状态：若 DSH 在空闲时也定期写文件，
 * 这里会误报。真机上若发现岛一直显示「思考中」，把这里调小或置 0 即可
 * —— 置 0 等于退回「只认投影字段」。
 */
const LIVE_WRITE_MS = 8_000;

/** id 短码（去掉 `session-` 前缀后取前 8 位）。 */
function shortId(id) {
  const s = String(id || '').startsWith('session-') ? String(id).slice(8) : String(id);
  return s.slice(0, 8);
}

/**
 * 由投影推进状态 —— Windows 版的核心。
 *
 * @param {object} prev 该会话上一轮的私有跟踪量（会被就地修改）
 * @param {object|null} proj 投影快照
 * @param {number} now 当前毫秒
 * @param {number} activityMs 会话文件最后的写入时间
 * @returns {object} Activity
 */
function inferFromProjection(prev, proj, now, activityMs) {
  const idle = () => {
    const a = act.newActivity();
    a.proj = proj || null;
    return a;
  };

  if (!proj) return idle();

  const pending = Array.isArray(proj.pendingCallIds) ? proj.pendingCallIds.length : 0;
  const busySignal = pending > 0 || proj.hasOpenStep || proj.planActive;

  // 文件很久没写 → 这一轮早结束了（DSH 关了 / 会话被弃用）
  if (!(now - activityMs < STALE_MS)) {
    prev.wasActive = false;
    prev.doneUntil = 0;
    return idle();
  }

  // 兜底信号：会话文件刚被写过 → 它确实在动（见 LIVE_WRITE_MS 的注释）
  const freshWrite = now - activityMs < LIVE_WRITE_MS;

  if (busySignal || freshWrite) {
    // seq 停摆超过 SEQ_STALE_MS，说明「步骤开着但没在推进」——多半是残留状态
    if (pending === 0 && prev.seq === proj.seq
        && prev.seqAt && now - prev.seqAt > SEQ_STALE_MS) {
      // 不当成在跑
    } else {
      prev.wasActive = true;
      prev.doneUntil = 0;
      const a = act.newActivity();
      a.proj = proj;
      a.status = pending > 0 ? STATUS.TOOL : STATUS.THINKING;
      a.title = pending > 0 ? STATUS_META.tool.title : STATUS_META.thinking.title;
      a.detail = pending > 0
        ? pending + ' 个调用在飞'
        : (proj.todoCurrent || STATUS_META.thinking.detail);
      a.pendingTools = pending;
      a.turn = proj.turns ?? null;
      a.step = proj.steps ?? null;
      if (prev.seq !== proj.seq) { prev.seq = proj.seq; prev.seqAt = now; }
      return a;
    }
  }

  // 由「在跑」转「不在跑」→ 给 5 秒回执期，避免跑完什么都没看见
  if (prev.wasActive) {
    prev.wasActive = false;
    prev.doneUntil = now + DONE_HOLD_MS;
  }
  if (now < prev.doneUntil) {
    const a = act.newActivity();
    a.proj = proj;
    a.status = STATUS.DONE;
    a.title = STATUS_META.done.title;
    a.detail = '本轮已结束';
    a.turn = proj.turns ?? null;
    a.step = proj.steps ?? null;
    return a;
  }
  return idle();
}

class SessionMonitor {
  /**
   * @param {{ activeWindow?: number, verbose?: boolean }} opts
   */
  constructor(opts = {}) {
    this.activeWindow = opts.activeWindow ?? source.ACTIVE_WINDOW_MS;
    this.verbose = opts.verbose
      ?? (process.env.DSH_NOTCH_VERBOSE !== undefined && process.env.DSH_NOTCH_VERBOSE !== '');
    this.states = new Map();
    this.primaryId = null;
  }

  /**
   * 轮询一次，返回按关注度排序的会话列表（第 0 个即主会话）。
   * @param {number} now 毫秒时间戳
   * @param {number} tickIndex 轮询序号（非主会话降频用）
   */
  poll(now = Date.now(), tickIndex = 0) {
    const files = source.sessionFiles({ activeWithin: this.activeWindow });
    const alive = new Set();
    const result = [];

    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      alive.add(f.id);

      const isPrimary = (f.id === this.primaryId) || (this.primaryId === null && i === 0);
      const due = isPrimary || !this.states.has(f.id)
        || tickIndex % SECONDARY_REFRESH_EVERY === 0;

      if (due) {
        const events = source.loadEvents(f.file) || [];
        const proj = projections.load(f.file);

        let st = this.states.get(f.id);
        if (!st) {
          st = {
            cursor: new ActivityCursor(),
            prev: { wasActive: false, doneUntil: 0, seq: -1, seqAt: 0 },
            entry: {
              id: f.id,
              file: f.file,
              project: f.project,
              mtimeMs: f.mtimeMs,
              label: shortId(f.id),
              activity: act.newActivity(),
            },
          };
        }

        // 先走事件游标（DSH 若写了 tool/* 事件，这里直接出结果）
        let activity = st.cursor.apply(events, now, proj);
        // 游标跑不出状态（真实数据现状）→ 由投影推
        if (activity.status === STATUS.IDLE) {
          activity = inferFromProjection(st.prev, proj, now, f.mtimeMs);
        } else {
          activity = demoteIfStale(activity, st.cursor.lastEventTime, now);
          // 事件流给不出时，用投影兜住「在跑」的判定
          st.prev.wasActive = act.isActive(activity);
        }

        st.entry.activity = activity;
        st.entry.label = (proj && proj.title) || source.prettyProject(f.project) || shortId(f.id);
        this.states.set(f.id, st);
      }

      const s = this.states.get(f.id);
      s.entry.mtimeMs = f.mtimeMs;   // 纯目录项属性，不读文件内容
      result.push(decorate(s.entry, now));
    }

    // 回收：不再候选的会话连同游标一起丢掉，内存不随历史会话增长
    if (this.states.size > alive.size) {
      for (const k of Array.from(this.states.keys())) {
        if (!alive.has(k)) this.states.delete(k);
      }
    }

    const ordered = SessionMonitor.order(result);
    this.primaryId = ordered.length ? ordered[0].id : null;

    if (this.verbose && tickIndex % SECONDARY_REFRESH_EVERY === 0) {
      const brief = ordered
        .map((e) => e.label.slice(0, 12) + '(' + e.activity.status + ',' + e.tag + ')')
        .join(' | ');
      console.log('[dsh-notch] 会话 ' + ordered.length + ' 个: ' + brief);
    }
    return ordered;
  }

  /** 排序：状态优先级 → mtime 新在前。**第 0 个即主会话**。 */
  static order(entries) {
    return entries.slice().sort((a, b) => {
      const pa = priorityOf(a);
      const pb = priorityOf(b);
      if (pa !== pb) return pa - pb;
      return b.mtimeMs - a.mtimeMs;
    });
  }

  /** 重置所有游标（下次 poll 全量重放）。 */
  reset() {
    this.states.clear();
    this.primaryId = null;
  }
}

/** 排序权重：越小越该被关注。「等人工确认」排最前。 */
function priorityOf(entry) {
  const s = entry && entry.activity ? entry.activity.status : STATUS.IDLE;
  return (STATUS_META[s] || STATUS_META.idle).priority;
}

/** 给渲染层补上可直接显示的字符串，让渲染进程不必再算一遍。 */
function decorate(entry, now) {
  const a = entry.activity;
  const p = a.proj;
  const e = { ...entry };
  e.tag = (a.currentTool && String(a.currentTool).trim())
    || (STATUS_META[a.status] || STATUS_META.idle).badge;
  e.status = a.status;
  e.glow = (STATUS_META[a.status] || STATUS_META.idle).glow;
  e.badge = (STATUS_META[a.status] || STATUS_META.idle).badge;
  e.elapsedText = a.turnStartTime ? act.formatDuration(now - a.turnStartTime) : null;
  e.toolCountText = a.toolCount + ' 次';
  e.contextText = p ? formatPercent(projections.contextFraction(p)) : null;
  e.contextLevel = p ? contextLevel(p) : 0;
  e.todoText = (p && p.todoTotal > 0) ? (p.todoDone + '/' + p.todoTotal) : null;
  e.turnStepText = turnStepText(a);
  e.outputText = (p && typeof p.outputTokens === 'number')
    ? projections.shortTokens(p.outputTokens) + ' tok' : null;
  e.subagentText = a.pendingAgents > 0 ? String(a.pendingAgents) : null;
  e.label = entry.label;
  e.shortId = shortId(entry.id);
  return e;
}

function formatPercent(f) {
  if (typeof f !== 'number' || !Number.isFinite(f)) return null;
  return Math.round(f * 100) + '%';
}

function contextLevel(p) {
  const f = projections.contextFraction(p);
  if (typeof f !== 'number') return 0;
  if (f > 0.8) return 2;
  if (f > 0.5) return 1;
  return 0;
}

function turnStepText(a) {
  if (a.turn === null || a.turn === undefined) return null;
  if (a.step !== null && a.step !== undefined) return 'T' + a.turn + '·S' + a.step;
  return 'T' + a.turn;
}

module.exports = {
  SessionMonitor,
  SECONDARY_REFRESH_EVERY,
  SEQ_STALE_MS,
  LIVE_WRITE_MS,
  inferFromProjection,
  shortId,
  priorityOf,
};
