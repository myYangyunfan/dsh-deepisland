// 快照协议 v2（`src/snapshot.js`）的纯函数自检。
//
// 这个文件是主进程 → 渲染进程唯一的数据形状，它的两条纪律**运行时不会报错**：
// - 只要有人把 `activity`/`proj`/`file`/`mtimeMs`/`now` 塞回 DTO，界面照样能画，
//   只是每拍跨进程复制的字节数悄悄涨回去、rev 每拍都变（去重失效）；
// - 只要 `rev` 的稳定序列化退化成 `JSON.stringify`，键顺序一变就误判「内容变了」。
//
// 所以这里按契约 §4/§7 直接把形状、体积、rev、nextDelay 全钉住。
// 断言只依赖 `snapshot.js` 本身（纯 CommonJS、不碰 electron、不读用户数据）。
//
// 用法: node windows/test/snapshot.test.js
const path = require('node:path');

const S = require(path.join(__dirname, '..', 'src', 'snapshot.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const NOW = 1_700_000_000_000;

/**
 * monitor.poll() 会产出的**内部 entry**：运行时字段加上 renderer 真会消费的
 * display 字段。这里刻意带上 v1 的历史字段（activity/proj/file/mtimeMs/project），
 * 用来验证 buildSnapshot 会全部剥掉。
 */
function rawEntries() {
  return [
    {
      id: 'session-a1b2c3d4',
      file: 'C:\\Users\\dev\\.dsh\\sessions\\p\\s\\session.v4.jsonl.zstd',
      project: 'demo-proj',
      mtimeMs: NOW,
      label: 'AlexNet 架构可视化',
      shortId: 'a1b2c3d4',
      status: 'thinking',
      glow: '#4E7CFF',
      tag: 'Thinking',
      badge: 'Thinking',
      elapsedFrom: NOW - 42000,
      elapsedText: '00:42',
      turnStepText: 'T3·S7',
      toolCountText: '2 次',
      outputText: '12.4k tok',
      contextText: '32%',
      contextFraction: 0.32,
      contextLevel: 0,
      todoText: '2/5',
      todoDone: 2,
      todoTotal: 5,
      todoCurrent: '补齐训练曲线渲染',
      subagentText: null,
      pendingTools: 0,
      detailText: '正在分析三通道卷积层的参数量与感受野',
      actionText: '深度思考中...',
      // v1 的历史包袱：整个状态机内部对象 + 投影原样解析结果
      activity: {
        status: 'thinking', title: '深度思考中...', detail: '正在分析三通道卷积层的参数量与感受野',
        turn: 3, step: 7, toolCount: 2, pendingAgents: 0,
        proj: {
          version: 1, title: 'AlexNet 架构可视化', todoTotal: 5, todoDone: 2,
          outputTokens: 12400, contextUsed: 32000, contextLimit: 100000,
          pendingCalls: {}, openStep: null, updatedAt: NOW,
        },
        cursor: { seq: 42, lastEventTime: NOW, toolCount: 2 },
      },
    },
    {
      id: 'session-bbbb2222',
      file: 'C:\\Users\\dev\\.dsh\\sessions\\p\\s\\session.v4.jsonl.zstd',
      project: 'demo-proj',
      mtimeMs: NOW,
      label: 'Music Region 地图模块',
      shortId: 'bbbb2222',
      status: 'tool',
      glow: '#00D2AA',
      tag: 'Executing Tool',
      badge: 'Executing Tool',
      elapsedFrom: NOW - 8000,
      elapsedText: '00:08',
      turnStepText: 'T1·S2',
      toolCountText: '1 次',
      outputText: '3100 tok',
      contextText: '18%',
      contextFraction: 0.18,
      contextLevel: 0,
      todoText: '1/3',
      todoDone: 1,
      todoTotal: 3,
      todoCurrent: '天地图瓦片源切换',
      detailText: 'src/map/TileSource.kt',
      actionText: '执行 edit',
      pendingTools: 1,
      activity: { status: 'tool', proj: { title: 'Music Region 地图模块', outputTokens: 3100 } },
    },
    {
      // 全空闲会话：除恒有字段外应该一个可省略字段都不带（体积达标的来源）
      id: 'session-cccc3333',
      file: 'C:\\Users\\dev\\.dsh\\sessions\\p\\s\\session.v4.jsonl.zstd',
      project: 'demo-proj',
      mtimeMs: NOW,
      label: '盐碱地决策系统',
      shortId: 'cccc3333',
      status: 'idle',
      glow: '#50505A',
      tag: 'Ready',
      badge: 'Ready',
      elapsedFrom: null,
      elapsedText: null,
      contextFraction: null,
      todoDone: 0,
      todoTotal: 0,
      pendingTools: 0,
      activity: { status: 'idle', proj: {} },
    },
  ];
}

const cfg = {
  notchEnabled: true, jumpEnabled: true, idleHide: true, scale: 1,
  fileExists: true, raw: { glowEffect: true, expandOnHover: true },
};
const bridge = { ok: true, port: 47311, plugin: 'dsh-vibe-island', pending: 0 };

function build(entries = rawEntries(), extra = {}) {
  return S.buildSnapshot({ entries, config: cfg, bridge, jump: null, now: NOW, ...extra });
}

const dto = build();

console.log('=== P1: DTO 形状 —— 恒有字段与白名单 ===');
{
  check('顶层字段只有契约 §4 的 7 项',
    JSON.stringify(Object.keys(dto).sort()) ===
      JSON.stringify(['bridge', 'config', 'entries', 'jump', 'rev', 'serverNow', 'v'].sort()),
    Object.keys(dto).join(','));
  check('v === 2', dto.v === 2);
  check('rev 是非空字符串（~13 字符 base36）', typeof dto.rev === 'string' && dto.rev.length >= 10 && /^[0-9a-z]+$/.test(dto.rev), dto.rev);
  check('serverNow 用传入的 now', dto.serverNow === NOW);

  check('entry 数量与输入一致', dto.entries.length === 3);
  const always = ['id', 'label', 'shortId', 'status', 'live', 'glow', 'tag', 'badge'];
  for (const e of dto.entries) {
    const miss = always.filter((k) => !(k in e) || e[k] === null || e[k] === undefined);
    check('恒有字段齐全（' + (e.id || '?') + '）', miss.length === 0, '缺：' + miss.join(','));
  }

  // 白名单守门：以后 mapEntry 手滑加字段会被 ENTRY_FIELDS 拦掉
  const allowed = new Set(S.ENTRY_FIELDS);
  const extraKeys = new Set();
  for (const e of dto.entries) for (const k of Object.keys(e)) if (!allowed.has(k)) extraKeys.add(k);
  check('entry 里没有白名单外的字段', extraKeys.size === 0, [...extraKeys].join(','));

  // 契约 §4 明令禁止的字段，必须一个都找不到（含嵌套）
  const json = JSON.stringify(dto);
  for (const banned of ['activity', 'proj', 'file', 'mtimeMs', 'project', 'raw', 'fileExists']) {
    check('payload 里没有 "' + banned + '"', json.indexOf('"' + banned + '"') < 0);
  }
  check('payload 里没有 now 字段（只有 serverNow）', !Object.keys(dto).includes('now'));
  check('live 由 status 派生（thinking→true / idle→false）',
    dto.entries[0].live === true && dto.entries[2].live === false);
  check('status 缺省兜底为 idle', S.mapEntry({ id: 'x' }).status === 'idle');
  check('mapEntry 对 null 容错不崩', S.mapEntry(null).status === 'idle');
}

console.log('\n=== P2: 空值省略与类型收敛（体积达标的来源）===');
{
  const idle = dto.entries[2];
  const keys = Object.keys(idle);
  const spill = keys.filter((k) => !['id', 'label', 'shortId', 'status', 'live', 'glow', 'tag', 'badge'].includes(k));
  check('全空闲会话只留恒有字段（其余省略而不是 null）', spill.length === 0, '多带：' + spill.join(','));

  const busy = dto.entries[0];
  check('有值字段确实带上', busy.elapsedFrom === NOW - 42000 && busy.contextFraction === 0.32
    && busy.todoDone === 2 && busy.todoTotal === 5 && busy.pendingTools === undefined,
    JSON.stringify({ e: busy.elapsedFrom, f: busy.contextFraction }));
  check('pendingTools=0 被省略（缺省语义为 0）', !('pendingTools' in busy));
  check('elapsedFrom 非法值（0 / 负数 / 非数字）被省略',
    !('elapsedFrom' in S.mapEntry({ id: 'x', elapsedFrom: 0 }))
    && !('elapsedFrom' in S.mapEntry({ id: 'x', elapsedFrom: -5 }))
    && !('elapsedFrom' in S.mapEntry({ id: 'x', elapsedFrom: 'abc' })));

  const clamped = S.mapEntry({ id: 'x', contextFraction: 1.7 }).contextFraction;
  // 夹到 0 后按「空值」省略（0% 不画压力条，和缺省语义一致）
  const clampedLow = S.mapEntry({ id: 'x', contextFraction: -0.4 });
  check('contextFraction 夹到 0..1（0 按空值省略）',
    clamped === 1 && !('contextFraction' in clampedLow), clamped + '/' + JSON.stringify(clampedLow));
  check('contextFraction 非数字被省略', !('contextFraction' in S.mapEntry({ id: 'x', contextFraction: NaN })));

  check('数字型文本字段转字符串', S.mapEntry({ id: 123, label: 456 }).id === '123'
    && S.mapEntry({ id: 123, label: 456 }).label === '456');
  check('对象型文本字段被丢弃（不把内部对象带出去）',
    !('detailText' in S.mapEntry({ id: 'x', detailText: { a: 1 } })));
  check('todoDone/todoTotal/pendingTools 取非负整数',
    S.mapEntry({ id: 'x', todoDone: 2.9, todoTotal: -3, pendingTools: '2' }).todoDone === 2
    && !('todoTotal' in S.mapEntry({ id: 'x', todoTotal: -3 }))
    && !('pendingTools' in S.mapEntry({ id: 'x', pendingTools: '2' })));
}

console.log('\n=== P3: config / bridge / jump 子 DTO ===');
{
  const d = S.configDto(cfg);
  check('config 顶层只有 6 项且无 raw',
    JSON.stringify(Object.keys(d).sort()) ===
      JSON.stringify(['expandOnHover', 'glowEffect', 'idleHide', 'jumpEnabled', 'notchEnabled', 'scale'].sort()),
    Object.keys(d).join(','));
  check('glowEffect/expandOnHover 从 raw 读、默认 true',
    d.glowEffect === true && d.expandOnHover === true);
  check('raw 显式 false 被尊重',
    S.configDto({ raw: { glowEffect: false, expandOnHover: false } }).glowEffect === false
    && S.configDto({ raw: { glowEffect: false, expandOnHover: false } }).expandOnHover === false);
  check('scale 非法值退回 1（0.4 / 2.5 / NaN）',
    S.configDto({ scale: 0.4 }).scale === 1 && S.configDto({ scale: 2.5 }).scale === 1
    && S.configDto({ scale: NaN }).scale === 1);
  check('scale 合法值保留', S.configDto({ scale: 1.4 }).scale === 1.4);
  check('configDto 对 undefined 容错', S.configDto(undefined).glowEffect === true);

  const b = S.bridgeDto(undefined);
  check('bridge 默认 {ok:false,port:47311,pending:0}', b.ok === false && b.port === 47311 && b.pending === 0);
  check('bridge pending 非数字归 0', S.bridgeDto({ ok: true, port: 5000, pending: 'x' }).pending === 0);

  check('jump 缺省为 null', S.jumpDto(null) === null && S.jumpDto(undefined) === null);
  check('jump 缺字段视为无效', S.jumpDto({ kind: 'bridged' }) === null);
  check('jump 合法值原样透传',
    JSON.stringify(S.jumpDto({ kind: 'bridged', brief: '已切到该对话', at: NOW })) ===
      JSON.stringify({ kind: 'bridged', brief: '已切到该对话', at: NOW }));
}

console.log('\n=== P4: rev —— 稳定序列化与内容指纹 ===');
{
  check('stableStringify 键序无关',
    S.stableStringify({ a: 1, b: { c: 2, d: 3 } }) === S.stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  check('stableStringify 数组保序（顺序是内容）',
    S.stableStringify([1, 2]) !== S.stableStringify([2, 1]));
  check('stableStringify undefined 记为 null',
    S.stableStringify(undefined) === 'null' && S.stableStringify({ a: undefined }) === '{"a":null}');

  const r1 = S.shortRev('hello');
  check('shortRev 确定性', r1 === S.shortRev('hello'));
  check('shortRev 对内容敏感', r1 !== S.shortRev('hello!'));
  check('shortRev 长度稳定（base36 拼接）', r1.length === S.shortRev('x').length, r1);

  check('revOf 忽略 serverNow',
    S.revOf({ a: 1, serverNow: 1 }) === S.revOf({ a: 1, serverNow: 2 }));
  check('revOf 忽略已有 rev 字段',
    S.revOf({ a: 1, rev: 'old' }) === S.revOf({ a: 1 }));
  check('revOf 对内容敏感', S.revOf({ a: 1 }) !== S.revOf({ a: 2 }));
}

console.log('\n=== P5: buildSnapshot —— 去重语义 ===');
{
  const a = build();
  const b = build();                       // 同一份内容、不同调用
  check('同内容两次构建 rev 相同', a.rev === b.rev);
  check('同内容不同 serverNow 不影响 rev',
    build(undefined, { now: NOW + 5000 }).rev === a.rev);

  const changed = S.buildSnapshot({
    entries: rawEntries().map((e, i) => (i === 0 ? { ...e, detailText: '改了一句话' } : e)),
    config: cfg, bridge, jump: null, now: NOW,
  });
  check('内容一变 rev 就变（否则界面会停在旧数据）', changed.rev !== a.rev);

  const cfgOff = S.buildSnapshot({ entries: rawEntries(), config: { ...cfg, raw: { glowEffect: false } }, bridge, jump: null, now: NOW });
  check('config 变化进 rev', cfgOff.rev !== a.rev);
  const bridgePending = S.buildSnapshot({ entries: rawEntries(), config: cfg, bridge: { ...bridge, pending: 2 }, jump: null, now: NOW });
  check('bridge.pending 变化进 rev', bridgePending.rev !== a.rev);
  const withJump = S.buildSnapshot({ entries: rawEntries(), config: cfg, bridge, jump: { kind: 'bridged', brief: 'ok', at: NOW }, now: NOW });
  check('jump 回执变化进 rev', withJump.rev !== a.rev);

  // rev 只由内容决定，与输入对象的键顺序无关（stableStringify 的意义）
  const reordered = rawEntries().map((e) => {
    const o = {};
    for (const k of Object.keys(e).slice().reverse()) o[k] = e[k];
    return o;
  });
  check('输入 entry 键顺序不影响 rev', build(reordered).rev === a.rev);

  check('entries 顺序保留（主会话必须在前）',
    a.entries[0].id === 'session-a1b2c3d4' && a.entries[2].id === 'session-cccc3333');
  check('空 entries 也能构建', S.buildSnapshot({ entries: [], config: cfg, bridge, now: NOW }).entries.length === 0);
}

console.log('\n=== P6: 体积 —— DTO 不得把历史字段带回来 ===');
{
  // 同内容、同显示文本：旧快照 = 内部 entry 原样 + now + config.raw；
  // 新 DTO = 白名单。两者比值的真实性取决于数据，这里只做回归防线：
  // 历史字段一旦回流，比值会立刻逼近 1。
  const raw = rawEntries();
  const legacy = JSON.stringify({ now: NOW, entries: raw, config: cfg, bridge, jump: null });
  const wire = JSON.stringify(build());
  const ratio = Buffer.byteLength(wire) / Buffer.byteLength(legacy);
  check('同内容下 DTO 体积 < 旧快照 75%（历史字段已剥离）', ratio < 0.75,
    (ratio * 100).toFixed(1) + '%');
  console.log('     （本机 6 个真实会话实测 32.3%：8969B → 2897B，见 README 性能一节）');
}

console.log('\n=== P7: nextDelay —— 自适应轮询 ===');
{
  check('常量与契约一致（ACTIVE 250 / IDLE 1000）',
    S.ACTIVE_TICK_MS === 250 && S.IDLE_TICK_MS === 1000);
  check('有活跃会话 → 250ms', S.nextDelay([{ live: true }], false) === 250);
  check('全空闲 → 1000ms', S.nextDelay([{ live: false }, { live: false }], false) === 1000);
  check('隐藏窗口 → 1000ms（即使有活跃会话）', S.nextDelay([{ live: true }], true) === 1000);
  check('无会话 → 1000ms', S.nextDelay([], false) === 1000);
  check('null/undefined → 1000ms', S.nextDelay(null, false) === 1000 && S.nextDelay(undefined) === 1000);
  check('done 回执期（live=true）仍按活跃节奏 → 250ms', S.nextDelay([{ live: true, status: 'done' }], false) === 250);
  check('容错 monitor 内部 entry（无 live 时按 status 判）',
    S.nextDelay([{ status: 'thinking' }], false) === 250 && S.nextDelay([{ status: 'idle' }], false) === 1000);
  check('live 优先于 status（status 不可信时以 DTO 口径为准）',
    S.nextDelay([{ live: false, status: 'thinking' }], false) === 1000);
  check('列表里任意一个活跃就 250ms',
    S.nextDelay([{ live: false }, { live: true }, { live: false }], false) === 250);
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
process.exitCode = fail > 0 ? 1 : 0;
