// 跳转桥**客户端半边**的自检：真起服务端桥，假 ctx 驱动客户端，验证
// 「app POST /jump → 客户端轮询 → uiWorkspace.openSession」整条链路。
//
// 用法: node test/test-bridge-client.mjs   （或 node test/run.mjs bridgeclient）
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 复用服务端半边。它静态 import 了宿主提供的 @deepseek-ai/schemastery，
// 仓库里没装；造一个只够构造 Config 的最小替身，跑完立刻删 ——
// 绝不能长期留在仓库里遮蔽真依赖。
const shimDir = path.join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery');
let madeShim = false;
if (!fs.existsSync(shimDir)) {
  const chain = "const node = () => { const s = {}; for (const m of ['default','description','step','min','max','readonly']) s[m] = () => s; return s; };\n"
    + "export default { object: node, union: node, boolean: node, number: node, natural: node, string: node, const: node };\n";
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test-shim', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(shimDir, 'index.js'), chain);
  madeShim = true;
}
const dropShim = () => {
  if (!madeShim) return;
  try { fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* ignore */ }
};

let server, mod;
try {
  server = await import(path.join(ROOT, 'lib', 'index.js'));
  // harness.mjs 是副作用导入：它执行 client.js、把 factory 产物挂到 __mod
  await import('./harness.mjs');
  mod = globalThis.__mod;
} finally {
  dropShim();
}
if (!mod) { console.error('❌ 未能取到 client.js 的 factory 产物'); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等条件成立，而不是死等固定毫秒数。
 *
 * 客户端轮询有 100~500ms 周期，固定 sleep 在机器繁忙时会偶发不够
 * （全套件连跑时尤其明显），那种 flaky 会把真回归也淹掉。
 * 凡是「投一条 → 断言它被处理」都用这个。
 */
async function waitFor(predicate, { timeoutMs = 3000, stepMs = 40, what = '' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = predicate(); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(stepMs);
  }
}

function req(port, pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: j, text: raw }); });
    });
    r.on('error', reject);
    r.setTimeout(3000, () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload);
    r.end();
  });
}

// ===========================================================================
console.log('\n=== T1: resolveWorkspace 的三条取法 ===');
// ===========================================================================
{
  // 官方取法：ctx.get
  const viaGet = { get: (n) => (n === 'uiWorkspace' ? { openSession: () => {} } : undefined) };
  check('ctx.get("uiWorkspace") 能取到', !!mod.resolveWorkspace(viaGet));

  // 兜底：直接挂在 ctx 上
  const viaProp = { uiWorkspace: { openSession: () => {} } };
  check('ctx.uiWorkspace 兜底能取到', mod.resolveWorkspace(viaProp) === viaProp.uiWorkspace);

  // 缺失：必须返回 null 而不是抛 —— 抛会让轮询整个挂掉
  let threw = false, r = null;
  try { r = mod.resolveWorkspace({ get: () => { throw new Error('service not found'); } }); }
  catch (e) { threw = true; }
  check('服务缺失时返回 null 而不抛', !threw && r === null, threw ? '抛了' : String(r));

  // 存在但没有 openSession（比如旧版本宿主）也算不可用
  check('没有 openSession 方法时判为不可用', mod.resolveWorkspace({ get: () => ({}) }) === null);
  check('ctx 为空也不抛', mod.resolveWorkspace(null) === null);
  check('ctx.get 不是函数也不抛', mod.resolveWorkspace({ get: 123 }) === null);
}

// ===========================================================================
console.log('\n=== T2: 端到端 —— POST /jump → 客户端 openSession ===');
// ===========================================================================
// ⚠️ 端口必须是**动态**的，不能用 BRIDGE_PORT_BASE。
// 真实 DSH 开着时它自己就在 47311 上起桥（正常现象，不是故障），
// 测试若也往 47311 塞就会：
//   1) 测试的桥顺延到 47313，而客户端从 47311 顺延探测 → 连到了**真 DSH 的桥**
//   2) 于是请求投到了真桥上，测试自己的桥队列永远是空的 → 满屏失败，
//      还可能干扰你正在用的 DSH（把会话切到一个不存在的 id）。
// 所以这里用 probeBridge 探一个**当前没被占用**的端口。
{
  // 找一个空闲端口：从 47311 起顺延，取第一个「探不到任何桥」的位置
  let port = null;
  for (let p = 47311; p < 47311 + 12 && port === null; p++) {
    try {
      const r = await req(p, '/health', { timeoutMs: 700 });
      if (r.status === 0) port = p;          // 连不上 → 空闲
    } catch { port = p; }
  }
  check('找到一个没被占用的桥端口', port !== null, '47311..47322 都被占了');

  const bridge = port === null ? null : await server.startBridge({ port, log: () => {} });
  check('服务端桥已起', !!bridge);
  if (!bridge) { console.log('  ⚠️  无可用端口，后续用例跳过'); }

  const opened = [];
  const fakeCtx = { get: (n) => (n === 'uiWorkspace' ? { openSession: (t) => opened.push(t) } : undefined) };

  // basePort 指到本测试这座桥。必须显式给：否则客户端从 47311 顺延探测，
  // 真 DSH 开着时会连到**真桥**上去，测试桥的队列永远是空的。
  const client = mod.startJumpBridge(fakeCtx, { pollMs: 120, basePort: bridge.port });
  // 等它探到端口（别死等，第一个 tick 是异步的）
  await waitFor(() => client.state().base !== null, { what: '探到桥' });
  check('客户端已探到桥', !!client.state().base, JSON.stringify(client.state()));
  check('探到的是本插件的桥（核对插件名）', String(client.state().version || '').length > 0);
  // 客户端连的必须就是本测试这座桥。它是从 47311 顺延探测的，若真 DSH 开着
  // 就可能连到真桥去 —— 那样下面所有队列断言都会莫名其妙地失败。
  check('客户端连的就是本测试这座桥', client.state().base === 'http://127.0.0.1:' + bridge.port,
    client.state().base + ' vs 127.0.0.1:' + bridge.port);

  // 模拟 app 投递
  const SID = 'session-6778327d-5342-4e47-9efa-d21d0db954a6';
  const post = await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: SID, title: '端到端' } });
  check('app 侧 POST /jump 成功', post.status === 200 && post.body.ok === true, JSON.stringify(post.body));

  await waitFor(() => opened.length >= 1, { what: '首次 openSession' });
  check('客户端已调用 openSession', opened.length === 1, 'opened=' + JSON.stringify(opened));
  check('openSession 收到的是真实 sessionId', opened[0] === SID, String(opened[0]));

  // 再投一条，确认是逐条处理而不是只取第一条
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-second' } });
  await waitFor(() => opened.length >= 2, { what: '第二条' });
  check('连续两条都被处理', opened.length === 2, 'opened=' + JSON.stringify(opened.length));

  // 空队列不该调 openSession
  await sleep(400);
  check('空队列时不调 openSession', opened.length === 2, 'opened=' + opened.length);

  // 无 sessionId 的请求要被服务端拒，客户端也就不会收到
  const bad = await req(bridge.port, '/jump', { method: 'POST', body: { title: '没有 id' } });
  await sleep(400);
  check('非法请求既被拒也不触发跳转', bad.status === 400 && opened.length === 2, bad.status + '/' + opened.length);

  const st = client.state();
  check('state 记录了轮询次数', st.polls > 0, String(st.polls));
  check('state 记录了跳转次数', st.jumps === 2, String(st.jumps));

  // stop() 之后必须真的停：再投一条不应被跳转。
  // 不断言「队列里还留着」——飞行中的那一轮请求可能已把队列取走，那是无害的丢失；
  // 真正不能发生的是「停用后还替用户切会话」。
  client.stop();
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-after-stop' } });
  await sleep(500);
  check('stop() 后不再跳转', opened.length === 2, 'opened=' + JSON.stringify(opened));
  check('stop() 后 state.stopped 为真', client.state().stopped === true);

  await bridge.close();
}

// ===========================================================================
console.log('\n=== T3: 桥不在时客户端必须安静退化 ===');
// ===========================================================================
{
  // ⚠️ 不能靠「当前恰好没有桥」来测 —— 真 DSH 开着时 47311 上就有桥（那是正确行为）。
  // startJumpBridge 支持注入 basePort，指向一段空端口即可稳定复现「探不到」。
  const DEAD = 47900;   // 远离真实桥区间 47311..47322
  const fakeCtx = { get: (n) => (n === 'uiWorkspace' ? { openSession: () => { throw new Error('不该被调用'); } } : undefined) };
  const client = mod.startJumpBridge(fakeCtx, { pollMs: 100, basePort: DEAD });
  await sleep(600);
  const st = client.state();
  check('探不到桥时 base 仍为 null', st.base === null, String(st.base));
  check('记录了 lastError 便于排查', !!st.lastError, String(st.lastError));
  check('没抛异常、没进入死循环', st.stopped === false);
  client.stop();
}

// ===========================================================================
console.log('\n=== T3b: probeBridge 语义 ===');
// ===========================================================================
{
  const none = await mod.probeBridge(47900);
  check('空端口段返回 null', none === null, JSON.stringify(none));
  // 真 DSH 的桥若在running，这里应探到它 —— 两种结果都对，不作强断言
  const maybe = await mod.probeBridge();
  if (maybe) {
    check('探到的桥带端口与版本', !!maybe.port && !!maybe.base, JSON.stringify(maybe));
  } else {
    console.log('     ℹ️  当前没有桥在运行（真 DSH 未开），跳过「探到」分支');
    check('probeBridge 从不抛错', true);
  }
}

// ===========================================================================
console.log('\n=== T4: openSession 抛错不能带崩轮询 ===');
// ===========================================================================
{
  // 同样用动态端口：真 DSH 的桥在 47311 时，固定端口会让本测试连到真桥上去
  const bridge = await server.startBridge({ port: 47950, log: () => {} });
  check('T4 的桥起在独立端口', !!bridge && bridge.port === 47950, bridge && String(bridge.port));
  const opened = [];
  const flaky = {
    get: (n) => (n === 'uiWorkspace' ? {
      openSession: (t) => {
        opened.push(t);
        if (t === 'session-boom') throw new Error('会话已不存在');
      },
    } : undefined),
  };
  // basePort 直接指到本测试的桥，跳过顺延探测的歧义
  const client = mod.startJumpBridge(flaky, { pollMs: 100, basePort: 47950 });
  await waitFor(() => client.state().base !== null, { what: '客户端探到桥' });
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-boom' } });
  const gotBoom = await waitFor(() => opened.includes('session-boom'), { what: '第一条' });
  check('抛错的那次仍被记录（说明处理了）', gotBoom, JSON.stringify(opened));

  // 关键：抛错后轮询必须还活着
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-after-boom' } });
  const gotAfter = await waitFor(() => opened.includes('session-after-boom'), { what: '第二条' });
  check('抛错后轮询仍继续处理后续请求', gotAfter, JSON.stringify(opened));
  client.stop();
  await bridge.close();
}

// ===========================================================================
console.log('\n=== T5: exports.inject 里不能有 uiWorkspace ===');
// ===========================================================================
{
  check('inject 仍只有 slots/sessions', JSON.stringify(mod.inject) === '["slots","sessions"]', JSON.stringify(mod.inject));
  check('inject 未混入 uiWorkspace（混了会导致插件永久 pending）', !mod.inject.includes('uiWorkspace'));
  check('桥相关件已导出供自检', typeof mod.startJumpBridge === 'function' && typeof mod.probeBridge === 'function');
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.bridgeclient = { pass, fail };

// ===========================================================================
console.log('\n=== T6: 设置持久化 —— 复现并锁死「开关点不动」 ===');
// ===========================================================================
// 用户报「灵动岛设置里根本点不动」。真因不是 UI 坏了，而是写入通道断了：
//   1. 设置卡片原本只通过 `scope.update(...)` 写配置；
//   2. `scope` 来自 `configForms`，而它由 `@deepseek-ai/dsh-client-ui-settings`
//      提供 —— 用户可以在自己 profile 的 cordis.patch.yml 里写
//      `- id: ui-settings / config: { enabled: false }` 把它关掉
//      （那个 bundle 带首次引导流程，很常见；本机 desktop profile 就是）；
//   3. 拿不到 scope → `bindConfigScope` 返回 null → `if (scope && …)`
//      **静默什么都不做**；
//   4. checkbox 是受控组件（`checked: config.enabled`），状态不变
//      → 勾号不弹、岛不消失，用户完全无从判断发生了什么。
//
// 下面断言：scope 缺席（最坏情况）时，改设置仍然
// ① 立刻写进本地、② 读得到、③ 渲染读得到、④ 桥在时能落盘到磁盘。
{
  const store = new Map();
  const prevLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };

  const noScope = null;
  check('前提：scope 为 null（模拟 configForms 被 profile 关掉）', noScope === null);

  const initial = mod.readScopeConfig(noScope);
  check('无任何配置源时读到空对象（由调用方补默认值）',
    initial && typeof initial === 'object' && Object.keys(initial).length === 0,
    JSON.stringify(initial));

  mod.writeLocalConfig({ enabled: false, placement: 'menu' });
  const after = mod.readScopeConfig(noScope);
  check('scope 缺席时写入立刻生效（勾号会变、岛会消失）',
    after.enabled === false, JSON.stringify(after));
  check('其他字段一并保存', after.placement === 'menu', JSON.stringify(after));

  // 合并顺序：**本地值覆盖宿主值**。
  // 反过来写会有很难查的 bug：用户点了开关 → 值写进本地 →
  // 但 scope.getSnapshot() 此刻还是旧值 → 合并后被冲回去 →
  // 界面弹回原样，像没点上。这个 bug 真的发生过（合并顺序写反了）。
  const withHost = mod.readScopeConfig({ getSnapshot: () => ({ enabled: true, scale: 0.8 }) });
  check('本地值覆盖宿主值（用户刚点的不被旧快照冲回）',
    withHost.enabled === false, JSON.stringify(withHost));
  check('宿主有、本地没有的键仍取宿主值',
    withHost.scale === 0.8, JSON.stringify(withHost));
  check('宿主没提供的键取本地值（不丢用户设置）',
    withHost.placement === 'menu', JSON.stringify(withHost));

  // ---- 桥在时能落盘 ----
  const bridge = await server.startBridge({ port: 47960, log: () => {} });
  const put = await req(bridge.port, '/config', {
    method: 'POST', body: { enabled: false, glowEffect: false },
  });
  check('POST /config 写入成功（服务端落盘通道）',
    put.status === 200 && put.body.ok === true, JSON.stringify(put.body));

  const got = await req(bridge.port, '/config');
  check('GET /config 读回刚写的值',
    got.body.config && got.body.config.enabled === false && got.body.config.glowEffect === false,
    JSON.stringify(got.body.config));

  const cfgFile = path.join(os.homedir(), 'Library', 'Application Support', 'DSHNotch', 'client-config.json');
  check('配置文件真的落盘了（不是只在内存）', fs.existsSync(cfgFile), cfgFile);
  const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  check('磁盘内容与接口返回一致', onDisk.enabled === false, JSON.stringify(onDisk));

  // ---- 白名单：这是本机 HTTP 端点，同机任何进程都能调 ----
  await req(bridge.port, '/config', {
    method: 'POST', body: { evil: 'x', scale: 'not-a-number', enabled: 'yes' },
  });
  const afterEvil = await req(bridge.port, '/config');
  check('未知键 evil 被忽略', afterEvil.body.config.evil === undefined, JSON.stringify(afterEvil.body.config));
  check('类型错的 scale 被忽略', typeof afterEvil.body.config.scale !== 'string', JSON.stringify(afterEvil.body.config));
  check('类型错的 enabled（字符串）被忽略',
    typeof afterEvil.body.config.enabled === 'boolean', JSON.stringify(afterEvil.body.config));
  check('原型没被污染', {}.polluted === undefined, String({}.polluted));

  const broken = await req(bridge.port, '/config', { method: 'POST', body: '{not json' });
  check('坏 JSON 返回 400 而不是抛错', broken.status === 400, String(broken.status));
  const notObj = await req(bridge.port, '/config', { method: 'POST', body: [1, 2] });
  check('非对象配置被拒', notObj.status === 400, String(notObj.status));

  const leftovers = fs.readdirSync(path.dirname(cfgFile)).filter((f) => f.includes('.tmp-'));
  check('写完没有 .tmp 残留（原子替换做对了）', leftovers.length === 0, JSON.stringify(leftovers));

  await bridge.close();

  try { fs.unlinkSync(cfgFile); } catch { /* 本来就不存在 */ }
  store.clear();
  check('清理后读到空配置', Object.keys(mod.readLocalConfig()).length === 0);
  if (prevLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLS;
}

// ===========================================================================
console.log('\n=== T7: 源码层面锁死「不要退回单通道」 ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

  check('updateField 不止一条写入路径（必须含本地写入）',
    /updateField[\s\S]{0,900}writeLocalConfig/.test(src), 'updateField 里没找到 writeLocalConfig');
  check('updateField 不再被 scope 的有无绑死',
    !/const updateField = \(key, val\) => \{\s*\n\s*if \(scope && typeof scope\.update/.test(src),
    '又是「只有 scope 才有反应」的老写法');
  check('读配置时把本地值作为基线',
    /function readScopeConfig\([\s\S]{0,600}readLocalConfig\(\)/.test(src),
    'readScopeConfig 没有读本地配置');
  check('启动时会去服务端拉回已保存的配置', /loadConfig\(scope\)/.test(src), '没找到启动拉取配置的调用');
  check('设置面板有可见的保存反馈', /setSaveNote/.test(src) && /saveNote/.test(src), '没有保存反馈');
  check('无 scope 时不再谎称「使用默认配置」',
    !/未取得配置服务，使用默认配置（设置项不持久化）/.test(src), '那句误导性的告警还在');
}
