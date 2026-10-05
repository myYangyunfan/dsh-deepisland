// Windows 侧自检跑器。
//
// 这些套件**不依赖 Electron**：全部是纯 Node 模块（读文件 + 解析），
// 所以在 macOS 上就能跑 —— 而这是刻意的：
// Windows 版的 UI 层在这台机器上跑不了，但**数据层可以且应该跑**。
// 数据层错了，UI 做得再漂亮也是错的。
//
// 用法: node test/run.js
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUITES = [
  'session-source.test.js',
  'projections.test.js',
];

let totalPass = 0, totalFail = 0;
const failed = [];

for (const s of SUITES) {
  console.log('\n' + '#'.repeat(52));
  console.log('# ' + s);
  console.log('#'.repeat(52));
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  // 套件自己打印「通过 N / 失败 M」，从 stdout 里取出来累加
  const m = /通过 (\d+) \/ 失败 (\d+)/.exec(r.stdout || '');
  if (m) { totalPass += Number(m[1]); totalFail += Number(m[2]); }
  if (r.status !== 0) failed.push(s);
}

console.log('\n' + '='.repeat(52));
console.log('总计: 通过 ' + totalPass + ' / 失败 ' + totalFail);
if (failed.length) {
  console.log('失败套件: ' + failed.join(', '));
}
console.log('='.repeat(52));
process.exit(totalFail === 0 ? 0 : 1);
