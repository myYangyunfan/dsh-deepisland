'use strict';
/**
 * 本机跳转桥 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/SessionJump.swift` 的桥那半边。
 *
 * ## 桥是怎么来的
 *
 * 本 app 进不去 DSH（对外只注册了 `dsh://open` 一条深链），但**插件的渲染
 * 进程可以**打开会话。于是插件的服务端半边在 `127.0.0.1` 上起了个 HTTP 服务
 * （`lib/index.js`），并把实际端口写进 `bridge.json`。这里读那个文件拿到端口，
 * `POST /jump` 把 sessionId 递过去，插件客户端轮询到后执行跳转。
 *
 * 桥不存在通常是：没装插件 / DSH 没开 / 插件版本旧。全部走降级（复制标题），
 * 功能不受影响 —— 所以桥是纯增强。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const config = require('./config.js');

/** 兜底端口：插件服务端默认 47311，被占时顺延，文件里才有真值。 */
const FALLBACK_PORT = 47311;

/** 超时给得很短 —— 本机回环正常是毫秒级，超过就说明桥不在，等下去没意义。 */
const DEFAULT_TIMEOUT_MS = 1200;

/** `bridge.json` 的路径：与插件服务端写在同处。 */
function bridgeFilePath() {
  return path.join(config.appDataDir(), 'bridge.json');
}

let portCache = null;
let portStamp = '';

/**
 * 从端口文件里读桥的端口。
 *
 * 读不到就用兜底端口 —— 服务端在 47311 上起桥时本来就不写文件也照样能用，
 * 所以「文件不存在」不等于「桥不在」，别在这里就放弃。
 */
function bridgePort() {
  const file = bridgeFilePath();
  let stamp = '';
  try {
    const st = fs.statSync(file);
    stamp = Math.floor(st.mtimeMs) + '-' + st.size;
  } catch {
    stamp = '';
  }
  if (portCache !== null && stamp === portStamp) return portCache;

  let port = FALLBACK_PORT;
  if (stamp !== '') {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (obj && typeof obj.port === 'number' && obj.port > 1023 && obj.port < 65536) {
        port = obj.port;
      }
    } catch { /* 文件被写坏 → 用兜底端口 */ }
  }
  portCache = port;
  portStamp = stamp;
  return port;
}

/** 清空端口缓存（自检用）。 */
function invalidatePort() {
  portCache = null;
  portStamp = '';
}

/**
 * 把跳转请求投给插件的桥。
 *
 * @param {string} sessionId
 * @param {string} title
 * @param {{ timeoutMs?: number, httpImpl?: any }} opts
 * @returns {Promise<boolean>} 投递成功 true；桥没起/拒绝/超时 false
 */
function postJump(sessionId, title, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const H = opts.httpImpl || http;
  const port = bridgePort();
  const body = JSON.stringify({ sessionId, title });

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = H.request({
        host: '127.0.0.1',
        port,
        path: '/jump',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
        res.on('end', () => {
          if (res.statusCode !== 200) return done(false);
          try {
            const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            // 核对插件名：47311 附近可能有别的服务，别把别人的 200 当成桥
            const plugin = obj && typeof obj.plugin === 'string' ? obj.plugin : '';
            const ok = !!(obj && obj.ok === true);
            return done(ok && plugin.includes('dsh-vibe-island'));
          } catch {
            return done(false);
          }
        });
      });
    } catch {
      return done(false);
    }

    req.on('error', () => done(false));
    req.on('timeout', () => { try { req.destroy(); } catch { /* 已销毁 */ } done(false); });
    req.write(body);
    req.end();
  });
}

/**
 * 探一下桥在不在（`GET /health`）。给 UI 显示「桥已连上 / 未连上」用。
 *
 * ⚠️ 必须透传 `pending`（服务端 /health 里带的待处理跳转条数），
 * 以前这里只挑了 ok / port / plugin，把其余字段全丢了。
 * 后果不只是「少一个字段」：**没法区分「桥健康但没人用」和
 * 「桥健康且队列里压着跳转请求」** —— 后者意味着用户点了岛、
 * 但 DSH 那边没消费，界面却和「一切正常」长得一模一样。
 * 排查这种问题时，pending 是唯一的线索。
 *
 * @returns {Promise<{ok: boolean, port: number, plugin?: string, pending?: number, version?: string}>}
 */
function health(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const H = opts.httpImpl || http;
  const port = bridgePort();
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = H.request({
        host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
        res.on('end', () => {
          if (res.statusCode !== 200) return done({ ok: false, port });
          try {
            const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            return done({
              ok: !!(obj && obj.ok === true),
              port,
              plugin: obj && obj.plugin,
              // 透传这几个：pending 是唯一能看出「点了但没生效」的字段
              pending: obj && typeof obj.pending === 'number' ? obj.pending : undefined,
              version: obj && obj.version,
            });
          } catch {
            return done({ ok: false, port });
          }
        });
      });
    } catch {
      return done({ ok: false, port });
    }
    req.on('error', () => done({ ok: false, port }));
    req.on('timeout', () => { try { req.destroy(); } catch { /* noop */ } done({ ok: false, port }); });
    req.end();
  });
}

module.exports = {
  FALLBACK_PORT,
  DEFAULT_TIMEOUT_MS,
  bridgeFilePath,
  bridgePort,
  invalidatePort,
  postJump,
  health,
};
