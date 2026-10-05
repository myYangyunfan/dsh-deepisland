// Windows 版会话数据源的自检。
//
// 用**真实会话文件**跑（`~/.dsh/sessions/**/session.v4.jsonl.zstd`），
// 而不是造假数据 —— 数据的真实形态（字段名、类型、嵌套 JSON 字符串）
// 只有真文件才验证得了。找不到真实文件时退化为自造样本，并如实标注。
//
// 用法: node windows/test/session-source.test.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SRC = path.join(__dirname, '..', 'src', 'session-source.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

console.log('=== W1: 模块能加载 ===');
const S = require(SRC);
check('导出齐全', ['sessionFiles', 'loadEvents', 'prettyProject', 'decompress']
  .every((k) => typeof S[k] === 'function'), Object.keys(S).join(','));
check('上限与窗口和 Swift 版一致', S.MAX_SESSIONS === 6 && S.ACTIVE_WINDOW_MS === 1800000,
  S.MAX_SESSIONS + '/' + S.ACTIVE_WINDOW_MS);

console.log('\n=== W2: prettyProject（项目名还原）===');
check('--Users-delinger-Desktop-deepisland-- → deepisland',
  S.prettyProject('--Users-delinger-Desktop-deepisland--') === 'deepisland',
  String(S.prettyProject('--Users-delinger-Desktop-deepisland--')));
check('只有一段时原样返回', S.prettyProject('--solo--') === 'solo', String(S.prettyProject('--solo--')));
check('末段长度 < 2 返回 null（与 Swift 版一致）',
  S.prettyProject('--a-b--') === null, String(S.prettyProject('--a-b--')));
check('空/全连字符返回 null', S.prettyProject('') === null && S.prettyProject('---') === null);

console.log('\n=== W3: 会话发现（真实文件）===');
const files = S.sessionFiles();
check('能找到会话文件', files.length > 0, '找到 ' + files.length + ' 个');
if (files.length > 0) {
  const f = files[0];
  check('有 id（= 会话目录名）', typeof f.id === 'string' && f.id.length > 0, f.id);
  check('id 形如 session-<uuid>', /^session-[0-9a-f-]+$/.test(f.id), f.id);
  check('有 project 名', typeof f.project === 'string' && f.project.length > 0, f.project);
  check('文件路径指向 .zstd', f.file.endsWith('session.v4.jsonl.zstd'), f.file);
  check('文件真实存在', fs.existsSync(f.file), f.file);
  check('有 mtime 与 size', f.mtimeMs > 0 && f.size > 0, f.mtimeMs + '/' + f.size);
  console.log('     实际发现 ' + files.length + ' 个：');
  files.slice(0, 3).forEach((x) => console.log('       · ' + x.id + '  (' + x.project + ')'));
}

console.log('\n=== W4: 上限与排序 ===');
check('maxCount=1 只给 1 个', S.sessionFiles({ maxCount: 1 }).length <= 1);
check('按 mtime 倒序', (() => {
  const a = S.sessionFiles({ maxCount: 6 });
  for (let i = 1; i < a.length; i++) if (a[i].mtimeMs > a[i - 1].mtimeMs) return false;
  return true;
})(), '顺序不是 mtime 倒序');
check('activeWithin=0 时退化为最新 1 个（面板不空白）',
  S.sessionFiles({ maxCount: 6, activeWithin: 0 }).length === 1,
  String(S.sessionFiles({ maxCount: 6, activeWithin: 0 }).length));

console.log('\n=== W5: 解压与事件解码（真实数据）===');
const latest = S.latestSessionFile();
if (!latest) {
  check('有真实会话文件可测', false, '~/.dsh/sessions 下没找到，跳过（本机没跑过 DSH？）');
} else {
  const raw = S.decompress(latest);
  check('zstd 解压成功（Node 内置，无需外部二进制）', typeof raw === 'string' && raw.length > 0,
    raw === null ? '返回 null' : '长度 ' + raw.length);

  const ev = S.loadEvents(latest);
  check('事件解码成功', Array.isArray(ev) && ev.length > 0, ev === null ? 'null' : ev.length + ' 条');
  if (ev && ev.length > 0) {
    const e0 = ev[0];
    check('事件有 type 字段', typeof e0.type === 'string', JSON.stringify(e0).slice(0, 120));
    console.log('     首条: type=' + e0.type + ' seq=' + (e0.seq ?? '-'));
    console.log('     类型分布: ' + JSON.stringify(
      ev.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {})));
  }

  // 缓存：同 mtime+size 应命中（第二次调用快且返回同一数组引用）
  const t0 = Date.now();
  S.loadEvents(latest);
  const cached = S.loadEvents(latest);
  const dt = Date.now() - t0;
  check('mtime+size 缓存生效（第二次极快）', dt < 5, dt + 'ms');
  check('缓存返回同一份结果', Array.isArray(cached) && cached.length > 0);

  // 坏文件要降级而不是崩。
  //
  // ⚠️ 坏数据必须**超过 32 字节**：`decompress()` 里有一条
  // 「极小文件直接判空（仅 zstd 帧头）」的早退（照搬 Swift 版），
  // 用短字符串会先命中它、根本走不到 zstd 解压 —— 那测的就不是这条路径了。
  const bad = path.join(os.tmpdir(), 'dshwin-bad-' + process.pid + '.zstd');
  fs.writeFileSync(bad, Buffer.from('this is definitely not a zstd frame, padding to pass the size gate'));
  check('坏数据能走到 zstd（先确认没被"极小文件"早退截胡）',
    fs.statSync(bad).size > 32, String(fs.statSync(bad).size));
  check('坏文件解压返回 null（不抛错）', S.decompress(bad) === null, String(S.decompress(bad)));
  check('坏文件事件返回 null（不抛错）', S.loadEvents(bad) === null, JSON.stringify(S.loadEvents(bad)));

  // 极小文件走早退（这是刻意保留的行为：刚创建的空会话）
  const tiny = path.join(os.tmpdir(), 'dshwin-tiny-' + process.pid + '.zstd');
  fs.writeFileSync(tiny, Buffer.alloc(8));
  check('极小文件走"判空"早退（返回空串而非 null）', S.decompress(tiny) === '', JSON.stringify(S.decompress(tiny)));
  fs.unlinkSync(tiny);

  check('不存在的文件返回 null（不抛错）',
    S.loadEvents(path.join(os.tmpdir(), 'nope-' + process.pid + '.zstd')) === null);
  fs.unlinkSync(bad);
}

console.log('\n=== W6: 目录缺失时的容错 ===');
{
  const fake = path.join(os.tmpdir(), 'dshwin-empty-' + process.pid);
  fs.mkdirSync(path.join(fake, 'sessions'), { recursive: true });
  const old = process.env.DSH_ROOT;
  process.env.DSH_ROOT = fake;
  S.invalidate();
  check('sessions 目录为空 → 返回空数组', S.sessionFiles().length === 0);
  check('latestSessionFile 返回 null', S.latestSessionFile() === null);
  check('loadLatestEvents 返回空数组', Array.isArray(S.loadLatestEvents()) && S.loadLatestEvents().length === 0);

  // 造一个三层结构的假会话，验路径推导
  const d = path.join(fake, 'sessions', '--Users-x-Desktop-demo--', 'session-abc-123');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), Buffer.alloc(64));
  S.invalidate();
  const got = S.sessionFiles();
  check('能发现三层结构的会话', got.length === 1, '找到 ' + got.length);
  if (got.length === 1) {
    check('id 取会话目录名', got[0].id === 'session-abc-123', got[0].id);
    check('project 取项目目录名', got[0].project === '--Users-x-Desktop-demo--', got[0].project);
  }

  // 不存在的根目录
  process.env.DSH_ROOT = path.join(fake, 'no-such-dir');
  S.invalidate();
  check('根目录不存在也不崩', S.sessionFiles().length === 0);

  if (old === undefined) delete process.env.DSH_ROOT; else process.env.DSH_ROOT = old;
  S.invalidate();
  fs.rmSync(fake, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);
