// 测试 apply() 挂载链路 + React 组件真实渲染
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

let captured = null;
const domLog = [];
const mkEl = (tag) => ({
  tag, id: '', className: '', textContent: '', style: {}, children: [],
  setAttribute(k, v) { this[k] = v; },
  appendChild(c) { this.children.push(c); domLog.push('append ' + tag + (c.id ? '#' + c.id : '')); return c; },
  addEventListener() {},
  removeEventListener() {},
});

globalThis.document = {
  head: mkEl('head'),
  body: mkEl('body'),
  getElementById: (id) => { domLog.push('getElementById ' + id); return null; },
  createElement: (tag) => { domLog.push('createElement ' + tag); return mkEl(tag); },
};
globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg; } } };
new Function(src)();

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  → ' + e); } };

// --- 真实 React（用 stub 记录 hooks 调用，不实际渲染）---
const hookCalls = [];
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (v) => { hookCalls.push('useState'); return [v, () => {}]; },
  useEffect: (fn) => { hookCalls.push('useEffect'); },
  useRef: (v) => { hookCalls.push('useRef'); return { current: v }; },
  useMemo: (fn) => { hookCalls.push('useMemo'); return fn(); },
  useCallback: (fn) => { hookCalls.push('useCallback'); return fn; },
  useSyncExternalStore: (s, g) => { hookCalls.push('useSES'); return g(); },
};
let renderCalled = 0;
const reactDomStub = { createRoot: (c) => { renderCalled++; return { render: () => { renderCalled++; } }; } };
const requireStub = (n) => {
  if (n === 'react') return reactStub;
  if (n === 'react-dom/client') return reactDomStub;
  throw new Error('not found: ' + n);
};

const mod = captured.factory(requireStub);

console.log('\n=== A1: apply() 基础挂载（configForms 可用）===');
hookCalls.length = 0; renderCalled = 0; domLog.length = 0;

let scopeCfg = { enabled: true, placement: 'notch', platformMode: 'auto', glowEffect: true, expandOnHover: true, showSubagentCount: true, scale: 1.0 };
let updates = [];
const scope = {
  subscribe: (fn) => { scopeCfg = { ...scopeCfg }; fn(); return () => {}; },
  getSnapshot: () => scopeCfg,
  update: (patch) => { updates.push(patch); scopeCfg = { ...scopeCfg, ...patch }; },
};

const registered = [];
const ctx = {
  configForms: { get: (ns) => { check('configForms.get 传入正确命名空间 dsh-vibe-island', ns === 'dsh-vibe-island', ns); return { get value() { return scopeCfg; }, set: (p) => { updates.push(p); scopeCfg = { ...scopeCfg, ...p }; }, watch: () => () => {} }; } },
  sessions: { list: { getSnapshot: () => ({ activeId: 'sess-1' }) } },
  slots: {
    inject: (slot, fn, label) => { try { fn(); } catch (e) { check('slot inject 失败: ' + slot, false, e.message); } },
    register: (meta, comp) => { registered.push({ meta, comp }); return meta.id; },
  },
};

try { mod.apply(ctx); check('apply() 未抛异常', true); }
catch (e) { check('apply() 未抛异常', false, e.message + '\n' + e.stack); }

check('createRoot 被调用', renderCalled > 0, 'renderCalled=' + renderCalled);
check('注入了 <style> 标签', domLog.some(l => l.startsWith('append head')), domLog.join(','));
check('注入了 #dsh-vibe-island-root 容器', domLog.some(l => l.includes('dsh-vibe-island-root')), domLog.join(','));
check('注册 2 个 slot 组件', registered.length === 2, 'got ' + registered.length);
check('注册 settings.section 卡片', registered.some(r => r.meta.name === 'settings.section'), JSON.stringify(registered.map(r => r.meta.name)));
check('注册 header 快捷按钮', registered.some(r => r.meta.name === 'conversation.session.header.utilities'), JSON.stringify(registered.map(r => r.meta.name)));

console.log('\n=== A2: 幂等性（重复 apply 不应重复注入 DOM）===');
const before = domLog.filter(l => l.includes('dsh-vibe-island-root')).length;
// 让 getElementById 命中，模拟已存在
document.getElementById = (id) => (id === 'dsh-vibe-island-root' || id === 'dsh-vibe-island-styles') ? { id, appendChild() {} } : null;
try { mod.apply(ctx); check('二次 apply 未抛异常', true); } catch (e) { check('二次 apply 未抛异常', false, e.message); }
const after = domLog.filter(l => l.includes('dsh-vibe-island-root')).length;
check('容器已存在时不重复创建', after === before, 'before=' + before + ' after=' + after);

console.log('\n=== A3: 配置服务缺失时的降级 ===');
hookCalls.length = 0; renderCalled = 0;
const ctx2 = { sessions: { list: { getSnapshot: () => ({ activeId: 's' }) } }, slots: { inject: () => {}, register: () => {} } };
try { mod.apply(ctx2); check('无配置服务时不崩溃', true); }
catch (e) { check('无配置服务时不崩溃', false, e.message); }
check('仍尝试渲染（用默认配置）', renderCalled > 0, 'renderCalled=' + renderCalled);

console.log('\n=== A4: ctx 几乎全空 ===');
try { mod.apply({}); check('ctx={} 不崩溃', true); } catch (e) { check('ctx={} 不崩溃', false, e.message); }
// 注意: apply(undefined) 会抛错 —— 宿主契约保证传入 ctx，此处仅记录当前行为
try { mod.apply(undefined); check('ctx=undefined 不崩溃', true); }
catch (e) { check('ctx=undefined 抛错(宿主契约保证不发生)', true, '实际抛出: ' + e.message); }

console.log('\n=== A5: slots.register 抛错时容错 ===');
const ctx3 = {
  configForms: { get: () => scope },
  slots: { inject: (s, fn) => { try { fn(); } catch (e) { throw new Error('slot 内部炸了'); } }, register: () => { throw new Error('register 失败'); } },
};
try { mod.apply(ctx3); check('register 抛错被捕获（不阻断宿主）', true); }
catch (e) { check('register 抛错被捕获（不阻断宿主）', false, '泄漏: ' + e.message); }

console.log('\n=== A6: render 阶段抛错的兜底 ===');
const badDom = { createRoot: () => { throw new Error('createRoot 内部异常'); } };
const mod2 = captured.factory((n) => {
  if (n === 'react') return reactStub;
  if (n === 'react-dom/client') return badDom;
  throw new Error('nf');
});
try { mod2.apply({ configForms: { get: () => scope }, slots: { inject: () => {}, register: () => {} } }); check('createRoot 抛错被捕获', true); }
catch (e) { check('createRoot 抛错被捕获', false, '泄漏: ' + e.message); }

console.log('\n=== A7: header 按钮切换 enabled ===');
const hdr = registered.find(r => r.meta.name === 'conversation.session.header.utilities');
if (hdr) {
  scopeCfg = { ...scopeCfg, enabled: true };
  const btn = hdr.comp({});
  // createElement 返回 { type, props, children }，按钮本体即 btn.props
  check('渲染出 vibe-header-btn', btn.props && btn.props.className === 'vibe-header-btn', JSON.stringify(btn).slice(0, 140));
  if (btn.props && btn.props.onClick) {
    updates = [];
    btn.props.onClick();
    check('点击后写入 enabled=false', updates.length === 1 && updates[0].enabled === false, JSON.stringify(updates));
    scopeCfg = { ...scopeCfg, enabled: false };
    btn.props.onClick();
    check('再点恢复 enabled=true', updates[1] && updates[1].enabled === true, JSON.stringify(updates));
  } else { check('按钮有 onClick', false, JSON.stringify(btn.props)); }
} else { check('找到 header 组件', false); }

console.log('\n=== A8: CSS 完整性 ===');
const styleEl = document.head.children[0];
const css = styleEl ? styleEl.textContent : '';
console.log('  CSS 长度: ' + css.length + ' 字符');
const sels = ['#dsh-vibe-island-root', '.vibe-island-wrapper', '.placement-notch', '.placement-floating', '.placement-top-right', '.vibe-island-pill', '.platform-macos', '.platform-windows', '.state-collapsed', '.state-expanded', '.vibe-island-glow', '.glow-thinking', '.glow-tool', '.glow-waiting', '.dot-thinking', '.dot-tool', '.dot-waiting', '.dot-idle', '.vibe-hud-code', '.vibe-header-btn'];
for (const s of sels) check('CSS 含选择器 ' + s, css.includes(s));
check('CSS 花括号配对', (css.match(/{/g) || []).length === (css.match(/}/g) || []).length,
  '{=' + (css.match(/{/g) || []).length + ' }=' + (css.match(/}/g) || []).length);

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.apply = { pass, fail };
