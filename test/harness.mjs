// 拉起 client.js 的 ModuleLoader factory，在 Node 里跑真实事件流
// 用法: node test/run.mjs <test-file>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(cfg) { captured = cfg; }
  }
};
globalThis.document = { getElementById: () => null, createElement: () => ({}), head: {appendChild(){}}, body: {appendChild(){}} };

// 直接执行 client.js（它会调用 window.__ModuleLoader__.load）
new Function(src)();

if (!captured) { console.log('❌ factory 未被捕获'); process.exit(1); }
console.log('✅ ModuleLoader.load 已捕获, id =', captured.id);

// 最小 react stub（只需 hooks 存在，测试不渲染）
const reactStub = {
  createElement: () => ({}),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (s, g) => g(),
};
const requireStub = (name) => {
  if (name === 'react') return reactStub;
  throw new Error('module not found: ' + name);   // 模拟 renderer 等不可用
};

const mod = captured.factory(requireStub);
console.log('✅ factory 执行成功, exports =', Object.keys(mod).join(', '));
console.log('   inject =', JSON.stringify(mod.inject));
globalThis.__mod = mod;
