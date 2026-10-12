import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const caPaths = [
  'C:/ProgramData/Steamcommunity_302/caddy-storage/pki/authorities/local/root.crt',
  'C:/Users/delinger/AppData/Roaming/DSHNotch/ca/steamcommunity302-root.pem'
];
const cas = caPaths.filter(p => fs.existsSync(p)).map(p => fs.readFileSync(p, 'utf8'));
const agent = new https.Agent({ ca: [...(https.globalAgent.options.ca || []), ...cas] });

const RELEASE_REPO = 'myYangyunfan/dsh-deepisland';

function get(url, followRedirects = true) {
  return new Promise((resolve, reject) => {
    https.get(url, { agent, headers: { 'User-Agent': 'dsh-vibe-island/1.2.0' } }, (res) => {
      const code = res.statusCode || 0;
      const loc = res.headers.location;
      if (code >= 300 && code < 400 && loc) {
        res.resume();
        if (!followRedirects) return resolve({ status: code, headers: res.headers, body: Buffer.alloc(0) });
        return get(loc).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: code, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// 1. 解析最新版本号
const url = 'https://github.com/' + RELEASE_REPO + '/releases/latest';
const r = await get(url, false);
if (r.status < 300 || r.status >= 400) {
  console.log('❌ releases/latest 返回', r.status);
  process.exit(1);
}
const loc = String(r.headers.location || '');
const m = loc.match(/\/releases\/tag\/v?([0-9][^\s/]*)/);
const ver = m[1];
console.log('1. 解析到的最新版本:', ver);

// 2. 取 SHA256SUMS.txt
const base = 'https://github.com/' + RELEASE_REPO + '/releases/download/v' + ver + '/';
const s = await get(base + 'SHA256SUMS.txt');
console.log('2. SHA256SUMS.txt HTTP:', s.status);
if (s.status !== 200) process.exit(1);
const text = s.body.toString('utf8');
console.log('   内容:\n' + text.split('\n').filter(Boolean).map(l => '     ' + l).join('\n'));

// 3. 按插件口径找 win-x64.zip 的摘要
const asset = 'DSHNotch-' + ver + '-win-x64.zip';
function parseSums(sumsText, filename) {
  for (const raw of String(sumsText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const mm = line.match(/^([0-9a-fA-F]{64})\s+[* ]?(.+)$/);
    if (mm && mm[2].trim() === filename) return mm[1].toLowerCase();
  }
  return null;
}
const expect = parseSums(text, asset);
console.log('3. 期望资产:', asset);
console.log('   取到摘要:', expect || '(未找到)');

if (!expect) { console.log('❌ 校验文件里没有该资产'); process.exit(1); }

// 4. 真下载 zip 并核哈希
console.log('4. 开始下载 zip ...');
const z = await get(base + asset);
console.log('   zip HTTP:', z.status, '字节数:', z.body.length);
const crypto = await import('node:crypto');
const got = crypto.createHash('sha256').update(z.body).digest('hex');
console.log('   实际摘要:', got);
console.log(got === expect ? '✅ 哈希一致 —— 插件这条安装链路现在是通的' : '❌ 哈希不一致');
