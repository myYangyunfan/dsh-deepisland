// 测试 apply() 的注册链路与容错。
//
// ⚠️ 窗口内的 DOM 灵动岛已被移除（2026-10），所以这里**不再测**
// createRoot / <style> 注入 / #dsh-vibe-island-root 容器 / CSS 选择器 ——
// 那些东西连同 VibeIslandApp、CSS_STYLES、ensureCss 一起删掉了。
//
// 插件现在只做三件事，每件都仍在下面被覆盖：
//   1. 注册设置面板卡片（控制物理刘海）
//   2. 维护本机回环桥（点岛跳会话）
//   3. 会话头部快捷入口（开/关物理刘海）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

let captured = null;
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }),
};
globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg; } } };
// localStorage stub：Node 环境没有它，而插件的读配置路径会先试它。
// 这里给一份可检查的实现，好断言「点击真的写进去了」。
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
};
new Function(src)();

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  → ' + e); } };

// --- 真实 React（stub 记录 hooks 调用，不实际渲染）---
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
// reactDomStub 保留：require 它时不该被调用，但要保证**不抛错**
//（万一将来代码又 require 它，测试要能立刻发现并给出清晰信息）
let reactDomRequired = 0;
const reactDomStub = { createRoot: () => { throw new Error('岛已移除，不应再调 createRoot'); } };
const requireStub = (n) => {
  if (n === 'react') return reactStub;
  if (n === 'react-dom/client' || n === 'react-dom') { reactDomRequired++; return reactDomStub; }
  throw new Error('not found: ' + n);
};

const mod = captured.factory(requireStub);

console.log('\n=== A1: apply() 注册链路（configForms 可用）===');
hookCalls.length = 0; reactDomRequired = 0;

let scopeCfg = { enabled: true, notchEnabled: true, placement: 'notch', platformMode: 'auto', glowEffect: true, expandOnHover: true, showSubagentCount: true, scale: 1.0 };
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

check('注册 2 个 slot 组件', registered.length === 2, 'got ' + registered.length);
check('注册 settings.section 卡片', registered.some(r => r.meta.name === 'settings.section'), JSON.stringify(registered.map(r => r.meta.name)));
check('注册 header 快捷按钮', registered.some(r => r.meta.name === 'conversation.session.header.utilities'), JSON.stringify(registered.map(r => r.meta.name)));

// 岛移除的核心断言：不该再 require react-dom，更不该调 createRoot
check('不再 require react-dom（岛已移除，不需要自己的渲染器）', reactDomRequired === 0, 'require 了 ' + reactDomRequired + ' 次');
check('client.js 里已无 DOM 岛挂载代码', !/createRoot\(/.test(src), '仍有 createRoot 调用');
// 注意：源码注释里提到了 CSS_STYLES / ensureCss（迁移说明），
// 所以只断言「没有定义」，不能断言「字符串完全不存在」。
check('client.js 里已无 CSS_STYLES / ensureCss 的定义',
  !/const CSS_STYLES|function ensureCss/.test(src), '仍有定义');
check('client.js 里已无 VibeIslandApp 组件', !/function VibeIslandApp/.test(src));
check('client.js 里已无岛容器 id', !/dsh-vibe-island-root/.test(src));

console.log('\n=== A2: 幂等性（重复 apply 不应重复注册）===');
const before = registered.length;
try { mod.apply(ctx); check('二次 apply 未抛异常', true); } catch (e) { check('二次 apply 未抛异常', false, e.message); }
check('二次 apply 确实又注册了一遍（宿主的 inject 语义，不重复注入 DOM）',
  registered.length >= before, 'before=' + before + ' after=' + registered.length);

console.log('\n=== A3: 配置服务缺失时仍能工作 ===');
hookCalls.length = 0;
const ctx2 = { sessions: { list: { getSnapshot: () => ({ activeId: 's' }) } }, slots: { inject: () => {}, register: () => {} } };
try { mod.apply(ctx2); check('无配置服务时不崩溃', true); }
catch (e) { check('无配置服务时不崩溃', false, e.message); }
check('无配置服务时也不 require react-dom', reactDomRequired === 0, 'require 了 ' + reactDomRequired + ' 次');

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

console.log('\n=== A6: header 按钮切换物理刘海 ===');
const hdr = registered.find(r => r.meta.name === 'conversation.session.header.utilities');
if (hdr) {
  scopeCfg = { ...scopeCfg, notchEnabled: true };
  const btn = hdr.comp({});
  check('渲染出 vibe-header-btn', btn.props && btn.props.className === 'vibe-header-btn', JSON.stringify(btn).slice(0, 140));
  check('按钮 title 表明当前是「关闭」', btn.props && /关闭/.test(btn.props.title || ''), btn.props && btn.props.title);
  if (btn.props && btn.props.onClick) {
    btn.props.onClick();
    // 走 saveConfig（异步），等一拍看结果
    await new Promise((r) => setTimeout(r, 120));
    const written = JSON.parse(globalThis.localStorage.getItem('dsh-vibe-island.config') || '{}');
    check('点击后写入 notchEnabled=false', written.notchEnabled === false, JSON.stringify(written));
    await new Promise((r) => setTimeout(r, 60));
    const btn2 = hdr.comp({});
    check('图标随之变化（⛔ 表示已关）',
      JSON.stringify(btn2).includes('⛔') && /开启/.test(btn2.props.title || ''),
      JSON.stringify(btn2).slice(0, 160));
  } else { check('按钮有 onClick', false, JSON.stringify(btn.props)); }
} else { check('找到 header 组件', false); }

console.log('\n=== A7: 设置面板控制的是物理刘海 ===');
const card = registered.find(r => r.meta.name === 'settings.section');
if (card) {
  scopeCfg = { ...scopeCfg, notchEnabled: true };
  const el = card.comp({ inject: () => ({ scope }) });
  const flat = JSON.stringify(el);
  check('面板里有「启用刘海灵动岛」开关', /启用刘海灵动岛/.test(flat), flat.slice(0, 200));
  // 精确查：不该再有 updateField("enabled", …) 这种调用
  // （用正则查源码比查渲染结果可靠 —— 渲染结果里 substrings 会误伤）
  check('开关写的是 notchEnabled（物理刘海），不是窗口内的 enabled',
    /updateField\("notchEnabled"/.test(src) && !/updateField\("enabled"/.test(src),
    '仍在写旧的 enabled 键');
  check('面板里有「点对话直接跳转」开关', /点对话直接跳转/.test(flat));
  check('面板里有「空闲时自动收起」开关', /空闲时自动收起/.test(flat));
  check('不再有「启用灵动岛状态栏」（那是窗口内岛，已删）', !/启用灵动岛状态栏/.test(flat));
} else { check('找到设置卡片', false); }

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.apply = { pass, fail };
