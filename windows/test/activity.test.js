// Windows 版活动状态机（ActivityCursor）的自检。
//
// 这些事件类型在**真实会话文件里读不到**（实测 `type` 只有 `session` 一种，
// 见 windows/README.md）。所以这一套是用构造事件跑的 —— 它的价值是：
// DSH 哪天把 `tool/*` 事件写进会话文件，这里不用改一行就能重新生效；
// 而如果它坏了，我们会在这里先发现，而不是等到岛上永远显示「待命」。
//
// 用法: node windows/test/activity.test.js
const path = require('node:path');

const A = require(path.join(__dirname, '..', 'src', 'activity.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const ev = (seq, type, data, time) => ({ seq, type, time: time || 1000, data: data || {} });

console.log('=== W1: 常量与默认值 ===');
check('五个状态齐全', ['idle', 'thinking', 'tool', 'waiting', 'done']
  .every((k) => A.STATUS_META[k] && A.STATUS_META[k].title), Object.keys(A.STATUS_META).join(','));
check('优先级 waiting(0) < tool(1) < thinking(2) < done(3) < idle(4)',
  A.STATUS_META.waiting.priority === 0 && A.STATUS_META.tool.priority === 1
  && A.STATUS_META.thinking.priority === 2 && A.STATUS_META.done.priority === 3
  && A.STATUS_META.idle.priority === 4);
check('状态色与插件 CSS 一致',
  A.STATUS_META.thinking.glow === '#4E7CFF' && A.STATUS_META.tool.glow === '#00D2AA'
  && A.STATUS_META.waiting.glow === '#FFAA00' && A.STATUS_META.done.glow === '#4ADE80');
check('STALE_MS = 90s（与 Swift 版一致）', A.STALE_MS === 90000);
check('DONE_HOLD_MS = 5s（与 Swift 版一致）', A.DONE_HOLD_MS === 5000);

const fresh = A.newActivity();
check('默认 idle', fresh.status === 'idle');
check('默认标题「DeepSeek 待命」', fresh.title === 'DeepSeek 待命');
check('isActive(idle) 为 false', A.isActive(fresh) === false);
check('isActive(thinking) 为 true', A.isActive({ status: 'thinking' }) === true);

console.log('\n=== W2: formatDuration ===');
check('0 → 00:00', A.formatDuration(0) === '00:00', A.formatDuration(0));
check('65s → 01:05', A.formatDuration(65000) === '01:05', A.formatDuration(65000));
check('3661s → 1:01:01', A.formatDuration(3661000) === '1:01:01', A.formatDuration(3661000));
check('负数 → 00:00', A.formatDuration(-5) === '00:00');

console.log('\n=== W3: displayText（arguments 的三种形态）===');
check('内嵌 JSON 字符串 → 取 command',
  A.displayText('{"command":"ls -la"}') === 'ls -la', String(A.displayText('{"command":"ls -la"}')));
check('对象 → 取 command', A.displayText({ command: 'git status' }) === 'git status');
check('file_path 次之', A.displayText({ file_path: 'a.ts' }) === 'a.ts');
check('pattern → 搜索 "x"', A.displayText({ pattern: 'x' }) === '搜索 "x"', String(A.displayText({ pattern: 'x' })));
check('question → 提问: x', A.displayText({ question: '要不要继续' }) === '提问: 要不要继续');
check('纯字符串原样返回', A.displayText('plain') === 'plain');
check('null → null', A.displayText(null) === null);
check('空对象 → null', A.displayText({}) === null);

console.log('\n=== W4: 游标 —— 回合开始 ===');
let cur = new A.ActivityCursor();
let a = cur.apply([ev(1, 'turn/start', { turn: 3 }, 1000)], 1000);
check('turn/start → thinking', a.status === 'thinking', a.status);
check('标题「正在分析与规划...」', a.title === '正在分析与规划...', a.title);
check('turn 同步为 3', a.turn === 3, String(a.turn));
check('turnStartTime 取事件自己的时间', a.turnStartTime === 1000, String(a.turnStartTime));

console.log('\n=== W5: 游标 —— 工具调用 ===');
a = cur.apply([ev(2, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' })], 1100);
check('tool/call → tool', a.status === 'tool', a.status);
check('currentTool = bash', a.currentTool === 'bash');
check('标题「执行 bash」', a.title === '执行 bash', a.title);
check('detail = 命令原文', a.detail === 'ls', a.detail);
check('toolCount = 1', a.toolCount === 1, String(a.toolCount));

console.log('\n=== W6: 游标 —— 等人工确认 ===');
cur = new A.ActivityCursor();
cur.apply([ev(1, 'turn/start', {}, 1000)], 1000);
a = cur.apply([ev(2, 'tool/call', { callId: 'c9', name: 'ask', arguments: '{"question":"要删吗"}' })], 1100);
check('带 question → waiting', a.status === 'waiting', a.status);
check('isWaitingApproval = true', a.isWaitingApproval === true);

console.log('\n=== W7: 游标 —— 工具结束与回合结束 ===');
a = cur.apply([ev(3, 'tool/result', {})], 1200);
check('tool/result → thinking', a.status === 'thinking', a.status);
check('isWaitingApproval 复位', a.isWaitingApproval === false);
a = cur.apply([ev(4, 'turn/end', {})], 1300);
check('turn/end → done', a.status === 'done', a.status);
check('done 的 detail 带工具次数', /1 次工具/.test(a.detail), a.detail);

console.log('\n=== W8: done 的 5 秒回执期 ===');
cur = new A.ActivityCursor();
cur.apply([ev(1, 'turn/start', {}, 0)], 0);
cur.apply([ev(2, 'turn/end', {}, 1000)], 1000);
a = cur.apply([], 3000);
check('2 秒内仍是 done', a.status === 'done', a.status);
a = cur.apply([], 7000);
check('超过 5 秒转回 idle', a.status === 'idle', a.status);
check('转回后标题复位', a.title === 'DeepSeek 待命', a.title);

console.log('\n=== W9: seq 去重（重复喂同一批事件不该重复计数）===');
cur = new A.ActivityCursor();
const batch = [ev(1, 'turn/start', {}, 0), ev(2, 'tool/call', { callId: 'c1', name: 'bash' })];
cur.apply(batch, 10);
cur.apply(batch, 20);
cur.apply(batch, 30);
check('重复喂 3 次，toolCount 仍是 1', cur.apply([], 40).toolCount === 1, String(cur.apply([], 40).toolCount));

console.log('\n=== W10: 文件被截断 → 游标重置 ===');
cur = new A.ActivityCursor();
cur.apply([ev(50, 'tool/call', { callId: 'c1', name: 'bash' })], 10);
check('先推进到 seq=50', cur.lastSeq === 50, String(cur.lastSeq));
const after = cur.apply([ev(10, 'turn/start', {}, 11)], 11);
check('maxSeq 变小 → 重置后重新处理', cur.lastSeq === 10 && after.status === 'thinking',
  cur.lastSeq + '/' + after.status);

console.log('\n=== W11: 一个事件都没有 → idle ===');
check('空事件流返回 idle', new A.ActivityCursor().apply([], 1000).status === 'idle');
check('只有 type=session 的事件也返回 idle（真实数据现状）',
  new A.ActivityCursor().apply([ev(1, 'session', {})], 1000).status === 'idle');

console.log('\n=== W12: 投影合并（在飞调用 / 子代理）===');
cur = new A.ActivityCursor();
const proj = {
  seq: 9, pendingCallIds: ['c1', 'c2'], turns: 4, steps: 12,
  todoTotal: 0, todoDone: 0, title: null,
};
cur.apply([ev(1, 'tool/call', { callId: 'c1', name: 'subagent' }),
  ev(2, 'tool/call', { callId: 'c2', name: 'bash' })], 1000);
a = cur.apply([], 1100, proj);
check('pendingTools = 2', a.pendingTools === 2, String(a.pendingTools));
check('pendingAgents = 1（只有 subagent 计入）', a.pendingAgents === 1, String(a.pendingAgents));
check('turn 用投影兜底', a.turn === 4, String(a.turn));
check('step 用投影兜底', a.step === 12, String(a.step));

console.log('\n=== W13: 报错事件 ===');
cur = new A.ActivityCursor();
a = cur.apply([ev(1, 'tool/error', { isError: true })], 1000);
check('error → done', a.status === 'done', a.status);
check('标题「执行遇到注意项」', a.title === '执行遇到注意项', a.title);

console.log('\n=== W14: 停摆降级 demoteIfStale ===');
const busy = { ...A.newActivity(), status: 'tool', title: '执行 bash', currentTool: 'bash' };
check('未超时不动', A.demoteIfStale(busy, 1000, 1000 + A.STALE_MS - 1).status === 'tool');
const demoted = A.demoteIfStale(busy, 1000, 1000 + A.STALE_MS + 1);
check('超时 → idle', demoted.status === 'idle', demoted.status);
check('降级后标题复位', demoted.title === 'DeepSeek 待命', demoted.title);
check('降级后清掉 currentTool', demoted.currentTool === null);
check('done 不参与停摆降级（回执期由 doneAt 管）',
  A.demoteIfStale({ ...busy, status: 'done' }, 0, 1e12).status === 'done');
check('不知道最后事件时间时不降级（宁可不动也不误杀）',
  A.demoteIfStale(busy, null, 1e12).status === 'tool');

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
