// Windows 版本机跳转桥的自检。
//
// 不真起 HTTP 服务 —— 注入一个假的 `http` 实现（`httpImpl`），
// 这样超时、连接失败、非 200、插件名不对这些分支都能稳定复现。
// 真起服务再关端口也能测一部分，但「超时」和「ECONNREFUSED」在 CI 上不可靠。
//
// 用法: node windows/test/bridge.test.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

// 把 appDataDir 隔离到临时目录（config.js 在 win32 上取 %APPDATA%）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-bridge-'));
process.env.APPDATA = TMP;
process.env.USERPROFILE = TMP;

const B = require(path.join(__dirname, '..', 'src', 'bridge.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/** 造一个假的 node:http，行为由 handler 决定。 */
function fakeHttp(handler) {
  return {
    request(opts, cb) {
      const req = new EventEmitter();
      let body = '';
      req.write = (chunk) => { body += chunk; };
      req.end = () => {
        const r = handler(opts, body) || {};
        if (r.error) {
          process.nextTick(() => req.emit('error', new Error(r.error)));
          return;
        }
        if (r.timeout) {
          process.nextTick(() => req.emit('timeout'));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = r.status === undefined ? 200 : r.status;
        process.nextTick(() => {
          cb(res);
          process.nextTick(() => {
            res.emit('data', r.body === undefined ? '' : r.body);
            res.emit('end');
          });
        });
      };
      req.destroy = () => {};
      return req;
    },
  };
}

console.log('=== W1: 端口解析 ===');
const bridgeFile = B.bridgeFilePath();
check('bridge.json 在 appDataDir\\DSHNotch 下',
  bridgeFile.replace(/\\/g, '/').endsWith('/DSHNotch/bridge.json'), bridgeFile);
B.invalidatePort();
check('文件不存在 → 兜底 47311', B.bridgePort() === 47311, String(B.bridgePort()));

fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
fs.writeFileSync(bridgeFile, JSON.stringify({ ok: true, plugin: 'dsh-vibe-island', port: 47315, pid: 123 }));
B.invalidatePort();
check('读到文件里的端口', B.bridgePort() === 47315, String(B.bridgePort()));

fs.writeFileSync(bridgeFile, JSON.stringify({ port: 80 }));
B.invalidatePort();
check('端口 <= 1023 视为无效，退回兜底', B.bridgePort() === 47311, String(B.bridgePort()));

fs.writeFileSync(bridgeFile, JSON.stringify({ port: '47399' }));
B.invalidatePort();
check('字符串端口不算数，退回兜底', B.bridgePort() === 47311, String(B.bridgePort()));

fs.writeFileSync(bridgeFile, '{ 这不是 json');
B.invalidatePort();
check('文件写坏 → 退回兜底（不崩）', B.bridgePort() === 47311, String(B.bridgePort()));

console.log('\n=== W2: POST /jump 的成功判定 ===');
(async () => {
  let seenBody = null;
  let seenOpts = null;
  const okHttp = fakeHttp((opts, body) => {
    seenOpts = opts; seenBody = body;
    return { status: 200, body: JSON.stringify({ ok: true, plugin: 'dsh-vibe-island', queued: 1 }) };
  });

  const r1 = await B.postJump('session-abc', '我的会话', { httpImpl: okHttp });
  check('200 + ok + 插件名对 → true', r1 === true);
  check('请求打到 127.0.0.1', seenOpts && seenOpts.host === '127.0.0.1', seenOpts && seenOpts.host);
  check('路径是 /jump', seenOpts && seenOpts.path === '/jump', seenOpts && seenOpts.path);
  check('方法是 POST', seenOpts && seenOpts.method === 'POST');
  check('body 带 sessionId 与 title', (() => {
    try {
      const j = JSON.parse(seenBody);
      return j.sessionId === 'session-abc' && j.title === '我的会话';
    } catch { return false; }
  })(), String(seenBody));
  check('带 Content-Type: application/json',
    seenOpts && seenOpts.headers && seenOpts.headers['Content-Type'] === 'application/json');

  // 别人占了这个端口：200 但不是我们的桥
  const otherHttp = fakeHttp(() => ({ status: 200, body: JSON.stringify({ ok: true, plugin: 'some-other-app' }) }));
  check('插件名不对 → false（别把别人的 200 当桥）',
    (await B.postJump('a', 'b', { httpImpl: otherHttp })) === false);

  const notOk = fakeHttp(() => ({ status: 200, body: JSON.stringify({ ok: false, plugin: 'dsh-vibe-island' }) }));
  check('ok:false → false', (await B.postJump('a', 'b', { httpImpl: notOk })) === false);

  const http500 = fakeHttp(() => ({ status: 500, body: 'boom' }));
  check('非 200 → false', (await B.postJump('a', 'b', { httpImpl: http500 })) === false);

  const broken = fakeHttp(() => ({ status: 200, body: 'not json' }));
  check('响应不是 JSON → false', (await B.postJump('a', 'b', { httpImpl: broken })) === false);

  const refused = fakeHttp(() => ({ error: 'ECONNREFUSED' }));
  check('连接被拒 → false', (await B.postJump('a', 'b', { httpImpl: refused })) === false);

  const timedOut = fakeHttp(() => ({ timeout: true }));
  check('超时 → false', (await B.postJump('a', 'b', { httpImpl: timedOut })) === false);

  console.log('\n=== W3: GET /health ===');
  const hOk = fakeHttp((opts) => ({ status: 200, body: JSON.stringify({ ok: true, plugin: 'dsh-vibe-island' }) }));
  let h = await B.health({ httpImpl: hOk });
  check('健康时 ok=true', h.ok === true, JSON.stringify(h));
  check('health 带出端口', typeof h.port === 'number' && h.port > 1023, String(h.port));
  check('health 带出插件名', h.plugin === 'dsh-vibe-island', String(h.plugin));

  const hDown = fakeHttp(() => ({ error: 'ECONNREFUSED' }));
  h = await B.health({ httpImpl: hDown });
  check('桥不在时 ok=false 且不抛', h.ok === false && h.port > 0, JSON.stringify(h));

  const h500 = fakeHttp(() => ({ status: 503, body: '' }));
  h = await B.health({ httpImpl: h500 });
  check('非 200 → ok=false', h.ok === false);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 无所谓 */ }
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
