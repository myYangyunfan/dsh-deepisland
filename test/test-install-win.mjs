// Windows 自动安装器的自测：判据、启动、预演、架构守卫、包结构定位。
//
// 与 installdl 的区别：那个真连 GitHub 走完「下载→校验→解压」；这个全程离线，
// 只验证**决策逻辑** —— 装不装、装到哪、用不用覆盖、起不起进程。
// 所以它能进默认 `all`，CI 上不用联网也能跑。
//
// 用法: node test/run.mjs installwin   （或直接 node test/test-install-win.mjs）
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 依赖 shim：lib/index.js 只 import schemastery，本机没装依赖也能加载 ----
const shim = path.join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery');
let madeShim = false;
if (!fs.existsSync(shim)) {
  const chain = "const node=()=>{const s={};for(const m of ['default','description','step','min','max','readonly'])s[m]=()=>s;return s;};\n"
    + "export default {object:node,union:node,boolean:node,number:node,natural:node,string:node,const:node};\n";
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test-shim', type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(shim, 'index.js'), chain);
  madeShim = true;
}
let mod;
try {
  // Windows 上绝对路径是 `D:\...`，直接喂 import() 会被当成 URL 协议（d:）而报
  // ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必须转成 file:// URL。
  mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
} finally {
  if (madeShim) { try { fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* ignore */ } }
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + extra); }
};

const BASE = path.join(ROOT, 'test', '.tmp', 'win-install');
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

const stub = () => ({ on() {}, unref() {} });
const spySpawn = (sink) => (cmd, args, opts) => { sink.push({ cmd, args, opts }); return stub(); };

// 造三种安装目录：空的 / 只有 exe（残包）/ 完整
const EMPTY = path.join(BASE, 'empty');
const PARTIAL = path.join(BASE, 'partial');
const FULL = path.join(BASE, 'full');
const ASAR_ONLY = path.join(BASE, 'asar-only');
fs.mkdirSync(EMPTY, { recursive: true });
fs.mkdirSync(PARTIAL, { recursive: true });
fs.writeFileSync(path.join(PARTIAL, 'DSHNotch.exe'), 'fake-binary');
fs.mkdirSync(path.join(FULL, 'resources'), { recursive: true });
fs.writeFileSync(path.join(FULL, 'DSHNotch.exe'), 'fake-binary');
fs.writeFileSync(path.join(FULL, 'resources', 'app.asar'), 'fake-asar');
fs.mkdirSync(path.join(ASAR_ONLY, 'resources'), { recursive: true });
fs.writeFileSync(path.join(ASAR_ONLY, 'resources', 'app.asar'), 'fake-asar');

const EXE_MTIME = fs.statSync(path.join(FULL, 'DSHNotch.exe')).mtimeMs;

console.log('\n=== W1: 判据不能只看「目录在不在」 ===');
{
  const e = mod.windowsInstallState(EMPTY, fs, path);
  check('空目录 = 未装', e.ok === false && e.hasExe === false && e.hasAsar === false, JSON.stringify(e));

  const p = mod.windowsInstallState(PARTIAL, fs, path);
  check('只有 exe = 残包（判 ok 会「托盘有图标、双击没反应」）',
    p.ok === false && p.hasExe === true && p.hasAsar === false, JSON.stringify(p));

  const a = mod.windowsInstallState(ASAR_ONLY, fs, path);
  check('只有 app.asar = 残包', a.ok === false && a.hasExe === false && a.hasAsar === true, JSON.stringify(a));

  const f = mod.windowsInstallState(FULL, fs, path);
  check('exe + resources/app.asar = 完整', f.ok === true, JSON.stringify(f));
}

console.log('\n=== W2: 已装则不动它，但要「请求启动」 ===');
{
  const calls = [];
  const r = await mod.ensureAppInstalled({
    installDir: FULL, platform: 'win32', log: () => {}, spawnImpl: spySpawn(calls),
  });
  check('已装报 present 且已请求启动', r.status === 'present' && r.launched === true, JSON.stringify(r));
  check('启动一次，且指向已装的 exe',
    calls.length === 1 && String(calls[0].cmd).endsWith('DSHNotch.exe'), JSON.stringify(calls));
  check('detached 启动（不随插件进程一起死）',
    calls.length === 1 && calls[0].opts && calls[0].opts.detached === true, JSON.stringify(calls[0] && calls[0].opts));
  check('已装则一个字节都不动',
    fs.statSync(path.join(FULL, 'DSHNotch.exe')).mtimeMs === EXE_MTIME, 'mtime 变了');

  const calls2 = [];
  const r2 = await mod.ensureAppInstalled({
    installDir: FULL, platform: 'win32', log: () => {}, launch: false, spawnImpl: spySpawn(calls2),
  });
  check('launch:false 时零动作', calls2.length === 0 && r2.launched === false, JSON.stringify(r2));
}

console.log('\n=== W3: 启动失败不能把插件带崩 ===');
{
  // spawn 的失败是异步的（error 事件），try/catch 兜不住 —— 必须挂监听，
  // 否则 ENOENT 会变成 unhandled 'error' 事件，连带插件一起挂。
  let listened = false;
  const r = await mod.ensureAppInstalled({
    installDir: FULL, platform: 'win32', log: () => {},
    spawnImpl: () => ({ on(ev) { if (ev === 'error') listened = true; }, unref() {} }),
  });
  check('挂了 error 监听', listened === true, '没挂');
  check('启动失败也不影响「已装」结论', r.status === 'present', JSON.stringify(r));

  let logged = '';
  const r2 = await mod.ensureAppInstalled({
    installDir: FULL, platform: 'win32', log: (m) => { logged += m; },
    spawnImpl: () => { throw new Error('EBUSY'); },
  });
  check('spawn 同步抛错也被吞掉', r2.status === 'present' && r2.launched === false, JSON.stringify(r2));
  check('失败进了日志（这是「下载并运行外部程序」，必须可追溯）', logged.length > 0, JSON.stringify(logged));
}

console.log('\n=== W4: 残包自愈与占用让路（staged 落位） ===');
// 2026-10-15 真机事故:直接 cp 到目标被杀软锁打断 → 半写残包(exe 在、
// asar 缺) → 老守卫「残包不自动覆盖」把自伤半成品当用户的东西拒修复,
// 岛从此起不来。新纪律:staged 拷贝+验完整+rename 换入;残包被挪走
// 自愈;真被占用(运行中)才让路。这里直接测落位函数(走完整安装要联网)。
{
  const fsp = await import('node:fs/promises');
  const mkFull = (root) => {
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(root, 'DSHNotch.exe'), 'new-exe');
    fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'new-asar');
  };

  // 4a: 残包目标 → 自愈
  const tgt = path.join(BASE, 'repair-target');
  fs.mkdirSync(path.join(tgt, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(tgt, 'DSHNotch.exe'), 'broken-exe');   // 残包:有 exe 无 asar
  const srcTree = path.join(BASE, 'full-src');
  mkFull(srcTree);
  const r = await mod.placeWindowsStaged({ srcTree, target: tgt, F: fs, P: path, fsp, log: () => {} });
  check('残包被修复（staged 换入成功）', r.ok === true, JSON.stringify(r));
  check('修复后目标完整', mod.windowsInstallState(tgt, fs, path).ok === true);
  check('内容确实是新的', fs.readFileSync(path.join(tgt, 'DSHNotch.exe'), 'utf8') === 'new-exe');
  check('暂存目录已消失', !fs.existsSync(path.join(BASE, '.DSHNotch-staged-' + process.pid)));
  const leftovers = fs.readdirSync(BASE).filter((n) => n.startsWith('.DSHNotch-'));
  check('旧残件已清走（无 .DSHNotch-old-* 残留）', leftovers.length === 0, JSON.stringify(leftovers));

  // 4b: 目标被占用(运行中) → 让路不硬来。Windows 上父目录里有打开句柄的
  // 文件时 rename 目录会失败 —— 用一个独占句柄模拟「正在运行」。
  const tgt2 = path.join(BASE, 'locked-target');
  fs.mkdirSync(path.join(tgt2, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(tgt2, 'DSHNotch.exe'), 'running-exe');
  const fd = fs.openSync(path.join(tgt2, 'DSHNotch.exe'), 'r+');
  const r2 = await mod.placeWindowsStaged({ srcTree, target: tgt2, F: fs, P: path, fsp, log: () => {} });
  check('被占用时让路（occupied 标记）', r2.ok === false && r2.occupied === true, JSON.stringify(r2));
  check('占用时目标原样（一个字节不动）',
    fs.readFileSync(path.join(tgt2, 'DSHNotch.exe'), 'utf8') === 'running-exe');
  fs.closeSync(fd);
}

console.log('\n=== W5: 架构守卫 ===');
{
  const calls = [];
  const r = await mod.ensureAppInstalled({
    installDir: EMPTY, platform: 'win32', nodeArch: 'ia32', log: () => {}, spawnImpl: spySpawn(calls),
  });
  check('ia32 直接 skip（Electron 44 不再出 32 位包）', r.status === 'skip', JSON.stringify(r));
  check('skip 时零动作', calls.length === 0, JSON.stringify(calls));

  const r2 = await mod.ensureAppInstalled({
    installDir: EMPTY, platform: 'linux', nodeArch: 'x64', log: () => {}, spawnImpl: spySpawn([]),
  });
  check('linux 仍走原来的 skip 分支（没被 Windows 改动波及）', r2.status === 'skip', JSON.stringify(r2));
}

console.log('\n=== W6: 预演只回答「会装到哪」，不落任何文件 ===');
{
  // 把默认安装位置指到沙箱：ensureWindowsAppInstalled 会把
  // %LOCALAPPDATA%\Programs\DSHNotch 也列为候选，任何真装过 DSHNotch 的
  // 机器（开发机、跑过自动安装的用户机）都会抢先命中 present 分支，
  // 把「预演」变成「已装」—— 这条测试就此假红。预演必须在自己控制的
  // 环境里验，不能依赖「这台机器恰好没装」。
  const realLocalAppData = process.env.LOCALAPPDATA;
  const sandboxLocalAppData = path.join(BASE, 'no-default-install');
  process.env.LOCALAPPDATA = sandboxLocalAppData;
  try {
    const target = path.join(BASE, 'dry-run-target');   // 故意不存在
    const calls = [];
    const r = await mod.ensureAppInstalled({
      installDir: target, platform: 'win32', nodeArch: 'x64', version: '1.1.0',
      dryRun: true, log: () => {}, spawnImpl: spySpawn(calls),
    });
    check('报 dry-run', r.status === 'dry-run', JSON.stringify(r));
    check('资产名 = DSHNotch-<ver>-win-<arch>.zip',
      /DSHNotch-1\.1\.0-win-x64\.zip/.test(r.detail || ''), r.detail);
    check('预演不建目录', fs.existsSync(target) === false, target + ' 被建出来了');
    check('预演不启动任何进程', calls.length === 0, JSON.stringify(calls));
    check('默认位置也没被碰（沙箱未落地）',
      fs.existsSync(sandboxLocalAppData) === false, sandboxLocalAppData + ' 被建出来了');
  } finally {
    if (realLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = realLocalAppData;
  }
}

console.log('\n=== W7: 包结构定位（zip 里有一层平台目录）===');
{
  const un = path.join(BASE, 'unpacked');
  const inner = path.join(un, 'DSHNotch-win32-x64');
  fs.mkdirSync(path.join(inner, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'DSHNotch.exe'), 'fake');
  fs.writeFileSync(path.join(inner, 'resources', 'app.asar'), 'fake');

  const hit = mod.findFile(un, 'DSHNotch.exe', 3);
  check('能从外层定位到嵌套的 exe', !!hit && path.basename(hit) === 'DSHNotch.exe', String(hit));
  check('定位到的那一层本身是完整包',
    hit && mod.windowsInstallState(path.dirname(hit), fs, path).ok === true, String(hit));

  const flat = path.join(BASE, 'flat');
  fs.mkdirSync(path.join(flat, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(flat, 'DSHNotch.exe'), 'fake');
  fs.writeFileSync(path.join(flat, 'resources', 'app.asar'), 'fake');
  check('exe 就在根也能找到（深度 0）', mod.findFile(flat, 'DSHNotch.exe', 3) === path.join(flat, 'DSHNotch.exe'), '');

  const deep = path.join(BASE, 'deep');
  fs.mkdirSync(path.join(deep, 'a', 'b', 'c', 'd'), { recursive: true });
  fs.writeFileSync(path.join(deep, 'a', 'b', 'c', 'd', 'DSHNotch.exe'), 'fake');
  check('超过 maxDepth 的不算（防止把别的包误认成自己）', mod.findFile(deep, 'DSHNotch.exe', 3) === null, '找到了');

  check('包里没有 exe 时返回 null（不是可用包）', mod.findFile(un, 'NotThere.exe', 3) === null, '');
}

// ---------------------------------------------------------------------------
// W8: 代理 CA —— 这是「自动安装在带 MITM 代理的机器上装不下来」的根因
// ---------------------------------------------------------------------------
//
// 本组**不联网**，只锁住两条纪律：
//   1. 探测函数拿不到东西时返回 null，绝不抛错、绝不生成「万能 CA」；
//   2. 源码层面不得出现「把 leaf 当 CA」这类已被实测推翻的写法，
//      也不得为了让下载通过而关掉证书校验。
//
// 为什么要有第 2 条：曾经真的实现过「从隧道取 leaf 当 CA」，实测必然失败
// （代理只发 leaf，issuer 公钥不在网上，leaf 非自签非 CA）。那段代码会让
// 错误信息变成「重试仍失败」，比直接报错更难懂。用断言挡回去。
console.log('\n=== W8: 代理 CA 探测的纪律（防「用 leaf 当 CA」回归）===');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');

  check('探测函数已导出（可被自检调用）',
    typeof mod.proxyIssuerName === 'function', typeof mod.proxyIssuerName);

  // 没有代理时必须立刻返回 null，而不是去连什么、更不是抛错。
  // ⚠️ 必须先清缓存：这个函数在**真实机器**上第一次调用会成功探到
  // 代理签发者并缓存住；不清就会拿上一次的真结果来判「连不上」这一条，
  // 变成假阴性（本仓库实测踩过：CI 上过、本机红）。
  mod.resetSystemCACache();
  let r = null, threw = null;
  try {
    r = await mod.proxyIssuerName({
      proxy: { host: '127.0.0.1', port: 1 },   // 保证连不上的端口
      host: 'example.invalid', port: 443, timeoutMs: 800,
    });
  } catch (e) { threw = e; }
  check('连不上时返回 null 而不是抛错', threw === null, String(threw && threw.message));
  check('连不上时不编造签发者', r === null, JSON.stringify(r));

  // 诊断文案必须真给用户下一步 —— 「不知道怎么办」是这个 bug 最难的地方。
  check('错误里带出「中间签发者」的名字（用户据此找根证书）',
    /中间签发者/.test(src), '没有把签发者名字带进错误');
  check('错误里给出两条可执行出路（装根证书 / NODE_EXTRA_CA_CERTS）',
    /受信任的根证书颁发机构/.test(src) && /NODE_EXTRA_CA_CERTS/.test(src), '缺少可操作指引');

  // 系统 CA 读不到时，detail 必须区分「读不到」和「存储为空」两种成因。
  mod.resetSystemCACache();
  const n = mod.systemCACertificates().length;
  const detail = mod.systemCADetail();
  check('Windows 上系统 CA 的成因被区分开（子进程被禁 / 存储为空）',
    n > 0 || /子进程被禁|存储为空/.test(detail), detail);

  // 纪律：真实请求一律严格校验，只允许存在「只读探测」那一处放宽。
  // 只看**代码**里的 `rejectUnauthorized:`，注释里提到这个词不算
  // （本文件多处注释正是在解释「为什么不能把它置假」）。
  const codeOnly = src.split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');
  const relaxed = (codeOnly.match(/rejectUnauthorized\s*:\s*false/g) || []).length;
  check('代码里只有一处 rejectUnauthorized:false（就是那次只读探测）',
    relaxed === 1, '实际 ' + relaxed + ' 处');
  check('不得把 leaf 自身塞进 ca 当信任锚（实测必然失败）',
    !/proxyIssuerCertificate/.test(src), '旧的「用 leaf 当 CA」实现还在');
  check('不得出现「补齐 CA 后重试」这种绕一圈仍会失败的逻辑',
    !/补上代理 CA/.test(src), '旧的失败重试文案还在');
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.installwin = { pass, fail };
process.exitCode = fail > 0 ? 1 : 0;
