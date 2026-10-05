// Windows 版投影读取的自检（用真实 projections.json）。
//
// 用法: node windows/test/projections.test.js
const path = require('node:path');
const fs = require('node:fs');

const SRC = path.join(__dirname, '..', 'src', 'projections.js');
const SS = require(path.join(__dirname, '..', 'src', 'session-source.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

console.log('=== P1: 模块加载与派生量（不依赖真实文件）===');
const P = require(SRC);
check('导出齐全', ['projectionURL', 'load', 'parse', 'shortTokens', 'contextFraction']
  .every((k) => typeof P[k] === 'function'), Object.keys(P).join(','));

console.log('\n=== P2: shortTokens（逐档与 Swift 版一致）===');
// ⚠️ 期望值按 Swift 版 `String(format:)` 的四舍五入规则算，别想当然。
// 999499/1000 = 999.499 → k < 100 为假 → 走 "%.0fk" → 四舍五入 = 999（不是 999.5k）。
// 我第一版把这条写成 999.5k，测试红了 —— 查下来是**测试期望错、代码对**。
const cases = [
  [0, '0'], [999, '999'], [1000, '1.0k'], [1234, '1.2k'],
  [39369, '39.4k'],
  [99900, '99.9k'],        // k=99.9 < 100 → 一位小数
  [999499, '999k'],        // k=999.499 → %.0fk → 四舍五入 999
  [999500, '1.0M'],        // 跨档
  [2106768, '2.1M'],
  [99999999, '100.0M'],
];
for (const [n, want] of cases) {
  check(`shortTokens(${n}) = ${want}`, P.shortTokens(n) === want, P.shortTokens(n));
}
check('shortTokens(null) 不崩', P.shortTokens(null) === '-', P.shortTokens(null));
check('shortTokens(NaN) 不崩', P.shortTokens(NaN) === '-');

console.log('\n=== P3: 宽松解析（自造边界输入）===');
{
  const p = P.parse(JSON.stringify({
    record: {
      rows: {
        tokenUsage: { seq: 5, val: { totals: { outputTokens: 1234, uncachedInputTokens: 500, cacheReadTokens: 234 } } },
        contextPressure: { seq: 6, val: { surfaceTokens: 8000, contextWindow: 32000 } },
        sessionStats: { seq: 7, val: { turns: 3, steps: 12, llmMs: 1234.5, toolMs: 88, openStep: true, pendingCalls: ['c1', { callId: 'c2' }] } },
        todos: { seq: 8, val: { list: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b' }, { status: 'pending', content: 'c' }] } },
        title: { seq: 9, val: '标题在这里' },
        permissions: { seq: 10, val: { preset: 'workspace-write' } },
      },
    },
  }));
  check('seq 取所有 row 的最大值', p && p.seq === 10, p && String(p.seq));
  check('token 三个字段', p.outputTokens === 1234 && p.uncachedInputTokens === 500 && p.cacheReadTokens === 234);
  check('token 数字被 JSON.parse 成字符串也能取', (() => {
    const q = P.parse(JSON.stringify({ record: { rows: { tokenUsage: { seq: 1, val: { totals: { outputTokens: '999' } } } } } }));
    return q.outputTokens === 999;
  })(), '字符串数字取不到');
  check('上下文占用', p.contextUsed === 8000 && p.contextWindow === 32000);
  check('contextFraction = 0.25', Math.abs(P.contextFraction(p) - 0.25) < 1e-9, String(P.contextFraction(p)));
  check('totalInputTokens = 500+234', P.totalInputTokens(p) === 734, String(P.totalInputTokens(p)));
  check('turns/steps/耗时', p.turns === 3 && p.steps === 12 && p.llmMs === 1234.5 && p.toolMs === 88);
  check('hasOpenStep', p.hasOpenStep === true);
  check('pendingCallIds 同时吃字符串与对象形态',
    p.pendingCallIds.length === 2 && p.pendingCallIds[0] === 'c1' && p.pendingCallIds[1] === 'c2',
    JSON.stringify(p.pendingCallIds));
  check('待办 3 项 / 完成 1 / 当前是 b', p.todoTotal === 3 && p.todoDone === 1 && p.todoCurrent === 'b',
    p.todoTotal + '/' + p.todoDone + '/' + p.todoCurrent);

  // 🔴 真实文件里 title.val 是**裸字符串**，不是对象。
  // 第一版 row() 只在 val 是对象时返回 → 标题整个丢掉（真实文件上 title=null）。
  // 这条断言就是防那个 bug 回流。
  {
    const q = P.parse(JSON.stringify({ record: { rows: { title: { seq: 3, val: '裸字符串标题' } } } }));
    check('title.val 是裸字符串时也能取到（真实数据就是这样）',
      q && q.title === '裸字符串标题', q && JSON.stringify(q.title));
  }
  {
    const q = P.parse(JSON.stringify({
      record: { rows: { title: { seq: 3, val: null }, titleInput: { seq: 4, val: { first: { seq: 1, text: '用户第一句话' }, count: 3, lastSeq: 9 } } } },
    }));
    check('title 缺失时退回 titleInput.first.text',
      q && q.title === '用户第一句话', q && JSON.stringify(q.title));
  }
  {
    const q = P.parse(JSON.stringify({ record: { rows: { todos: { seq: 1, val: null } } } }));
    check('todos.val 为 null 时不崩且 todoTotal=0',
      q && q.todoTotal === 0 && q.todoCurrent === null, q && String(q.todoTotal));
  }

  // 🔴 pendingCalls 真实形态是**对象** {callId: {…}}，不是数组。
  // 第一版照抄成 `Array.isArray()` → 真实文件上永远 0 条，
  // 状态判定不出「正在执行工具」。Swift 版读的是 `pending.keys.sorted()`。
  {
    const q = P.parse(JSON.stringify({ record: { rows: { sessionStats: {
      seq: 9, val: { turns: 1, openStep: null, pendingCalls: {} } } } } }));
    check('pendingCalls 是空对象时长度为 0（不是崩）',
      q && Array.isArray(q.pendingCallIds) && q.pendingCallIds.length === 0, JSON.stringify(q && q.pendingCallIds));
    check('openStep 为 null → hasOpenStep=false', q && q.hasOpenStep === false);
  }
  {
    const q = P.parse(JSON.stringify({ record: { rows: { sessionStats: {
      seq: 9, val: { turns: 2, openStep: { step: 3 }, pendingCalls: { call_b: {}, call_a: { name: 'bash' } } } } } } }));
    check('pendingCalls 是对象时取它的键（排序后）',
      q && q.pendingCallIds.length === 2 && q.pendingCallIds[0] === 'call_a' && q.pendingCallIds[1] === 'call_b',
      JSON.stringify(q && q.pendingCallIds));
    check('openStep 非 null → hasOpenStep=true', q && q.hasOpenStep === true);
    check('有在飞调用时状态判定得出「正在执行」',
      q && (q.hasOpenStep || q.pendingCallIds.length > 0), JSON.stringify(q && { o: q.hasOpenStep, p: q.pendingCallIds.length }));
  }
  {
    // 兜住另一种可能形态：数组
    const q = P.parse(JSON.stringify({ record: { rows: { sessionStats: {
      seq: 9, val: { pendingCalls: ['c1', { callId: 'c2' }] } } } } }));
    check('pendingCalls 若是数组也能吃（兜底）',
      q && q.pendingCallIds.length === 2, JSON.stringify(q && q.pendingCallIds));
  }

  check('缺 record 返回 null', P.parse('{"version":1}') === null);
  check('缺 rows 返回 null', P.parse('{"record":{}}') === null);
  check('坏 JSON 返回 null（不抛错）', P.parse('{not json') === null);
  check('空对象不崩', (() => { try { return P.parse('{}') === null; } catch { return false; } })());
  check('全空投影 isEmpty', (() => {
    const e = P.parse(JSON.stringify({ record: { rows: {} } }));
    return e && P.isEmpty(e);
  })());
  check('contextFraction 对 window=0 返回 null（不能除零）', (() => {
    const q = P.parse(JSON.stringify({ record: { rows: { contextPressure: { seq: 1, val: { surfaceTokens: 5, contextWindow: 0 } } } } }));
    return P.contextFraction(q) === null;
  })());
  check('contextUsed 超过 window 时截到 1', (() => {
    const q = P.parse(JSON.stringify({ record: { rows: { contextPressure: { seq: 1, val: { surfaceTokens: 999, contextWindow: 100 } } } } }));
    return P.contextFraction(q) === 1;
  })());
}

console.log('\n=== P4: 真实投影文件（命名两种形态 + 兜底）===');
{
  const files = SS.sessionFiles({ maxCount: 6 });
  let hit = 0;
  for (const f of files) {
    const url = P.projectionURL(f.file);
    if (!url) { console.log('     · ' + f.id.slice(0, 20) + ' → 无投影'); continue; }
    hit++;
    const p = P.load(f.file);
    if (hit === 1) {
      console.log('     样例 ' + path.basename(url));
      console.log('       seq=' + (p && p.seq) + ' title=' + JSON.stringify(p && p.title)
        + ' ctx=' + (p && p.contextUsed) + '/' + (p && p.contextWindow)
        + ' todo=' + (p && p.todoDone) + '/' + (p && p.todoTotal)
        + ' perm=' + JSON.stringify(p && p.permissionPreset));
      check('真实文件能解析出投影', p !== null && typeof p === 'object');
      check('真实投影 seq > 0', p && p.seq > 0, p && String(p.seq));
      check('真实投影通常有标题或 token（isEmpty=false）', p && !P.isEmpty(p), '全空');
    }
  }
  check('至少一个会话能命中投影文件', hit > 0, '命中 ' + hit + '/' + files.length);
  if (hit > 0) {
    // 缓存：第二次应极快
    const t0 = Date.now();
    const f0 = files.find((f) => P.projectionURL(f.file));
    P.load(f0.file);
    P.load(f0.file);
    check('投影缓存生效', Date.now() - t0 < 5, (Date.now() - t0) + 'ms');
  }

  // 命名兜底：把 `session-` 前缀去掉也应该能命中同一文件
  if (files.length > 0) {
    const real = P.projectionURL(files[0].file);
    if (real) {
      const base = path.basename(real);
      const stripped = base.replace(/^session-/, '');
      const idOnly = P.projectionURL(path.join(path.dirname(path.dirname(files[0].file)), stripped, 'session.v4.jsonl.zstd'));
      check('去 session- 前缀的目录名也能命中（兜底扫描）', idOnly === real, idOnly + ' vs ' + real);
    }
  }
}

console.log('\n=== P5: 找不到投影时返回 null ===');
{
  const fake = path.join(require('node:os').tmpdir(), 'dshwin-noproj-' + process.pid);
  fs.mkdirSync(path.join(fake, 'sessions', 'p', 'session-none'), { recursive: true });
  const old = process.env.DSH_ROOT;
  process.env.DSH_ROOT = fake;
  P.invalidate();
  const f = path.join(fake, 'sessions', 'p', 'session-none', 'session.v4.jsonl.zstd');
  check('无投影文件 → projectionURL 返回 null', P.projectionURL(f) === null);
  check('无投影文件 → load 返回 null', P.load(f) === null);
  if (old === undefined) delete process.env.DSH_ROOT; else process.env.DSH_ROOT = old;
  P.invalidate();
  fs.rmSync(fake, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);
