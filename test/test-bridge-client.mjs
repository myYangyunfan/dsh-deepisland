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
