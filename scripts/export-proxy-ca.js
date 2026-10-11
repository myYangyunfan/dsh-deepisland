/**
 * 从本机 MITM 代理的 TLS 握手里，把整条证书链导出成 PEM。
 *
 * ## 为什么需要它
 *
 * 这台机器开着 Steam++（Steamcommunity302）代理，它做HTTPS 中间人。
 * Node 只认自己内置的 Mozilla CA 包，于是所有经代理的 https 请求都报
 * `unable to get local issuer certificate` —— 已实测影响三处：
 *   1. 插件自动下载 app（诊断日志：install: error — 查不到最新版本）
 *   2. electron-builder 打包（要联网下 Electron 运行时）
 *   3. 插件读系统证书库（certutil 被沙箱拦，退回 0 张）
 *
 * 导出链上的证书设成 `NODE_EXTRA_CA_CERTS` 就能解决。
 * **这不是关闭校验** —— 证书链照常严格验证，只是信任源多一份。
 *
 * ## 用法
 *
 *   node export-proxy-ca.js <输出pem路径> [探针主机]
 *
 * 要用**明文 CONNECT 隧道**再套 TLS：直接 tls.connect 到代理端口会失败，
 * 因为代理等的是 CONNECT 请求，不是 TLS ClientHello。
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import crypto from 'node:crypto';

const OUT = process.argv[2] || 'proxy-ca.pem';
const PROXY_HOST = process.env.HTTPS_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = Number(String(process.env.HTTPS_PROXY || '').split(':').pop()) || 59029;
// 探针主机：不同站点代理给的链长度不同（实测 github=2、baidu=3），
// 链里可能带根，所以要多探几个站点把根凑出来。
const PROBE_HOST = process.argv[3] || 'github.com';

const pemOf = (x) =>
  '-----BEGIN CERTIFICATE-----\n' +
  String(x.raw.toString('base64')).match(/.{1,64}/g).join('\n') +
  '\n-----END CERTIFICATE-----\n';

function fetchChain() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PROXY_PORT, PROXY_HOST);
    let buf = '';
    const onData = (d) => {
      buf += d.toString('binary');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      sock.removeListener('data', onData);
      const status = buf.slice(0, buf.indexOf('\r\n')).split(' ')[1];
      if (status !== '200') return reject(new Error('代理 CONNECT 返回 ' + status));
      const rest = buf.slice(i + 4);
      if (rest && rest.length) sock.unshift(Buffer.from(rest, 'binary'));

      const t = tls.connect({ socket: sock, rejectUnauthorized: false, servername: PROBE_HOST });
      t.once('secureConnect', () => {
        // true = 要完整链（含 issuerCertificate 字段）
        const chain = [];
        let cur = t.getPeerCertificate(true);
        while (cur && cur.raw) {
          chain.push(cur);
          cur = cur.issuerCertificate;
        }
        t.end();
        resolve(chain);
      });
      t.once('error', reject);
    };
    sock.on('connect', () =>
      sock.write(`CONNECT ${PROBE_HOST}:443 HTTP/1.1\r\nHost: ${PROBE_HOST}:443\r\n\r\n`)
    );
    sock.on('data', onData);
    sock.on('error', reject);
    setTimeout(() => reject(new Error('超时')), 15000);
  });
}

(async () => {
  const chain = await fetchChain();
  console.log('链上证书数：' + chain.length);
  for (const [i, c] of chain.entries()) {
    const x = new crypto.X509Certificate(c.raw);
    const subj = String(x.subject || '(无subject)').split('\n').map((v) => v.trim()).filter(Boolean).join(', ');
    console.log(`  [${i}] ${subj} | CA=${x.ca}`);
  }
  fs.writeFileSync(OUT, chain.map(pemOf).join('\n'));
  console.log('已写出：' + OUT);
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});