// Windows 版多会话监控器的自检。
//
// 用**沙箱 DSH_ROOT** 造会话（DSH_ROOT 环境变量切根），不碰真实 ~/.dsh。
// 会话文件写得很小（<32 字节）→ `decompress()` 直接返回空串，
// 于是事件流为空 —— 正好复现「真实数据里读不到 tool/* 事件」的现状，
// 状态全部由投影推。我们要验的就是这条路径。
//
// 用法: node windows/test/monitor.test.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-root-'));
process.env.DSH_ROOT = ROOT;   // session-source / projections 都读它

const SRC = path.join(__dirname, '..', 'src');
const source = require(path.join(SRC, 'session-source.js'));
const projections = require(path.join(SRC, 'projections.js'));
const { SessionMonitor } = require(path.join(SRC, 'monitor.js'));
const A = require(path.join(SRC, 'activity.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/** 造一个会话：目录 + 极小的 .zstd + 投影文件。 */
function makeSession(id, proj, opts = {}) {
  const dir = path.join(ROOT, 'sessions', '--tmp-project--', id);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, 'x'.repeat(10));       // <32 字节 → 解压得到空串
  if (proj) {
    const pdir = path.join(ROOT, 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'session-' + id + '.json'), JSON.stringify(proj));
  }
  const mtime = opts.mtimeMs === undefined ? Date.now() : opts.mtimeMs;
  // ⚠️ 注意是 new Date(mtimeMs) 而不是 mtimeMs/1000 —— 后者会把 mtime
  // 写成 1970 年，于是所有会话都掉出活跃窗口，只剩「最新 1 个」的兜底。
  fs.utimesSync(f, new Date(mtime), new Date(mtime));
  return f;
}

/** 造一份投影（record.rows 形态，字段与真实文件一致）。 */
function proj(rows) {
  return { record: { rows } };
}
const titleRow = (t) => ({ title: { seq: 3, val: t } });
const statsRow = (openStep, pendingCalls) => ({
  sessionStats: { seq: 5, val: { openStep: openStep === undefined ? null : openStep, pendingCalls: pendingCalls || {} } },
});

const NOW = Date.now();

console.log('=== W1: 沙箱里能发现会话 ===');
makeSession('session-aaaa', proj({ ...titleRow('会话甲'), ...statsRow(null, {}) }), { mtimeMs: NOW });
source.invalidate(); projections.invalidate();
let files = source.sessionFiles({ activeWithin: 600000 });
check('发现 1 个会话', files.length === 1, String(files.length));
check('id 正确', files[0] && files[0].id === 'session-aaaa', files[0] && files[0].id);

console.log('\n=== W2: 无投影 → idle ===');
makeSession('session-noproj', null, { mtimeMs: NOW });
source.invalidate(); projections.invalidate();
let m = new SessionMonitor({ activeWindow: 600000 });
let entries = m.poll(NOW, 1);
const noProj = entries.find((e) => e.id === 'session-noproj');
check('拿不到投影的会话是 idle', noProj && noProj.status === 'idle', noProj && noProj.status);
check('label 退回项目名/短码', noProj && typeof noProj.label === 'string' && noProj.label.length > 0, noProj && noProj.label);

console.log('\n=== W3: 由投影推状态 —— 在跑 vs 不在跑 ===');
// 开一个步骤但没有在飞调用 → 思考
makeSession('session-think', proj({ ...titleRow('在思考的会话'), ...statsRow({ id: 's1' }, {}) }), { mtimeMs: NOW });
// 有在飞调用 → 执行
makeSession('session-tool', proj({
  ...titleRow('在执行的会话'), ...statsRow({ id: 's2' }, { callA: {}, callB: {} }),
}), { mtimeMs: NOW });
// 什么都没有 → 待命（mtime 故意取 30 秒前：落在「不算刚写过」的区间里，
// 否则会命中 LIVE_WRITE_MS 的兜底，测不到投影字段本身的作用）
makeSession('session-idle', proj({ ...titleRow('空闲会话'), ...statsRow(null, {}) }),
  { mtimeMs: NOW - 30000 });
// 文件很久没写 → 停摆，算待命
makeSession('session-stale', proj({ ...titleRow('停摆会话'), ...statsRow({ id: 's3' }, {}) }),
  { mtimeMs: NOW - 200000 });

source.invalidate(); projections.invalidate();
m = new SessionMonitor({ activeWindow: 600000 });
// 把停摆会话也拉进候选：调大活跃窗口
m = new SessionMonitor({ activeWindow: 600000 });
entries = m.poll(NOW, 1);
const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

check('openStep 开着 → thinking', byId['session-think'] && byId['session-think'].status === 'thinking',
  byId['session-think'] && byId['session-think'].status);
check('有在飞调用 → tool', byId['session-tool'] && byId['session-tool'].status === 'tool',
  byId['session-tool'] && byId['session-tool'].status);
check('tool 的 pendingTools = 2', byId['session-tool'] && byId['session-tool'].activity.pendingTools === 2,
  byId['session-tool'] && String(byId['session-tool'].activity.pendingTools));
check('detail 写出「2 个调用在飞」', byId['session-tool'] && /2 个调用在飞/.test(byId['session-tool'].activity.detail),
  byId['session-tool'] && byId['session-tool'].activity.detail);
check('什么都没有 → idle', byId['session-idle'] && byId['session-idle'].status === 'idle',
  byId['session-idle'] && byId['session-idle'].status);
check('文件 200 秒没写 → 停摆降级为 idle', byId['session-stale'] && byId['session-stale'].status === 'idle',
  byId['session-stale'] && byId['session-stale'].status);

console.log('\n=== W4: label 取投影标题 ===');
check('label = 投影 title', byId['session-think'] && byId['session-think'].label === '在思考的会话',
  byId['session-think'] && byId['session-think'].label);

console.log('\n=== W5: 排序 —— 需要关注的排最前 ===');
const ordered = SessionMonitor.order([
  { id: 'a', mtimeMs: NOW, activity: { status: 'idle' } },
  { id: 'b', mtimeMs: NOW - 5000, activity: { status: 'tool' } },
  { id: 'c', mtimeMs: NOW - 9000, activity: { status: 'thinking' } },
  { id: 'd', mtimeMs: NOW - 99000, activity: { status: 'waiting' } },
  { id: 'e', mtimeMs: NOW - 1000, activity: { status: 'done' } },
]);
check('第一个是 waiting（唯一需要人动手的）', ordered[0].id === 'd', ordered.map((x) => x.id).join('>'));
check('其后是 tool', ordered[1].id === 'b', ordered.map((x) => x.id).join('>'));
check('再后是 thinking', ordered[2].id === 'c', ordered.map((x) => x.id).join('>'));
check('同优先级按 mtime 新在前', (() => {
  const two = SessionMonitor.order([
    { id: 'old', mtimeMs: 100, activity: { status: 'idle' } },
    { id: 'new', mtimeMs: 200, activity: { status: 'idle' } },
  ]);
  return two[0].id === 'new';
})());

console.log('\n=== W6: 主会话每拍刷新 / 非主会话降频 ===');
m = new SessionMonitor({ activeWindow: 600000 });
m.poll(NOW, 1);
check('primaryId 已定下', typeof m.primaryId === 'string' && m.primaryId.length > 0, String(m.primaryId));
const primaryBefore = m.primaryId;
m.poll(NOW + 250, 2);
check('主会话稳定（不抖动）', m.primaryId === primaryBefore, primaryBefore + ' → ' + m.primaryId);

console.log('\n=== W7: 掉出候选的会话被回收 ===');
m = new SessionMonitor({ activeWindow: 600000 });
m.poll(NOW, 1);
const before = m.states.size;
m = new SessionMonitor({ activeWindow: 1 });   // 窗口收到极小 → 只留最新 1 个
m.poll(NOW, 1);
check('缩小窗口后只剩 1 个状态', m.states.size === 1, before + ' → ' + m.states.size);

console.log('\n=== W8: 回合结束的 5 秒回执（反推 done）===');
const p = { wasActive: false, doneUntil: 0, seq: -1, seqAt: 0 };
const busyProj = { seq: 9, hasOpenStep: true, pendingCallIds: [], planActive: false };
const restProj = { seq: 10, hasOpenStep: false, pendingCallIds: [], planActive: false };
// 注意 activityMs：在跑时是「刚写过」，停下来时是「30 秒前写过」——
// 否则会命中 LIVE_WRITE_MS 的兜底，永远退出不了活跃态。
let act1 = monitor_infer(p, busyProj, NOW, NOW);
check('在跑 → 非 idle', act1.status !== 'idle', act1.status);
let act2 = monitor_infer(p, restProj, NOW, NOW - 30000);
check('刚停下来 → done（让用户看见结果）', act2.status === 'done', act2.status);
let act3 = monitor_infer(p, restProj, NOW + 6000, NOW - 30000);
check('5 秒后 → idle', act3.status === 'idle', act3.status);

function monitor_infer(prev, projection, now, activityMs) {
  return require(path.join(SRC, 'monitor.js')).inferFromProjection(prev, projection, now, activityMs);
}

console.log('\n=== W9: seq 停摆不再当「在跑」 ===');
const p2 = { wasActive: false, doneUntil: 0, seq: 42, seqAt: NOW - 30000 };
const stalled = monitor_infer(p2, { seq: 42, hasOpenStep: true, pendingCallIds: [] }, NOW, NOW);
check('seq 30 秒没动且无在飞调用 → 不再算在跑', stalled.status === 'idle', stalled.status);

console.log('\n=== W9b: 「刚被写过」兜底信号 ===');
const idleProj = { seq: 5, hasOpenStep: false, pendingCallIds: [], planActive: false };
const freshPrev = { wasActive: false, doneUntil: 0, seq: -1, seqAt: 0 };
check('30 秒前写过 + 无 openStep → idle',
  monitor_infer({ ...freshPrev }, idleProj, NOW, NOW - 30000).status === 'idle',
  monitor_infer({ ...freshPrev }, idleProj, NOW, NOW - 30000).status);
check('刚刚写过（< LIVE_WRITE_MS）→ thinking（文件在动就是在跑）',
  monitor_infer({ ...freshPrev }, idleProj, NOW, NOW - 1000).status === 'thinking',
  monitor_infer({ ...freshPrev }, idleProj, NOW, NOW - 1000).status);
check('LIVE_WRITE_MS 是 8 秒（可调旋钮，注释里写清了为什么）',
  require(path.join(SRC, 'monitor.js')).LIVE_WRITE_MS === 8000);

console.log('\n=== W10: 派生显示量 ===');
makeSession('session-rich', proj({
  ...titleRow('富信息会话'),
  ...statsRow({ id: 's' }, { c1: {} }),
  tokenUsage: { seq: 5, val: { totals: { outputTokens: 1234 } } },
  contextPressure: { seq: 5, val: { surfaceTokens: 30000, contextWindow: 100000 } },
  todos: { seq: 5, val: { list: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b' }] } },
}), { mtimeMs: NOW });
source.invalidate(); projections.invalidate();
m = new SessionMonitor({ activeWindow: 600000 });
entries = m.poll(NOW, 1);
const rich = entries.find((e) => e.id === 'session-rich');
check('contextText = 30%', rich && rich.contextText === '30%', rich && rich.contextText);
check('contextLevel = 0（<50%）', rich && rich.contextLevel === 0, rich && String(rich.contextLevel));
check('todoText = 1/2', rich && rich.todoText === '1/2', rich && rich.todoText);
check('outputText = 1.2k tok', rich && rich.outputText === '1.2k tok', rich && rich.outputText);
check('shortId 去掉 session- 前缀', !!rich && rich.shortId === 'rich', rich && rich.shortId);

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 无所谓 */ }

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
