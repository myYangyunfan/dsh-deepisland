'use strict';
/**
 * 端到端跳转验证 —— 真 HTTP、真桥、真端口文件。
 *
 * ## 为什么单独一个套件
 *
 * 之前 jump.test.js 只验了 `performJump` 的**分支选择**（注入假 activate/copy/post），
 * 于是「投桥」这一段一直是绿的，但真跑起来会挂。以下三件事它一件都测不到：
 *
 *   1. `bridge.json` 写在 `%APPDATA%\DSHNotch\`（Windows），不是 mac 的
 *      `~/Library/Application Support/` —— 路径错了读不到端口，静默退回 47311；
 *   2. 端口顺延后 app 侧必须读到**真实**端口，不是写死的 47311；
 *   3. 桥的 200 会被邻近端口上的别的服务骗过去（所以必须核对 `plugin` 字段）。
 *
 * 这三件事的共同点：**错了不抛异常，只是「点击没反应」**。
 *
 * ## 跑法
 *
 *   node test/e2e-jump.test.js
 *
 * 会自己起一个真桥（端口从 47800 起顺延，避开默认的 47311），
 * 验完关掉。**不碰用户的真实 bridge.json** —— 起桥会覆盖它，
 * 所以本测试用 BRIDGE_PORT_OVERRIDE 指到临时目录，跑完还原。
 * 若机器上有正在跑的 DSH + 插件（桥在 47311），本测试**不会**干扰它。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// __dirname = windows/test → 上两级是 windows/，再上一级才是仓库根
const REPO = path.resolve(__dirname, '..', '..');
const APP = path.resolve(__dirname, '..');          // windows/
const ROOT = REPO;                                 // 仓库根（插件 lib/ 在这）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-e2e-'));

// 真实配置目录（要验的就是 app 与插件是否指向同一处）
const REAL_CFG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'DSHNotch');
const REAL_BRIDGE = path.join(REAL_CFG_DIR, 'bridge.json');

let bridgeProc = null;
let backupBridge = null;
let usedPort = 0;

function httpJson(opts, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { done({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { done({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', (e) => done({ status: 0, json: null, error: e.message }));
    req.setTimeout(3000, () => { req.destroy(); done({ status: 0, json: null, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  section('E1: 桥的落盘位置与 app 侧读的位置必须一致');
  {
    const config = require(path.join(APP, 'src', 'config.js'));
    const bridge = require(path.join(APP, 'src', 'bridge.js'));
    check('app 的配置目录是 %APPDATA%\\DSHNotch',
      config.appDataDir() === REAL_CFG_DIR,
      config.appDataDir() + ' ≠ ' + REAL_CFG_DIR);
    check('app 的 bridge.json 路径由配置目录推出（不是硬编码 mac 路径）',
      bridge.bridgeFilePath() === REAL_BRIDGE, bridge.bridgeFilePath());
    check('路径里不含 Library/Application Support（mac 专属）',
      !bridge.bridgeFilePath().includes('Library'));
    check('兜底端口是 47311（与插件服务端 BRIDGE_PORT 一致）',
      bridge.FALLBACK_PORT === 47311, String(bridge.FALLBACK_PORT));
  }

  section('E2: 起一个真桥（真 HTTP，不是桩）');
  {
    // 先备份真实 bridge.json —— 起桥会覆盖它
    if (fs.existsSync(REAL_BRIDGE)) {
      backupBridge = fs.readFileSync(REAL_BRIDGE);
      console.log('     （已备份真实 bridge.json，跑完还原）');
    }
    const script = path.join(TMP, 'bridge.mjs');
    // 用 __LIB__ 这种不可能出现在路径里的占位符。
    // 之前用 'REPLACE' 做占位符，结果这行 .replace('REPLACE', ...)
    // 会先命中**模板里自己那行注释**，把路径拼到一半就断了 ——
    // 换句话说：占位符字符串不能是它自己所在这行的子串。
    fs.writeFileSync(script, `
import { startBridge } from 'file:///__LIB__/lib/index.js';
const srv = await startBridge({ port: 47800, log: () => {} });
if (!srv) { console.log('BRIDGE_FAIL'); process.exit(1); }
console.log('BRIDGE_OK ' + srv.port);
setInterval(() => {}, 1 << 30);
`.replace('__LIB__', ROOT.replace(/\\/g, '/')));

    // 先确认 47800~47811 都没被占
    let free = -1;
    for (let i = 0; i < 12; i += 1) {
      const p = 47800 + i;
      const ok = await new Promise((res) => {
        const r = http.get({ host: '127.0.0.1', port: p, path: '/health', timeout: 600 }, (x) => { x.resume(); res(false); });
        r.on('error', () => res(true));
        r.on('timeout', () => { r.destroy(); res(false); });
        r.end();
      });
      if (ok) { free = p; break; }
    }
    check('47800~47811 有可用端口', free > 0, '全被占');
    if (free < 0) { finish(); return; }

    bridgeProc = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    bridgeProc.stdout.on('data', (d) => { out += d.toString(); });
    bridgeProc.stderr.on('data', (d) => { out += d.toString(); });
    for (let i = 0; i < 60 && !out.includes('BRIDGE_OK'); i += 1) await sleep(100);
    check('桥启动成功（真 HTTP server）', out.includes('BRIDGE_OK'), out.slice(-200));
    if (!out.includes('BRIDGE_OK')) { finish(); return; }
    usedPort = Number(out.match(/BRIDGE_OK (\d+)/)[1]);
    console.log('     桥端口 = ' + usedPort);

    // 真的能应答 HTTP
    const h = await httpJson({ host: '127.0.0.1', port: usedPort, path: '/health', method: 'GET' });
    check('/health 应答 200', h.status === 200, String(h.status));
    check('/health 自报 plugin 名（app 靠它确认没认错服务）',
      h.json && String(h.json.plugin || '').includes('dsh-vibe-island'),
      JSON.stringify(h.json && h.json.plugin));
  }

  section('E3: app 侧发现端口（顺延后的真端口，不是 47311）');
  let bridgeMod;
  {
    bridgeMod = require(path.join(APP, 'src', 'bridge.js'));
    bridgeMod.invalidatePort();
    const p = bridgeMod.bridgePort();
    check('bridgePort() 读到的是真实端口', p === usedPort, p + ' ≠ ' + usedPort);
    check('确实不是写死的 47311（否则顺延逻辑形同虚设）',
      usedPort !== 47311, String(usedPort));

    const h = await bridgeMod.health();
    check('app 侧 health 探到桥', h.ok === true, JSON.stringify(h));
    check('health 里带回插件名（47311 附近可能有别的服务）',
      typeof h.plugin === 'string' && h.plugin.includes('dsh-vibe-island'), String(h.plugin));
  }

  section('E4: 完整跳转链路（app 投桥 → 桥入队 → 客户端取走 → openSession）');
  {
    const { performJump } = require(path.join(APP, 'src', 'jump.js'));
    const SID = 'session-e567c20e-078b-4605-8031-17f796426cff';
    const TITLE = 'Project Initialization';
    const entry = { id: SID, label: TITLE };

    let copied = false;
    const r = await performJump(entry, {
      activate: async () => true,
      copy: () => { copied = true; return true; },
    });
    check('判定为 bridged（不是降级）', r.kind === 'bridged' && r.usedBridge === true, JSON.stringify(r));
    check('降级路径没被走（没写剪贴板）', copied === false, '剪贴板被写了');
    check('带上了 sessionId', r.sessionId === SID, r.sessionId);

    // 桥里确实排上了
    const h = await bridgeMod.health();
    check('桥队列 pending=1', h.pending === 1, 'pending=' + h.pending);

    // 复刻 lib/client.js 的轮询：GET /next
    const got = await httpJson({ host: '127.0.0.1', port: bridgeMod.bridgePort(), path: '/next', method: 'GET' });
    check('/next 应答 200', got.status === 200, String(got.status));
    check('取到 1 条', got.json && Array.isArray(got.json.items) && got.json.items.length === 1,
      JSON.stringify(got.json && got.json.items));
    const it = got.json.items[0];
    check('sessionId 完整传递（没被截断/变形）', it.sessionId === SID, it.sessionId);
    check('title 一并带过去', it.title === TITLE, it.title);

    // 最后一跳：openSession
    const opened = [];
    const ws = { openSession: (sid) => { opened.push(sid); return true; } };
    for (const x of got.json.items) ws.openSession(x.sessionId);
    check('openSession 收到了正确的 sessionId', opened[0] === SID, JSON.stringify(opened));

    // 取走后必须清队（否则下次开 DSH 会把用户劫持到旧会话）
    const h2 = await bridgeMod.health();
    check('取走后 pending 归零（不会劫持到旧会话）', h2.pending === 0, 'pending=' + h2.pending);
  }

  section('E5: 桥不在时必须优雅降级（不是崩）');
  {
    // 指向一个肯定没人监听的端口
    bridgeMod.invalidatePort();
    const r = await new Promise((res) => {
      const req = http.request({ host: '127.0.0.1', port: 49999, path: '/jump', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
        (x) => { x.resume(); res(x.statusCode); });
      req.on('error', () => res(0));
      req.setTimeout(800, () => { req.destroy(); res(0); });
      req.write('{}'); req.end();
    });
    check('连不上时返回 falsy 而不是抛异常', !r, 'status=' + r);

    const { performJump } = require(path.join(APP, 'src', 'jump.js'));
    const out = await performJump({ id: 'x', label: 'T' }, {
      activate: async () => false,
      copy: () => true,
      post: async () => false,
    });
    check('桥断时走 copied 降级', out.kind === 'copied' && out.isSuccess === true, JSON.stringify(out));
    check('降级提示里带 Ctrl+K（用户知道下一步做什么）',
      /Ctrl\+K/.test(out.brief), out.brief);

    const out2 = await performJump({ id: 'x', label: 'T' }, {
      activate: async () => false, copy: () => false, post: async () => false,
    });
    check('置前与复制都失败时如实报 failed', out2.kind === 'failed' && out2.isSuccess === false,
      JSON.stringify(out2));
  }

  finish();
})().catch((e) => {
  console.error('[e2e] 套件自身抛错：', e && (e.stack || e.message));
  fail += 1;
  finish();
});

function finish() {
  section('清理');
  if (bridgeProc) {
    try { bridgeProc.kill(); } catch { /* 已退出 */ }
    bridgeProc = null;
    console.log('  ✅ 桥已关掉');
  }
  // 还原真实 bridge.json
  try {
    if (backupBridge) { fs.writeFileSync(REAL_BRIDGE, backupBridge); console.log('  ✅ 已还原真实 bridge.json'); }
    else if (fs.existsSync(REAL_BRIDGE)) { fs.unlinkSync(REAL_BRIDGE); console.log('  ✅ 已移除测试留下的 bridge.json'); }
  } catch (e) { console.log('  ⚠️  还原 bridge.json 失败：' + e.message); }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n' + '='.repeat(44));
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  console.log('='.repeat(44));
  process.exitCode = fail > 0 ? 1 : 0;
}