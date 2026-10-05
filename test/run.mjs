// 测试入口: node test/run.mjs [parse|apply|bridge|bridgeclient|perf|degradation|all]
// 依赖: 无（纯 Node 内置模块 + 读取 lib/client.js 源码）
// 退出码: 0 = 全部通过（有断言的套件统计 pass/fail；perf/degradation 为诊断脚本，仅打印数据）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] || 'all';

// 用宿主自带的 Node（runtime/bin/node，Electron 二进制 ELECTRON_RUN_AS_NODE）跑本套件时，
// Electron 的 asar fs 包装器会把 `readFileSync(app.asar)` 当成读目录，报
// "ENOENT, not found in app.asar"，test-contract 的 H2 节会整轮红掉。
// ELECTRON_NO_ASAR=1 是 Electron 官方开关，关掉这层包装。
if (process.env.ELECTRON_NO_ASAR === undefined) {
  process.env.ELECTRON_NO_ASAR = '1';
}

const SUITES = {
  contract: 'test-contract.mjs',
  parse: 'test-parse.mjs',
  apply: 'test-apply.mjs',
  subagent: 'test-subagent.mjs',
  mount: 'test-mount.mjs',
  bridge: 'test-bridge.mjs',
  bridgeclient: 'test-bridge-client.mjs',
  installdl: 'test-install-dl.mjs',
  perf: 'perf.mjs',
  degradation: 'degradation.mjs',
};

// 需要联网、耗时 30s 上下，不进默认 all —— 想跑显式点名：
//   node test/run.mjs installdl
const NETWORK_SUITES = ['installdl'];

const list = which === 'all' ? Object.keys(SUITES).filter((k) => !NETWORK_SUITES.includes(k)) : [which];

// harness 先跑：执行 client.js 并把 factory 产物挂到 globalThis.__mod
// test-apply 自带独立 harness（不依赖 __mod），其余套件都需要
if (list.some(k => !['apply', 'bridge'].includes(k))) {
  await import(path.join(__dirname, 'harness.mjs'));
}

for (const key of list) {
  const file = SUITES[key];
  if (!file) { console.error('未知测试: ' + key + '  可用: ' + Object.keys(SUITES).join(', ') + ', all'); process.exit(1); }
  console.log('\n' + '#'.repeat(50));
  console.log('# 套件: ' + key + '  (' + file + ')');
  console.log('#'.repeat(50));
  await import(path.join(__dirname, file));
}

const r = globalThis.__results || {};
const keys = Object.keys(r);
if (keys.length) {
  const tp = keys.reduce((s, k) => s + r[k].pass, 0);
  const tf = keys.reduce((s, k) => s + r[k].fail, 0);
  console.log('\n' + '='.repeat(46));
  console.log('总计: 通过 ' + tp + ' / 失败 ' + tf);
  console.log('='.repeat(46));
  process.exit(tf > 0 ? 1 : 0);
}
