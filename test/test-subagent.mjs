// 子代理聚合 countActiveSubagents 测试
// 数据面依据: sessions 快照 subagentsByParent[parentId].entries[]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

let captured = null;
globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg; } } };
globalThis.document = { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, body: { appendChild() {} } };
new Function(src)();

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  → ' + e); } };

const reactStub = {
  createElement: () => ({}),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useSyncExternalStore: (s, g) => g(),
};
const mod = captured.factory((n) => { if (n === 'react') return reactStub; throw new Error('nf'); });
const count = mod.countActiveSubagents;

console.log('\n=== C1: 函数已导出 ===');
check('countActiveSubagents 导出', typeof count === 'function', typeof count);

console.log('\n=== C2: 基本计数 ===');
const mkSnap = (entries) => ({ subagentsByParent: { 'p1': { entries } } });
const face = (snap) => ({ list: { getSnapshot: () => snap } });

check('2 个 running 子代理',
  count(face(mkSnap([
    { kind: 'child', id: 'c1', activity: 'running' },
    { kind: 'child', id: 'c2', activity: 'running' },
  ])), 'p1') === 2);

check('混合状态只计 running',
  count(face(mkSnap([
    { kind: 'child', id: 'c1', activity: 'running' },
    { kind: 'child', id: 'c2', activity: 'done' },
    { kind: 'child', id: 'c3', activity: 'running' },
  ])), 'p1') === 2);

check('非 child 条目不计入',
  count(face(mkSnap([
    { kind: 'child', id: 'c1', activity: 'running' },
    { kind: 'parent', id: 'p1', activity: 'running' },
    { kind: 'other', id: 'x', activity: 'running' },
  ])), 'p1') === 1);

check('无 running → 0',
  count(face(mkSnap([{ kind: 'child', id: 'c1', activity: 'done' }])), 'p1') === 0);

console.log('\n=== C3: 容错（异常一律降级为 0）===');
check('sessionsFace 为 null', count(null, 'p1') === 0);
check('无 list 服务', count({}, 'p1') === 0);
check('parentSessionId 为空', count(face(mkSnap([])), null) === 0);
check('无 subagentsByParent', count(face({}), 'p1') === 0);
check('目录无 entries', count(face({ subagentsByParent: { p1: {} } }), 'p1') === 0);
check('entries 非数组', count(face({ subagentsByParent: { p1: { entries: 'nope' } } }), 'p1') === 0);
check('会话 id 不在目录中', count(face(mkSnap([])), 'other') === 0);
check('getSnapshot 抛异常 → 0', count({ list: { getSnapshot: () => { throw new Error('boom'); } } }, 'p1') === 0);
check('entries 含 null 不崩', count(face(mkSnap([null, undefined, { kind: 'child', id: 'c1', activity: 'running' }])), 'p1') === 1);

console.log('\n=== C4: showSubagentCount 配置被消费 ===');
check('client.js 读取 config.showSubagentCount', src.includes('config.showSubagentCount'));
check('client.js 使用 subagentCount 渲染徽章', /subagentCount > 0 && h\("div"/.test(src));
check('CSS 含子代理徽章样式', src.includes('vibe-subagent-badge'));
check('不再残留 isHoveringRef', !src.includes('isHoveringRef'));
check('不再残留 setConfig', !src.includes('setConfig'));
check('不再 import useRef', !/useRef/.test(src));
check('不再 import useCallback', !/useCallback/.test(src));

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(46));
globalThis.__results = globalThis.__results || {};
globalThis.__results.subagent = { pass, fail };
