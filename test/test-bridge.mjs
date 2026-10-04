// 跳转桥 + 自动安装器的自检：真起 HTTP 服务、真发请求、真造目录判状态。
//
// 用法: node test/test-bridge.mjs   （或 node test/run.mjs bridge）
//
// 为什么这个套件不依赖 client.js 的 harness：它测的是**服务端半边**
// （lib/index.js），跑在 DSH 的 Node 宿主进程里，与渲染进程无关。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp', 'bridge');

// ---------------------------------------------------------------------------
// lib/index.js 静态 import 了 @deepseek-ai/schemastery（宿主提供的依赖），
// 仓库里没有 node_modules，解析不到。造一个只够构造 Config 的最小替身，
// 跑完立刻删掉 —— 绝不能长期留在仓库里遮蔽真依赖。
// ---------------------------------------------------------------------------
const SHIM_DIR = path.join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery');
let madeShim = false;
function ensureSchemasteryShim() {
  if (fs.existsSync(SHIM_DIR)) return;
  // 链式 no-op schema：只需要 default/description/step/min/max 存在
  const node = () => {
    const s = {};
    for (const m of ['default', 'description', 'step', 'min', 'max', 'readonly']) {
      s[m] = () => s;
    }
    return s;
  };
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SHIM_DIR, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test-shim', type: 'module', main: 'index.js' }, null, 2),
  );
  const Z = { object: node, union: node, boolean: node, number: node, natural: node, string: node, const: node };
  fs.writeFileSync(path.join(SHIM_DIR, 'index.js'), `const node = () => { const s = {}; for (const m of ['default','description','step','min','max','readonly']) s[m] = () => s; return s; };
export default { object: node, union: node, boolean: node, number: node, natural: node, string: node, const: node };
`);
  madeShim = true;
}
function dropSchemasteryShim() {
  if (!madeShim) return;
  try { fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* ignore */ }
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + extra); }
};

ensureSchemasteryShim();
let mod;
try {
  mod = await import(path.join(ROOT, 'lib', 'index.js'));
} finally {
  dropSchemasteryShim();
}

const { startBridge, parseSums, releaseArch, appInstallState, BRIDGE_PORT, PLUGIN_VERSION } = mod;

// ---------------------------------------------------------------------------
// 端口分配：用一个当前空闲的高位端口，避免撞上真实桥（47311 可能已在跑）
// ---------------------------------------------------------------------------
const net = await import('node:net');
globalThis.__http = await import('node:http');
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
const base = await freePort();
const B = 'http://127.0.0.1:';

/**
 * 用 node:http 而不是 fetch 发请求。
 *
 * 原因：作者本机的执行沙箱允许 listen 回环，但**拦截 fetch(undici) 到
 * 127.0.0.1**（自请求直接超时，exit 137）。node:http 走的是同一条回环，
 * 实测正常。桥服务端本身也是 node:http，所以这样测的是真实路径。
 * 注意这只影响本仓库的测试环境 —— 桥的**客户端**在 DSH 渲染进程里用的是
 * 浏览器 fetch，与此无关。
 */
function request(port, pathname, { method = 'GET', body = null, timeoutMs = 3000 } = {}) {
  const http = globalThis.__http;
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, headers: res.headers, text: raw, body: json });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const getJson = (port, p) => request(port, p);
const postJson = (port, p, raw) => request(port, p, { method: 'POST', body: raw });
const getText = async (port, p) => (await request(port, p)).text;

// ===========================================================================
console.log('\n=== T1: 纯函数 ===');
// ===========================================================================
{
  const sums = [
    'b142989be21106071e87c4da12ccf4755fe13c0bac05dc8d7fc6c6b56ed527db  DSHNotch-0.3.0-arm64.zip',
    'a'.repeat(64) + '  DSHNotch-0.3.0-x86_64.zip',
  ].join('\n');

  check('parseSums 取到 arm64 摘要',
    parseSums(sums, 'DSHNotch-0.3.0-arm64.zip') === 'b142989be21106071e87c4da12ccf4755fe13c0bac05dc8d7fc6c6b56ed527db');
  check('parseSums 区分架构（不会拿错包）',
    parseSums(sums, 'DSHNotch-0.3.0-x86_64.zip') === 'a'.repeat(64));
  check('parseSums 缺失文件返回 null', parseSums(sums, 'DSHNotch-9.9.9-arm64.zip') === null);
  check('parseSums 空输入返回 null', parseSums('', 'x.zip') === null);
  check('parseSums 兼容 shasum 的 * 二进制标记',
    parseSums('b'.repeat(64) + ' *DSHNotch-1.0.0-arm64.zip', 'DSHNotch-1.0.0-arm64.zip') === 'b'.repeat(64));
  check('parseSums 容忍 CRLF',
    parseSums('c'.repeat(64) + '  DSHNotch-1.0.0-arm64.zip\r\n', 'DSHNotch-1.0.0-arm64.zip') === 'c'.repeat(64));
  // 摘要写错一个字符就必须认不出来 —— 这是「不校验就执行」的最后一道闸
  check('parseSums 不接受 63 位短摘要', parseSums('a'.repeat(63) + '  x.zip', 'x.zip') === null);

  check('releaseArch arm64 → arm64（与 build.sh 的 uname -m 一致）', releaseArch('arm64') === 'arm64');
  check('releaseArch x64 → x86_64（Node 与 uname 叫法不同）', releaseArch('x64') === 'x86_64');
  check('releaseArch 未知架构返回空', releaseArch('mips') === '');

  check('BRIDGE_PORT 在合法范围内', BRIDGE_PORT > 1024 && BRIDGE_PORT < 65536, String(BRIDGE_PORT));
  check('PLUGIN_VERSION 已设置', typeof PLUGIN_VERSION === 'string' && PLUGIN_VERSION.length > 0);
}

// ===========================================================================
console.log('\n=== T2: 桥起停 + /health ===');
// ===========================================================================
let bridge = null;
{
  bridge = await startBridge({ port: base, log: () => {} });
  check('startBridge 返回实例', !!bridge);
  if (!bridge) { console.log('  ⚠️  桥起不来，后续用例跳过'); }

  if (bridge) {
    check('端口即请求的端口', bridge.port === base, bridge.port + ' vs ' + base);

    const h = await getJson(base, '/health');
    check('/health 200', h.status === 200, String(h.status));
    check('/health ok=true', h.body.ok === true);
    check('/health 带插件名', h.body.plugin === '@dsh-external/dsh-vibe-island', h.body.plugin);
    check('/health 带版本（客户端据此自证）', h.body.version === PLUGIN_VERSION, h.body.version);
    check('/health 初始 pending=0', h.body.pending === 0, String(h.body.pending));

    check('/health 带 CORS 头（渲染进程要跨源读）',
      h.headers['access-control-allow-origin'] === '*',
      String(h.headers['access-control-allow-origin']));

    const opt = await request(base, '/jump', { method: 'OPTIONS' });
    check('OPTIONS 预检 204', opt.status === 204, String(opt.status));
    check('OPTIONS 回 CORS 头', opt.headers['access-control-allow-origin'] === '*');
    check('OPTIONS 允许 POST', (opt.headers['access-control-allow-methods'] || '').includes('POST'));

    const text = await getText(base, '/');
    check('GET / 返回协议说明', text.includes('/next') && text.includes('/jump'), text.slice(0, 40));

    const nf = await getJson(base, '/nope');
    check('未知路径 404 + JSON', nf.status === 404 && nf.body.ok === false, String(nf.status));
  }
}

// ===========================================================================
console.log('\n=== T3: 跳转请求入队 → 取出 → 清空 ===');
// ===========================================================================
if (bridge) {
  const SID = 'session-6778327d-5342-4e47-9efa-d21d0db954a6';
  const p = await postJson(base, '/jump', { sessionId: SID, title: '点岛验收' });
  check('POST /jump 200', p.status === 200, String(p.status));
  check('POST /jump 回 ok + seq', p.body.ok === true && p.body.seq === 1, JSON.stringify(p.body));
  check('POST /jump 回 pending=1', p.body.pending === 1, String(p.body.pending));

  const n1 = await getJson(base, '/next');
  check('/next 200', n1.status === 200);
  check('/next 带 1 条', n1.body.items.length === 1, String(n1.body.items.length));
  check('/next 原样带回 sessionId', n1.body.items[0].sessionId === SID, n1.body.items[0].sessionId);
  check('/next 带回标题', n1.body.items[0].title === '点岛验收', n1.body.items[0].title);
  check('/next 带 ts 供客户端判新旧', typeof n1.body.items[0].ts === 'number');

  const n2 = await getJson(base, '/next');
  check('/next 取走即清空（不会重复跳两次）', n2.body.items.length === 0, String(n2.body.items.length));

  // 这两个响应必须回显 plugin —— macOS app 侧（SessionJump.postToBridge）
  // 与客户端都靠它确认「回环上这个服务真是本插件」，否则 47311 附近有别的
  // 服务时会把别人的 200 当成桥。少了它 Swift 端会静默判 false。
  check('/jump 响应回显 plugin（app 侧据此确认身份）',
    p.body.plugin === '@dsh-external/dsh-vibe-island', JSON.stringify(p.body));
  check('/next 响应回显 plugin（客户端据此确认身份）',
    n1.body.plugin === '@dsh-external/dsh-vibe-island', JSON.stringify(Object.keys(n1.body)));
  check('两个响应都带版本号', p.body.version === PLUGIN_VERSION && n1.body.version === PLUGIN_VERSION);

  const bad = await postJson(base, '/jump', { title: '没有 id' });
  check('缺 sessionId → 400', bad.status === 400, String(bad.status));
  const broken = await postJson(base, '/jump', '{not json');
  check('非法 JSON → 400', broken.status === 400, String(broken.status));
  const n3 = await getJson(base, '/next');
  check('被拒的请求不入队', n3.body.items.length === 0, String(n3.body.items.length));
}

// ===========================================================================
console.log('\n=== T4: 过期丢弃 / 队列上限 ===');
// ===========================================================================
if (bridge) {
  // 把时钟往前拨 10 分钟再 POST：模拟 DSH 冷启动期间压进来的陈旧请求。
  // 若不丢弃，用户开 DSH 时会被一条十分钟前的点击劫持到某个会话。
  const realNow = Date.now;
  Date.now = () => realNow() - 10 * 60 * 1000;
  await postJson(base, '/jump', { sessionId: 'session-stale' });
  Date.now = realNow;
  const n = await getJson(base, '/next');
  check('超过 45s 的请求被丢弃', n.body.items.length === 0, '剩 ' + n.body.items.length);

  for (let i = 0; i < 40; i++) await postJson(base, '/jump', { sessionId: 'session-bulk-' + i });
  const n2 = await getJson(base, '/next');
  check('队列上限 32（不被无限撑大）', n2.body.items.length === 32, String(n2.body.items.length));
  check('超限时丢最旧的（保最新）',
    n2.body.items[n2.body.items.length - 1].sessionId === 'session-bulk-39',
    n2.body.items[n2.body.items.length - 1].sessionId);
}

// ===========================================================================
console.log('\n=== T5: 端口被占时顺延 ===');
// ===========================================================================
{
  const p2 = await freePort();
  const first = await startBridge({ port: p2, log: () => {} });
  check('第二个实例也起来了', !!first);
  if (first) {
    check('第一个占住起始端口', first.port === p2, first.port + ' vs ' + p2);
    const second = await startBridge({ port: p2, log: () => {} });
    check('同端口的第二个实例顺延而非失败', !!second && second.port === p2 + 1, second && String(second.port));
    const hh = await getJson(p2, '/health');
    check('两个实例互不串号', hh.body.port === p2, String(hh.body.port));
    if (second) await second.close();
    await first.close();
  }
}

// ===========================================================================
console.log('\n=== T6: close 后端口确实释放 ===');
// ===========================================================================
if (bridge) {
  const wasPort = bridge.port;
  await bridge.close();
  let refused = false;
  try { await request(wasPort, '/health', { timeoutMs: 1500 }); }
  catch { refused = true; }
  check('close 之后连不上（不吊着端口）', refused);

  // 端口文件必须在退出时清掉：留着会让 app 往没人监听的端口发请求
  const pf = path.join(process.env.HOME, 'Library', 'Application Support', 'DSHNotch', 'bridge.json');
  check('端口文件已清理', !fs.existsSync(pf), pf);
}

// ===========================================================================
console.log('\n=== T7: app 安装状态判定 ===');
// ===========================================================================
{
  fs.rmSync(TMP, { recursive: true, force: true });
  const mk = (root, { bin = true, zstd = true } = {}) => {
    const app = path.join(root, 'DSHNotch.app', 'Contents');
    fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Resources'), { recursive: true });
    if (bin) fs.writeFileSync(path.join(app, 'MacOS', 'DSHNotch'), 'x');
    if (zstd) fs.writeFileSync(path.join(app, 'Resources', 'zstdlite'), 'x');
  };

  const good = path.join(TMP, 'good'); mk(good);
  const s1 = appInstallState(good, fs, path);
  check('完整的包判为可用', s1.ok === true, JSON.stringify(s1));

  // 这一条是真实事故的回归测试：早期 .app 在，但 zstdlite 路径错位，
  // 结果「装上了却读不到任何会话」
  const noZstd = path.join(TMP, 'nozstd'); mk(noZstd, { zstd: false });
  const s2 = appInstallState(noZstd, fs, path);
  check('缺 zstdlite 判为不可用', s2.ok === false && s2.hasApp === true, JSON.stringify(s2));

  const noBin = path.join(TMP, 'nobin'); mk(noBin, { bin: false });
  const s3 = appInstallState(noBin, fs, path);
  check('缺主程序判为不可用', s3.ok === false, JSON.stringify(s3));

  const none = path.join(TMP, 'none');
  const s4 = appInstallState(none, fs, path);
  check('没装时判为未安装（而不是抛错）', s4.ok === false && s4.hasApp === false, JSON.stringify(s4));

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ===========================================================================
console.log('\n=== T8: apply 不炸且能起桥（模拟 Cordis） ===');
// ===========================================================================
{
  const opened = [];   // 三次 apply 都会起桥，跑完必须全关，否则事件循环吊着不退出
  const registered = [];
  const fakeCtx = {
    settings: { register: (ns, schema, opts) => { registered.push([ns, !!schema, !!opts]); return { get: () => ({}) }; } },
  };
  let threw = null;
  try { mod.apply(fakeCtx, {}); } catch (e) { threw = e; }
  check('apply 不抛错（宿主启动不能被插件带崩）', threw === null, threw && String(threw.message));
  check('apply 注册了 dsh-vibe-island 命名空间', registered.some(r => r[0] === 'dsh-vibe-island'), JSON.stringify(registered));
  check('apply 把桥挂到 ctx 上（可调试/可自测）', !!fakeCtx.vibeIsland);

  // settings.register 抛错（重复注册）时必须降级而不是崩
  const badCtx = { settings: { register: () => { throw new Error('duplicate namespace'); } } };
  let threw2 = null;
  try { mod.apply(badCtx, {}); } catch (e) { threw2 = e; }
  check('settings 抛错时 apply 仍不抛错', threw2 === null, threw2 && String(threw2.message));

  // 连 settings 服务都没有（老宿主）也不能崩
  const bareCtx = {};
  let threw3 = null;
  try { mod.apply(bareCtx, {}); } catch (e) { threw3 = e; }
  check('没有 settings 服务时 apply 仍不抛错', threw3 === null, threw3 && String(threw3.message));

  for (const c of [fakeCtx, badCtx, bareCtx]) {
    if (c.vibeIsland && c.vibeIsland.bridgeReady) opened.push(await c.vibeIsland.bridgeReady);
  }
  const live = opened.filter(Boolean);
  check('apply 起出的桥可用 /health', live.length > 0 && (await getJson(live[0].port, '/health')).body.ok === true, '起了 ' + live.length + ' 个');
  for (const b of live) await b.close();
  check('全部桥已关闭（测试不该吊住事件循环）', true);
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.bridge = { pass, fail };
