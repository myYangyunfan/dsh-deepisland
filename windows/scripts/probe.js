'use strict';
/**
 * 诊断工具：把本机真实 `~/.dsh` 数据喂给监控器，打印它看到的会话与状态。
 *
 * 存在的理由：Windows 端的状态是**由投影推的**（事件流里读不到 `tool/*`），
 * 这个推断到底成不成立，只能拿真数据验。自检用的是人造投影，形状对不代表
 * 真数据对 —— 所以需要这个工具把真话打出来。
 *
 * 用法:
 *   node scripts/probe.js             # 打印一次快照
 *   node scripts/probe.js --watch     # 每 2 秒打印一次（看状态会不会动）
 *   node scripts/probe.js --raw       # 额外打印投影原始字段
 */

const path = require('node:path');
const os = require('node:os');

const SRC = path.join(__dirname, '..', 'src');
const source = require(path.join(SRC, 'session-source.js'));
const projections = require(path.join(SRC, 'projections.js'));
const { SessionMonitor } = require(path.join(SRC, 'monitor.js'));
const bridge = require(path.join(SRC, 'bridge.js'));

const ARGS = process.argv.slice(2);
const WATCH = ARGS.includes('--watch');
const RAW = ARGS.includes('--raw');

function pad(s, n) {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

function dump() {
  const now = Date.now();
  const files = source.sessionFiles();
  console.log('--- ' + new Date(now).toLocaleString() + ' ---');
  console.log('DSH root : ' + source.dshRoot());
  console.log('活跃会话 : ' + files.length + ' 个（活跃窗口 30 分钟，上限 6）');
  console.log('');

  if (files.length === 0) {
    console.log('一个会话都没发现。检查 ~/.dsh/sessions 是否存在。');
    return;
  }

  const m = new SessionMonitor({ verbose: false });
  // 连跑 5 拍，让「上一轮主会话」稳定下来（第一拍 primaryId 还是 null）
  let entries = [];
  for (let i = 0; i < 5; i += 1) entries = m.poll(now, i);

  console.log(pad('状态', 10) + pad('标题', 26) + pad('标签', 14) + pad('上下文', 8)
    + pad('待办', 7) + pad('输出', 10) + '轮次');
  console.log('-'.repeat(80));
  for (const e of entries) {
    console.log(pad(e.status, 10) + pad(e.label.slice(0, 14), 26) + pad(e.tag, 14)
      + pad(e.contextText || '-', 8) + pad(e.todoText || '-', 7)
      + pad(e.outputText || '-', 10) + (e.turnStepText || '-'));
  }

  if (RAW) {
    console.log('\n--- 投影原始字段（判断「在不在跑」的依据）---');
    for (const f of files) {
      const url = projections.projectionURL(f.file);
      const p = projections.load(f.file);
      console.log('\n' + f.id);
      console.log('  投影文件 : ' + (url || '(无)'));
      if (!p) { console.log('  读不到投影'); continue; }
      console.log('  seq        : ' + p.seq);
      console.log('  hasOpenStep: ' + p.hasOpenStep);
      console.log('  pending    : ' + p.pendingCallIds.length + (p.pendingCallIds.length ? ' (' + p.pendingCallIds.join(', ') + ')' : ''));
      console.log('  planActive : ' + p.planActive);
      console.log('  title      : ' + JSON.stringify(p.title));
      console.log('  contextUsed: ' + p.contextUsed + ' / ' + p.contextWindow);
      console.log('  file mtime : ' + new Date(f.mtimeMs).toLocaleString()
        + '（' + Math.round((now - f.mtimeMs) / 1000) + ' 秒前）');
    }
  }

  bridge.health().then((h) => {
    console.log('\n跳转桥: ' + (h.ok ? '已连上 (127.0.0.1:' + h.port + ', ' + h.plugin + ')' : '未连上（端口 ' + h.port + '）'));
  }).catch(() => {
    console.log('\n跳转桥: 探测失败');
  });
}

dump();
if (WATCH) {
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    source.invalidate();
    projections.invalidate();
    console.log('');
    dump();
    if (n >= 30) { clearInterval(timer); }
  }, 2000);
}
