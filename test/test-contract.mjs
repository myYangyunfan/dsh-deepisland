// 宿主契约验证：inject 声明的服务必须真实存在，且配置读取路径可用
// 背景：曾因注入不存在的 `settingsScope` 服务，插件永远停在
//      "pending (waiting for service: settingsScope)" 而无法激活。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  → ' + e); } };

const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

console.log('\n=== H1: inject 声明 ===');
const m = src.match(/exports\.inject\s*=\s*\[([^\]]*)\]/);
check('exports.inject 存在', !!m);
const inject = m[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean);
console.log('  声明: [' + inject.join(', ') + ']');
check('不再注入 settingsScope', !inject.includes('settingsScope'), inject.join(','));
check('不再注入不存在的服务', inject.every(s => s !== 'settingsScope'));

// 关键回归：可被用户禁用的服务绝不能进 inject。
// configForms 由 @deepseek-ai/dsh-client-ui-settings 提供，用户可在 profile 的
// cordis.patch.yml 里 `enabled: false` 关掉它（本机 desktop profile 就是如此）。
// 一旦注入，缺失时 Cordis 会无限等待 → 插件永久 pending。
console.log('\n=== H1b: 可禁用服务不得进 inject ===');
const PATCH_FILE = '/Users/delinger/.dsh/profiles/desktop/cordis.patch.yml';
if (fs.existsSync(PATCH_FILE)) {
  const patch = fs.readFileSync(PATCH_FILE, 'utf8');
  const disabled = [];
  patch.split('\n').forEach((line, i) => {
    if (/enabled:\s*false/.test(line)) {
      for (let j = i; j >= 0; j--) {
        if (/- id:/.test(patch.split('\n')[j])) { disabled.push(patch.split('\n')[j].trim()); break; }
      }
    }
  });
  console.log('  本机 desktop profile 被禁用的条目: ' + (disabled.length ? disabled.join(', ') : '(无)'));
  const settingsOff = /ui-settings[\s\S]{0,80}enabled:\s*false/.test(patch);
  if (settingsOff) console.log('  ⚠️  检测到 dsh-client-ui-settings 被禁用 → configForms 不可用');
  check('configForms 未被注入（因其可被禁用）', !inject.includes('configForms'),
    'configForms 会因 ui-settings 被禁用而导致 pending');
  check('configForms 改为运行时探测', /ctx\.configForms\s*&&\s*typeof ctx\.configForms\.get/.test(src));
  check('无配置服务时仍渲染（不返回 null）', !/if \(!scope\)\s*return null/.test(src));
} else {
  check('configForms 未被注入', !inject.includes('configForms'));
}

console.log('\n=== H2: 宿主 bundle 中是否存在这些服务 ===');
let asar = '';
if (fs.existsSync(ASAR)) {
  // ⚠️ 用宿主自带的 Node（runtime/bin/node）跑本套件时，Electron 的 asar fs
  // 包装器会拦截 `readFileSync(app.asar)` 并报
  // "ENOENT, not found in app.asar" —— 它把 asar **当成目录**处理。
  // 解法是 ELECTRON_NO_ASAR=1（Electron 官方开关），在 run.mjs 里设。
  // 这里再兜一层：真读不出来就跳过这一节，别让整轮回归红掉。
  try {
    asar = fs.readFileSync(ASAR).toString('latin1');
  } catch (e) {
    console.log('  ⚠️  读不到宿主 asar（' + ((e && e.code) || e) + '）—— 跳过本节。');
    console.log('     若在 Electron Node 下跑，请设 ELECTRON_NO_ASAR=1');
  }
}
if (asar) {
  console.log('  已读取宿主 asar (' + (asar.length / 1048576).toFixed(0) + ' MB)');
  // 宿主里真实出现过的客户端服务名（从 inject 组合里提取）
  const known = new Set();
  const re = /const inject = \[([\s\S]{0,300}?)\];/g;
  let mm;
  while ((mm = re.exec(asar))) {
    mm[1].split(',').map(x => x.trim().replace(/["'`]/g, '')).filter(Boolean).forEach(x => known.add(x));
  }
  console.log('  宿主已知客户端服务 (' + known.size + ' 个，含 ' + [...known].slice(0, 8).join(', ') + ' ...)');
  for (const svc of inject) {
    check('宿主提供服务 "' + svc + '"', known.has(svc), known.has(svc) ? '' : '宿主 inject 组合中未出现');
  }
  check('settingsScope 在宿主中不存在（故不能注入）', !known.has('settingsScope'));
} else {
  console.log('  ⚠️  未找到宿主 asar，跳过（' + ASAR + '）');
}

console.log('\n=== H3: 配置读取路径（configForms）===');
check('优先使用 ctx.configForms.get', /ctx\.configForms\s*&&\s*typeof ctx\.configForms\.get/.test(src));
check('保留 settingsScope 兼容回退', /ctx\.settingsScope\s*&&\s*typeof ctx\.settingsScope\.bind/.test(src));
check('有 normalizeScope 统一形态', /function normalizeScope/.test(src));
check('有 readScopeConfig 安全读取', /function readScopeConfig/.test(src));
// 无配置服务时必须有提示。
//
// ⚠️ 文案别改回「使用默认配置（设置项不持久化）」—— 那是误导：
// 用户会以为自己的设置丢了，而实际上插件已经能自己保存（见
// client.js 的 saveConfig：桥在则落盘、不在则 localStorage）。
// 那句话是「开关点不动」这个 bug 的帮凶之一：用户看不到真实原因。
//
// 岛移除后 apply() 里不再有「未取得配置服务」这句 —— 因为现在没有
// 「降级到默认配置」这回事：设置面板照样工作，物理刘海由 app 读文件。
// 改为断言「不再宣称会降级」。
check('无配置服务时不再宣称「降级到默认配置」',
  !/未取得配置服务/.test(src), '那句过时的降级告警还在');
check('有配置源诊断输出（便于排查）', /配置源: /.test(src));

console.log('\n=== H4: 运行期行为（用真实宿主形态的 ctx 驱动）===');
// 桩 window/document 以便执行 client.js
let captured = null;
globalThis.window = { __ModuleLoader__: { load(cfg) { captured = cfg; } } };
const mkEl = () => ({ id: '', textContent: '', style: {}, children: [], appendChild(c) { this.children.push(c); return c; }, addEventListener() {} });
globalThis.document = { getElementById: () => null, createElement: () => mkEl(), head: mkEl(), body: mkEl() };
new Function(src)();

const reactStub = {
  createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c.flat().filter(x => x != null && x !== false) }),
  useState: (v) => [v, () => {}], useEffect: () => {}, useMemo: (fn) => fn(),
  useSyncExternalStore: (s, g) => g(),
};
const mod = captured.factory((n) => { if (n === 'react') return reactStub; throw new Error('nf'); });

// 模拟宿主真实 configForms：ctx.configForms.get(ns) → { value, set, watch }
const makeCtx = (getter) => {
  const registered = [];
  return {
    ctx: {
      configForms: { get: getter },
      sessions: { list: { getSnapshot: () => ({ activeId: 's1' }) } },
      slots: { inject: (s, f) => { try { f(); } catch (e) {} }, register: (meta, comp) => { registered.push({ meta, comp }); return meta.id; } },
    },
    registered,
  };
};

const bind = mod.bindConfigScope;
check('bindConfigScope 已导出', typeof bind === 'function');

// 形态 1：{ value, set, watch }（configForms 真实形态）
{
  let store = { enabled: true, placement: 'notch' };
  const { ctx } = makeCtx(() => ({
    get value() { return store; },
    set: (p) => { store = { ...store, ...p }; },
    watch: () => () => {},
  }));
  const scope = bind(ctx);
  check('形态1(configForms value/set/watch) 绑定成功', !!scope);
  check('形态1 getSnapshot 读到值', scope && scope.getSnapshot().placement === 'notch', JSON.stringify(scope && scope.getSnapshot()));
  check('形态1 update 可写', !!(scope && typeof scope.update === 'function'));
  if (scope) { scope.update({ placement: 'floating' }); check('形态1 写入生效', scope.getSnapshot().placement === 'floating', scope.getSnapshot().placement); }
}

// 形态 2：{ getSnapshot, subscribe, update }（快照存储）
{
  let v = { enabled: false };
  const { ctx } = makeCtx(() => ({ getSnapshot: () => v, subscribe: () => () => {}, update: (p) => { v = { ...v, ...p }; } }));
  const scope = bind(ctx);
  check('形态2(快照存储) 绑定成功', !!scope && scope.getSnapshot().enabled === false);
}

// 形态 3：无任何配置服务
{
  const scope = bind({ sessions: {}, slots: {} });
  check('形态3(无配置服务) 返回 null 而非抛错', scope === null);
}

// 形态 4：configForms.get 抛错 → 应回退而非崩
{
  const scope = bind({ configForms: { get: () => { throw new Error('boom'); } }, sessions: {}, slots: {} });
  check('形态4(configForms 抛错) 降级为 null 不崩', scope === null);
}

console.log('\n=== H5: apply() 在真实 configForms 下完整挂载 ===');
{
  let store = { enabled: true, placement: 'notch', platformMode: 'auto', glowEffect: true, expandOnHover: true, showSubagentCount: true, scale: 1.0 };
  const { ctx, registered } = makeCtx(() => ({
    get value() { return store; },
    set: (p) => { store = { ...store, ...p }; },
    watch: () => () => {},
  }));
  let threw = null;
  const warns = [];
  const ow = console.warn; console.warn = (m) => warns.push(String(m));
  try { mod.apply(ctx); } catch (e) { threw = e.message; }
  console.warn = ow;
  check('apply() 未抛异常', threw === null, threw);
  check('未产生「未取得配置服务」告警', !warns.some(w => /未取得配置服务/.test(w)), JSON.stringify(warns));
  check('注册了 2 个 slot', registered.length === 2, 'got ' + registered.length);
}

console.log('\n=== H6: apply() 在无配置服务时仍能工作（不被缺服务阻断）===');
{
  const { ctx, registered } = makeCtx(null);
  delete ctx.configForms;
  let threw = null;
  const warns = [];
  const ow = console.warn; console.warn = (m) => warns.push(String(m));
  try { mod.apply(ctx); } catch (e) { threw = e.message; }
  console.warn = ow;
  check('无配置服务时 apply() 不抛异常', threw === null, threw);
  // 不再要求「降级告警」：岛移除后没有降级路径了 ——
  // 设置面板照样工作（自己存配置），物理刘海由 app 读同一份文件。
  check('无配置服务也不阻断功能（2 个 slot 都注册了）',
    registered.length === 2, 'got ' + registered.length);
  check('没有把「拿不到配置服务」当成错误（不应有相关告警）',
    !warns.some((w) => /未取得配置服务/.test(w)), JSON.stringify(warns));
}

console.log('\n=== H7: 服务端命名空间契约（dsh-settings）===');
const srv = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
const nsMatch = srv.match(/const NS = '([^']+)'/);
check('服务端声明 NS', !!nsMatch, '未找到 const NS');
const NS = nsMatch && nsMatch[1];
console.log('  命名空间: ' + NS);
// @deepseek-ai/dsh-settings 要求：小写连字符标识符，重复注册抛错
check('NS 为小写连字符标识符（合法）', /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(NS), NS);
check('服务端 inject 为 [settings]', /export const inject = \['settings'\]/.test(srv), srv.match(/export const inject = \[[^\]]*\]/) && srv.match(/export const inject = \[[^\]]*\]/)[0]);
check('register 调用签名正确 (ns, schema, {base})', /ctx\.settings\.register\(\s*NS,\s*Config,\s*\{\s*base:/.test(srv));
// 2026-06:降级路径改走统一 log()（同时写诊断文件），不再用 console.warn。
// 断言跟着行为走：只要「catch 里有输出」即可，不绑定具体 API。
check('register 失败被 try/catch 捕获', /catch\s*\(error\)[\s\S]{0,200}log\(/.test(srv));
check('降级日志走统一 log()（GUI 启动时 console 用户看不到）',
  !/catch\s*\(error\)[\s\S]{0,200}console\.warn/.test(srv));
check('诊断文件落在应用数据目录', /plugin-diagnose\.log/.test(srv));
// 🔴 ESM 里没有 require。第一版在 apply() 里写 require('node:fs')造日志，
// 抛的 ReferenceError 被外层 catch 吞掉 → logFile 恒为 null →
// **诊断日志永远不生成，而且看不出任何异常**。真踩过。
check('ESM 作用域内不得使用 require()',
  !/[^\w.\$]require\(\s*['"]node:/.test(srv.replace(/\/\/[^\n]*/g, '')),
  (srv.match(/[^\w.\$]require\(\s*['"]node:[^\n]*/) || [])[0] || '');
check('诊断日志用顶层静态 import 的 fs/path',
  /import fsSync from 'node:fs'/.test(srv) && /import pathSync from 'node:path'/.test(srv));
check('settings 服务缺失时也有告警', /settings 服务不可用/.test(srv));
// 客户端与服务端 NS 必须一致
const cliNs = (src.match(/const NS = "([^"]+)"/) || [])[1];
check('客户端 NS 与服务端一致', cliNs === NS, cliNs + ' vs ' + NS);
// 客户端 configForms.get 也用同一 NS
check('configForms.get 使用同一 NS', new RegExp('configForms\\.get\\(NS\\)').test(src));

console.log('\n' + '='.repeat(50));
console.log('宿主契约验证: 通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(50));
globalThis.__results = globalThis.__results || {};
globalThis.__results.contract = { pass, fail };
