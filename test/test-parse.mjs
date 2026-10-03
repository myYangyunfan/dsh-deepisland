const m = globalThis.__mod;
const parse = m.parseActivityFromEvents;
const fmt = m.formatDuration;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + extra); }
};

console.log('\n=== T1: 空事件 → idle ===');
let a = parse([]);
check('status=idle', a.status === 'idle', JSON.stringify(a));
check('显示待命', a.title.includes('待命'), a.title);

console.log('\n=== T2: 完整回合时序 ===');
let ev = [];
const push = (e) => { ev.push(e); return parse(ev); };

a = push({ type: 'turn-start' });
check('turn-start → thinking', a.status === 'thinking', a.status);
check('记录回合起点 turnStartTime', a.turnStartTime > 0, String(a.turnStartTime));

a = push({ type: 'thinking', data: { text: '正在分析用户需求' } });
check('thinking 保持 thinking', a.status === 'thinking', a.status);
check('detail 取文本尾部', a.detail.includes('分析用户需求'), a.detail);

a = push({ type: 'tool/call', data: { name: 'bash', args: { command: 'ls -la /tmp' } } });
check('tool/call → tool', a.status === 'tool', a.status);
check('捕获工具名 bash', a.currentTool === 'bash', a.currentTool);
check('提取命令文本', a.toolCommand === 'ls -la /tmp', a.toolCommand);
check('toolCount=1', a.toolCount === 1, String(a.toolCount));

a = push({ type: 'tool/result', data: { ok: true } });
check('tool/result → 回到 thinking', a.status === 'thinking', a.status);
check('pendingToolId 清空', a.pendingToolId === null, String(a.pendingToolId));

a = push({ type: 'tool/call', data: { name: 'read', args: { file_path: '/a/b.ts' } } });
check('read 提取 file_path', a.toolCommand === '/a/b.ts', a.toolCommand);

a = push({ type: 'tool/call', data: { name: 'grep', args: { pattern: 'TODO' } } });
check('grep 提取 pattern', a.toolCommand.includes('TODO'), a.toolCommand);

a = push({ type: 'tool/call', data: { name: 'ask', args: { question: '是否继续?' } } });
check('提问 → waiting', a.status === 'waiting', a.status);
check('标记待审批', a.isWaitingApproval === true, String(a.isWaitingApproval));

a = push({ type: 'turn-end' });
check('turn-end → idle', a.status === 'idle', a.status);
check('累计工具次数=4', a.toolCount === 4, String(a.toolCount));

console.log('\n=== T3: WeakMap 增量游标（性能核心）===');
const big = [];
for (let i = 0; i < 5000; i++) big.push({ type: 'thinking', data: { text: 'x' + i } });
const t0 = performance.now();
const r1 = parse(big);
const t1 = performance.now();
const r2 = parse(big);
const t2 = performance.now();
console.log('  首次全量扫描 5000 事件: ' + (t1 - t0).toFixed(2) + 'ms');
console.log('  二次增量扫描(缓存命中): ' + (t2 - t1).toFixed(3) + 'ms');
check('二次扫描结果一致', r2.title === r1.title && r2.status === r1.status, r2.status + '/' + r2.title);
check('二次扫描显著更快(走增量)', (t2 - t1) < (t1 - t0) / 5, (t2 - t1).toFixed(3) + 'ms vs ' + (t1 - t0).toFixed(2) + 'ms');

console.log('\n=== T4: 边界与容错 ===');
check('null 安全', parse(null).status === 'idle');
check('非数组安全', parse({}).status === 'idle');
check('空/脏事件对象不崩', parse([null, undefined, {}]).status === 'idle');
check('无 type 字段不崩', parse([{ foo: 1 }]).status === 'idle');

console.log('\n=== T5: event/payload 兼容字段 ===');
const e2 = [{ event: 'tool/call', payload: { name: 'edit', arguments: { path: '/x/y.md' } } }];
const a2 = parse(e2);
check('event 字段被识别', a2.status === 'tool', a2.status);
check('payload.arguments 提取 path', a2.toolCommand === '/x/y.md', a2.toolCommand);

console.log('\n=== T6: 跨回合 toolCount 重置 ===');
const e3 = [
  { type: 'turn-start' },
  { type: 'tool/call', data: { name: 'bash', args: { command: 'a' } } },
  { type: 'turn-end' },
  { type: 'turn-start' },
];
const a3 = parse(e3);
console.log('  新回合 toolCount = ' + a3.toolCount + ' | title = ' + a3.title);
check('新回合 toolCount 已重置为 0', a3.toolCount === 0, 'got ' + a3.toolCount);

console.log('\n=== T6b: 会话游标隔离（不同 sessionKey 独立累计）===');
const s1 = [{ type: 'turn-start' }, { type: 'tool/call', data: { name: 'bash', args: { command: 'a' } } }];
const s2 = [{ type: 'turn-start' }, { type: 'tool/call', data: { name: 'read', args: { file_path: '/x' } } }];
const c1 = parse(s1, 'session-A');
const c2 = parse(s2, 'session-B');
check('会话 A 计数独立', c1.toolCount === 1, String(c1.toolCount));
check('会话 B 计数独立', c2.toolCount === 1, String(c2.toolCount));
check('两会话互不污染', c1.currentTool === 'bash' && c2.currentTool === 'read', c1.currentTool + '/' + c2.currentTool);

console.log('\n=== T6c: 数组副本 + sessionKey → 增量命中 ===');
const base = [{ type: 'turn-start' }];
for (let i = 0; i < 5000; i++) base.push({ type: 'thinking', data: { text: 'x' + i } });
const k = 'perf-session';
const tA = performance.now();
parse([...base], k);            // 首次全量
const tB = performance.now();
parse([...base], k);            // 副本但同 key → 应命中增量
const tC = performance.now();
console.log('  首次: ' + (tB - tA).toFixed(3) + 'ms | 二次(副本+同key): ' + (tC - tB).toFixed(4) + 'ms');
check('同 sessionKey 下副本传递仍走增量', (tC - tB) < 0.05, (tC - tB).toFixed(4) + 'ms');

console.log('\n=== T6d: 数组缩短 → 游标重置 ===');
const shrinkKey = 'shrink-session';
const longArr = [{ type: 'turn-start' }, { type: 'tool/call', data: { name: 'bash', args: { command: 'a' } } }];
parse(longArr, shrinkKey);
const shortArr = [{ type: 'turn-start' }];
const shr = parse(shortArr, shrinkKey);
check('数组缩短时游标重置(不残留旧状态)', shr.toolCount === 0 && shr.currentTool === null, JSON.stringify({ t: shr.toolCount, c: shr.currentTool }));

console.log('\n=== T7: error 事件 ===');
const e4 = [{ type: 'tool/call', data: { name: 'bash', args: { command: 'x' } } }, { type: 'error', data: { error: 'boom' } }];
const a4 = parse(e4);
check('error → idle', a4.status === 'idle', a4.status);
check('error 信息透传', a4.detail.includes('boom'), a4.detail);

console.log('\n=== T8: formatDuration ===');
check('0 → 00:00', fmt(0) === '00:00', fmt(0));
check('负数 → 00:00', fmt(-5) === '00:00', fmt(-5));
check('65 → 01:05', fmt(65) === '01:05', fmt(65));
check('605 → 10:05', fmt(605) === '10:05', fmt(605));
check('3600 → 60:00', fmt(3600) === '60:00', fmt(3600));

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
// 不调用 process.exit —— 交由 run.mjs 统一退出，以便继续跑后续套件
globalThis.__results = globalThis.__results || {};
globalThis.__results.parse = { pass, fail };
