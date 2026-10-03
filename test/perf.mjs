// 游标缓存命中验证（修复后）
// 修复前：cursorMap 以 events 数组引用为 WeakMap key，而 client.js 用 setEvents([...evs])
//         每 250ms 生成新数组引用 → 缓存 100% miss → 每轮全量重扫。
// 修复后：游标按 sessionKey（会话 id）索引，数组副本不再影响命中。
const parse = globalThis.__mod.parseActivityFromEvents;

const N = 5000;
const store = [];
for (let i = 0; i < N; i++) store.push({ type: 'thinking', data: { text: 'evt' + i } });

console.log('\n=== 场景1: 同一数组 + 同一 sessionKey（基线）===');
let t0 = performance.now();
parse(store, 'k1');
let t1 = performance.now();
parse(store, 'k1');
let t2 = performance.now();
console.log('  第一次: ' + (t1 - t0).toFixed(3) + 'ms  (全量)');
console.log('  第二次: ' + (t2 - t1).toFixed(5) + 'ms  ← 增量');
console.log('  提速: ' + ((t1 - t0) / Math.max(t2 - t1, 0.00001)).toFixed(0) + 'x');

console.log('\n=== 场景2: 每次新数组副本 + 同一 sessionKey（复刻 setEvents([...evs])）===');
t0 = performance.now();
parse([...store], 'k2');            // 建立游标
t1 = performance.now();
for (let i = 0; i < 20; i++) parse([...store], 'k2');
t2 = performance.now();
const perRoundHit = (t2 - t1) / 20;
console.log('  20 轮 × 5000 事件副本，平均每轮: ' + perRoundHit.toFixed(5) + 'ms');
console.log('  轮询周期 250ms → 占用 ' + ((perRoundHit / 250) * 100).toFixed(4) + '% 主线程');
console.log('  说明: 稳态含 setEvents 数组复制开销，故与 miss 对照组比较见下方判定');

console.log('\n=== 场景3: 对照 —— 每次换 sessionKey（缓存必然 miss）===');
t0 = performance.now();
for (let i = 0; i < 20; i++) parse([...store], 'miss-' + i);
t1 = performance.now();
const perRoundMiss = (t1 - t0) / 20;
console.log('  20 轮 × 5000 事件，平均每轮: ' + perRoundMiss.toFixed(3) + 'ms');
console.log('  轮询周期 250ms → 占用 ' + ((perRoundMiss / 250) * 100).toFixed(2) + '% 主线程');

console.log('\n=== 场景4: 增量追加（会话进行中，事件持续增长）===');
const live = [];
const key = 'growing';
t0 = performance.now();
for (let round = 0; round < 40; round++) {
  for (let k = 0; k < 100; k++) live.push({ type: 'tool/call', data: { name: 'bash', args: { command: 'c' + k } } });
  parse([...live], key);
}
t1 = performance.now();
const r4 = (t1 - t0) / 40;
console.log('  会话增长到 ' + live.length + ' 事件，平均每轮: ' + r4.toFixed(5) + 'ms');
console.log('  轮询周期 250ms → 占用 ' + ((r4 / 250) * 100).toFixed(4) + '% 主线程');
console.log('  说明: 每轮仅处理新增 100 条事件，复制成本随历史线性增长属预期');

console.log('\n=== 结论 ===');
console.log('  副本 + 同 key（修复后真实路径）: ' + perRoundHit.toFixed(5) + 'ms/轮');
console.log('  换 key（缓存 miss 对照）:      ' + perRoundMiss.toFixed(3) + 'ms/轮');
console.log('  命中 vs miss 差距: ' + (perRoundMiss / Math.max(perRoundHit, 0.00001)).toFixed(0) + 'x');
console.log('  说明: 残余的每轮微小开销来自 setEvents 的数组复制（React 状态更新固有成本），');
console.log('        解析本身为 O(1)——见 degradation 套件 E 组的分离测量。');

console.log('\n=== 判定 ===\n');
// 判定标准：稳态（含数组复制）应显著快于缓存 miss 的全量重扫。
// 绝对值受 setEvents 数组复制影响，故用倍数关系而非固定阈值。
const hitVsMiss = perRoundMiss / Math.max(perRoundHit, 0.00001);
const growVsMiss = perRoundMiss / Math.max(r4, 0.00001);
const c1 = perRoundHit < perRoundMiss / 3;
const c2 = r4 < perRoundMiss / 3;
const c3 = hitVsMiss > 3 && growVsMiss > 3;
console.log('  副本+同key vs 换key: ' + hitVsMiss.toFixed(1) + 'x  ' + (c1 ? '✅' : '❌'));
console.log('  增量追加 vs 换key:   ' + growVsMiss.toFixed(1) + 'x  ' + (c2 ? '✅' : '❌'));
console.log('  两项均显著快于全量重扫: ' + (c3 ? '✅' : '❌'));
console.log('  稳态占 250ms 轮询周期: ' + ((perRoundHit / 250) * 100).toFixed(4) + '%（健康）');

globalThis.__results = globalThis.__results || {};
const pass = [c1, c2, c3].filter(Boolean).length;
globalThis.__results.perf = { pass, fail: 3 - pass };
console.log('\n  ' + (pass === 3 ? '✅ 游标修复验证通过' : '❌ 游标修复未生效'));
