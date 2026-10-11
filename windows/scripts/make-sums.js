// 给 dist/ 里的 zip 与 exe 算 SHA256，写成 SHA256SUMS.txt。
//
// 格式必须是 `<64位hex>  两个空格  <文件名>`：插件的 parseSums() 只认这一种
// 形状（它在 release 的 SHA256SUMS.txt 里按文件名找摘要），差一个空格就装不上。
// 用 node 算而不是 shasum/certutil：三个平台的命令行工具输出格式都不一样，
// 只有统一在这里写，才不会出现「本机生成的 mac 侧能对上、CI 生成的对不上」。
//
// 用法: node scripts/make-sums.js           → dist/SHA256SUMS.txt
//       node scripts/make-sums.js --stdout  → 只打印（供 CI 拼接）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dist = path.resolve(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
  console.error('没有 dist/ —— 先跑 npm run dist');
  process.exit(1);
}

const files = fs.readdirSync(dist)
  .filter((n) => /\.(zip|exe)$/i.test(n) && !n.includes('__uninstaller'))
  .sort();

if (!files.length) {
  console.error('dist/ 里没有 zip 或 exe');
  process.exit(1);
}

const lines = files.map((n) => {
  const buf = fs.readFileSync(path.join(dist, n));
  const hex = crypto.createHash('sha256').update(buf).digest('hex');
  return hex + '  ' + n;
});

const out = lines.join('\n') + '\n';

if (process.argv.includes('--stdout')) {
  process.stdout.write(out);
} else {
  fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), out);
  console.log('已写 dist/SHA256SUMS.txt');
  process.stdout.write(out);
}
