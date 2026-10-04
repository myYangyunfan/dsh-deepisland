// 跳转桥**客户端半边**的自检：真起服务端桥，假 ctx 驱动客户端，验证
// 「app POST /jump → 客户端轮询 → uiWorkspace.openSession」整条链路。
//
// 用法: node test/test-bridge-client.mjs   （或 node test/run.mjs bridgeclient）
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
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
{
  // 桥必须占用客户端认得的那个端口区间内的第一个可用端口。
  // 客户端从 BRIDGE_PORT_BASE(47311) 起顺延探测，所以让桥从 47311 起。
  // 若本机 47311 已被占（比如 DSH 正在跑），桥会自己顺延，客户端也能跟上。
  const bridge = await server.startBridge({ port: mod.BRIDGE_PORT_BASE, log: () => {} });
  check('服务端桥已起', !!bridge);

  const opened = [];
  const fakeCtx = { get: (n) => (n === 'uiWorkspace' ? { openSession: (t) => opened.push(t) } : undefined) };

  const client = mod.startJumpBridge(fakeCtx, { pollMs: 120 });
  // 等它探到端口并完成至少一轮轮询
  await sleep(600);
  check('客户端已探到桥', !!client.state().base, JSON.stringify(client.state()));
  check('探到的是本插件的桥（核对插件名）', String(client.state().version || '').length > 0);

  // 模拟 app 投递
  const SID = 'session-6778327d-5342-4e47-9efa-d21d0db954a6';
  const post = await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: SID, title: '端到端' } });
  check('app 侧 POST /jump 成功', post.status === 200 && post.body.ok === true, JSON.stringify(post.body));

  await sleep(500);
  check('客户端已调用 openSession', opened.length === 1, 'opened=' + JSON.stringify(opened));
  check('openSession 收到的是真实 sessionId', opened[0] === SID, String(opened[0]));

  // 再投一条，确认是逐条处理而不是只取第一条
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-second' } });
  await sleep(400);
  check('连续两条都被处理', opened.length === 2, 'opened=' + JSON.stringify(opened.length));

  // 空队列不该调 openSession
  await sleep(300);
  check('空队列时不调 openSession', opened.length === 2, 'opened=' + opened.length);

  // 无 sessionId 的请求要被服务端拒，客户端也就不会收到
  const bad = await req(bridge.port, '/jump', { method: 'POST', body: { title: '没有 id' } });
  await sleep(300);
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
  // 指向一个肯定没人监听的端口区间：探测全失败
  const fakeCtx = { get: (n) => (n === 'uiWorkspace' ? { openSession: () => { throw new Error('不该被调用'); } } : undefined) };
  const client = mod.startJumpBridge(fakeCtx, { pollMs: 100 });
  await sleep(400);
  const st = client.state();
  check('探不到桥时 base 仍为 null', st.base === null, String(st.base));
  check('记录了 lastError 便于排查', !!st.lastError, String(st.lastError));
  check('没抛异常、没进入死循环', client.state().stopped === false);
  client.stop();
}

// ===========================================================================
console.log('\n=== T4: openSession 抛错不能带崩轮询 ===');
// ===========================================================================
{
  const bridge = await server.startBridge({ port: mod.BRIDGE_PORT_BASE, log: () => {} });
  const opened = [];
  const flaky = {
    get: (n) => (n === 'uiWorkspace' ? {
      openSession: (t) => {
        opened.push(t);
        if (t === 'session-boom') throw new Error('会话已不存在');
      },
    } : undefined),
  };
  const client = mod.startJumpBridge(flaky, { pollMs: 100 });
  await sleep(500);
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-boom' } });
  await sleep(300);
  check('抛错的那次仍被记录（说明处理了）', opened.includes('session-boom'), JSON.stringify(opened));

  // 关键：抛错后轮询必须还活着
  await req(bridge.port, '/jump', { method: 'POST', body: { sessionId: 'session-after-boom' } });
  await sleep(300);
  check('抛错后轮询仍继续处理后续请求', opened.includes('session-after-boom'), JSON.stringify(opened));
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
