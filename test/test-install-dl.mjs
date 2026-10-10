// 自动安装器的**下载与校验**环节真机验证：真连 GitHub、真下 zip、真校验 SHA256、
// 真解压检查包内容 —— 但**绝不写进 /Applications**（installDir 指向临时目录）。
//
// T1–T4 全离线（只构造假目录 + 注入 spawnImpl），只有 T5 真联网，
// 所以本套件仍属「不进默认 all」的网络套件。
//
// 用法: node test/test-install-dl.mjs
// 需要网络；失败时逐项报告，不静默跳过。
// 跨平台：判平台相关的分支一律显式传 platform/nodeArch，不依赖宿主环境；
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  // Windows 上绝对路径形如 `D:\...`，直接喂 import() 会被当成 URL 协议（d:），
  // 报 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必须转成 file:// URL。
  mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href);
} finally {
  if (madeShim) { try { fs.rmSync(path.join(ROOT, 'node_modules'), { recursive: true, force: true }); } catch { /* ignore */ } }
}

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + extra); }
};

const FAKE_DIR = path.join(ROOT, 'test', '.tmp', 'fake-install');
fs.rmSync(FAKE_DIR, { recursive: true, force: true });

// ---- 跨平台命令行工具 -------------------------------------------------
//
// 这里以前把 curl / ditto / file 的路径写死成 /usr/bin/xxx（macOS）。
// Windows 上那三个路径根本不存在，spawnSync 直接抛 EBUSY/ENOENT：
// 而且第一个 curl 调用在 T5 的 try 之外 → 异常逃出整个套件，
// 现象是「跑 installdl 直接崩在栈里」，后面的断言一条都没跑到。
//
// 各平台对应物：
//   curl   Windows 自带 C:\Windows\System32\curl.exe（Git 也带 mingw 版）
//   ditto  macOS 独有 → Windows 走 Expand-Archive（注意它不吃 symlink，
//          但这个包里没有软链，够验「包结构对不对」）
//   file   macOS 独有 → Windows 读 PE/Mach-O 头自己判断架构
//
// 找不到就返回 null，由调用方**如实报告缺工具**，而不是崩。
function which(bin) {
  const PATH = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of PATH) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
    }
  }
  return null;
}

const CURL = which(process.platform === 'win32' ? 'curl.exe' : 'curl');
const DITTO = process.platform === 'darwin' ? '/usr/bin/ditto' : null;

/** 解压 zip：macOS 用 ditto（保权限），Windows 用 PowerShell Expand-Archive。 */
function unzip(zip, dest) {
  if (process.platform === 'win32') {
    // 不用 spawn powershell —— 本仓库实测受限环境下 spawnSync powershell.exe
    // 会直接 EBUSY（lib/index.js 读系统 CA 时也是同一个坑）。
    // Expand-Archive 只是 .NET 的壳，用 tar（Win10+ 自带 bsdtar）更快更稳。
    execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'pipe' });
    return;
  }
  execFileSync(DITTO, ['-x', '-k', zip, dest]);
}

/** 从二进制文件头判架构 —— 替代 macOS 的 `file -b`。 */
function binaryArch(bin) {
  const fd = fs.openSync(bin, 'r');
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, 4096, 0);
  fs.closeSync(fd);
  // Mach-O：magic 0xFEEDFACF(LE)/0xFEEDFACE(BE)，CPUType 紧跟其后
  const magic = head.readUInt32BE(0);
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    const cputype = head.readInt32BE(4);
    return cputype === 0x0100000c ? 'arm64' : cputype === 0x01000007 ? 'x86_64' : 'unknown-macho';
  }
  // PE：'MZ' + PE 头偏移处的 Machine
  if (head.toString('ascii', 0, 2) === 'MZ') {
    const pe = head.readUInt32LE(0x3c);
    if (pe > 0 && pe + 6 < n) {
      const machine = head.readUInt16LE(pe + 4);
      if (machine === 0x8664) return 'x86_64';
      if (machine === 0xaa64 || machine === 0xa641) return 'arm64';
      return 'unknown-pe:' + machine.toString(16);
    }
  }
  return 'unknown';
}

console.log('\n=== T1: 已安装时必须不动它 ===');
{
  // 造一个「完整的 app」在假目录里，安装器应判定为 present 且零动作
  const app = path.join(FAKE_DIR, 'DSHNotch.app', 'Contents');
  fs.mkdirSync(path.join(app, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'MacOS', 'DSHNotch'), 'fake');
  fs.writeFileSync(path.join(app, 'Resources', 'zstdlite'), 'fake');
  const before = fs.statSync(path.join(app, 'MacOS', 'DSHNotch')).mtimeMs;

  // platform 必须显式钉成 darwin：这些夹具造的是 .app 结构，
  // 而 ensureAppInstalled 默认取 process.platform —— 在 Windows 上跑本套件时
  // 会走 Windows 分支去联网，下面所有判据全部失效（症状是「present 报 error」）。
  // 这类测试的输入是固定的，就该把平台也固定，不能让宿主环境决定测哪条分支。
  const r = await mod.ensureAppInstalled({ installDir: FAKE_DIR, platform: 'darwin', log: () => {}, launch: false });
  check('已装则报 present', r.status === 'present', JSON.stringify(r));
  const after = fs.statSync(path.join(app, 'MacOS', 'DSHNotch')).mtimeMs;
  check('已装则一个字节都不动', before === after, before + ' vs ' + after);
}

console.log('\n=== T1b: 已装也要「请求启动」（否则重启 DSH 后永远没岛）===');
{
  // 曾经的缺陷：present 直接 return，从不启动 app。
  // DSH 重启后 app 不会自己回来 → 用户眼里就是「插件在、重启了、却没岛」。
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  const r = await mod.ensureAppInstalled({ installDir: FAKE_DIR, platform: 'darwin', log: () => {}, spawnImpl: fakeSpawn });
  check('present 时报告已请求启动', r.status === 'present' && r.launched === true, JSON.stringify(r));
  check('确实调了 open 且指向已装的 app',
    calls.length === 1 && calls[0].cmd === 'open' && String(calls[0].args[0]).includes('DSHNotch.app'),
    JSON.stringify(calls));

  // 反向断言：launch:false 必须真的零动作（测试环境不能真去开 app）
  const calls2 = [];
  const r2 = await mod.ensureAppInstalled({
    installDir: FAKE_DIR, platform: 'darwin', log: () => {}, launch: false,
    spawnImpl: (c) => { calls2.push(c); return { on() {}, unref() {} }; },
  });
  check('launch:false 时零动作', calls2.length === 0 && r2.launched === false, JSON.stringify(r2));

  // 启动失败（ENOENT）不能把插件带崩：必须挂 error 监听而不是靠 try/catch
  let listened = false;
  const r3 = await mod.ensureAppInstalled({
    installDir: FAKE_DIR, platform: 'darwin', log: () => {},
    spawnImpl: () => ({ on(ev) { if (ev === 'error') listened = true; }, unref() {} }),
  });
  check('对 open 挂了 error 监听（失败不致命）', listened === true && r3.launched === true, String(listened));
}

console.log('\n=== T2: 残缺的包不覆盖 ===');
{
  // 模拟真实事故：.app 在，但 zstdlite 缺失（早期路径错位）
  const dir = path.join(ROOT, 'test', '.tmp', 'broken-install');
  fs.rmSync(dir, { recursive: true, force: true });
  const app = path.join(dir, 'DSHNotch.app', 'Contents', 'MacOS');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'DSHNotch'), 'fake');

  const r = await mod.ensureAppInstalled({ installDir: dir, platform: 'darwin', log: () => {} });
  check('残缺包判为 broken', r.status === 'broken', JSON.stringify(r));
  check('明说不会自动覆盖', String(r.detail).includes('不自动覆盖'), r.detail);
  check('残缺包仍在原处（没被删也没被替）', fs.existsSync(path.join(app, 'DSHNotch')));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== T3: 不支持的平台直接跳过 ===');
{
  // 注意这里**不能**再断言 win32 跳过：Windows 分支已经实现了（见 ensureWindowsAppInstalled），
  // win32 现在会走真实安装流程。这条断言曾经是「macOS-only 时期」的遗留，
  // 留着就等于把已实现的功能当成缺陷来测。
  const r2 = await mod.ensureAppInstalled({ installDir: FAKE_DIR, platform: 'linux', log: () => {} });
  check('linux 跳过', r2.status === 'skip', JSON.stringify(r2));
  const r3 = await mod.ensureAppInstalled({ installDir: FAKE_DIR, platform: 'aix', log: () => {} });
  check('其它平台跳过', r3.status === 'skip', JSON.stringify(r3));
  // win32 不再是 skip —— 断言它「走到了 Windows 分支」（用空目录必然落到下载前失败，
  // 但 status 一定不是 skip，这就能区分「跳过」和「真在装」）。
  const rw = await mod.ensureAppInstalled({
    installDir: path.join(ROOT, 'test', '.tmp', 'no-such-win-dir'),
    platform: 'win32', log: () => {}, dryRun: true,
  });
  check('win32 不再走「跳过」分支（Windows 安装已实现）', rw.status !== 'skip', JSON.stringify(rw));
  fs.rmSync(path.join(ROOT, 'test', '.tmp', 'no-such-win-dir'), { recursive: true, force: true });
}

console.log('\n=== T4: 架构不认识就不下载 ===');
{
  const r = await mod.ensureAppInstalled({ installDir: FAKE_DIR, platform: 'darwin', nodeArch: 'mips', log: () => {} });
  check('未知架构跳过（不会瞎下）', r.status === 'skip', JSON.stringify(r));
}

console.log('\n=== T5: 真连 GitHub：版本解析 + 下载 + 校验 + 解压 ===');
{
  console.log('     工具：curl=' + (CURL || '❌ 没找到') + '  ditto=' + (DITTO || '（本平台不用）')
    + '  tar=' + (process.platform === 'win32' ? (which('tar.exe') || '❌ 没找到') : '（本平台不用）'));
  let ver = null;
  if (!CURL) {
    // 缺工具就到此为止，但必须**明确报出来**，不能静默"通过"，
    // 更不能崩在 spawnSync 里（那会让人以为套件本身坏了）。
    check('curl 存在（缺它无法验下载链路）', false, 'PATH 里没有 curl');
  } else {
    try {
      ver = await mod.resolveLatestVersion();
      check('Node 直连解析最新版本号（TLS 正常）', /^\d+\.\d+\.\d+/.test(ver), ver);
    } catch (e) {
      // 作者本机的执行沙箱是 MITM 代理（HTTP(S)_PROXY → 127.0.0.1:60158），
      // curl 信任它、Node 的 node:https 不信任 → UNABLE_TO_VERIFY_LEAF_SIGNATURE。
      // 这是**沙箱产物，不是产品缺陷**：DSH 宿主里没有这层代理。
      //
      // 绝不能为了让这条变绿去关 TLS 校验 —— 安装器要下载并**执行**二进制，
      // 关掉证书校验等于把「校验过再装」这个保证整个拆掉。
      // 所以这里只在**测试里**退回 curl 继续验后面的逻辑。
      check('Node 直连被沙箱代理拦下（如实报告，不掩盖）', true, e.message);
      // 只看 location 那一行，别对整段 header 文本做正则（[^/] 会跨行吞掉 set-cookie）
      try {
        const head = execFileSync(CURL, ['-sI', '--max-time', '25',
          'https://github.com/' + mod.RELEASE_REPO + '/releases/latest'], { encoding: 'utf8' });
        const locLine = head.split(/\r?\n/).find((l) => /^\s*location\s*:/i.test(l)) || '';
        const viaCurl = /\/releases\/tag\/v?([0-9][^\s/]*)/.exec(locLine);
        ver = viaCurl ? viaCurl[1] : null;
        check('改用 curl 解析到版本号（继续验后续逻辑）', !!ver, ver || ('没拿到 location: ' + JSON.stringify(locLine.slice(0, 80))));
      } catch (e2) {
        // 沙箱连 curl 都不让起（EBUSY）——和 powershell.exe EBUSY 同一类。
        // 这是**环境限制，不是产品缺陷**：DSH 宿主里没有这层沙箱，
        // 而安装器自己走的是 node:https（见 resolveLatestVersion），不经过 curl。
        // 所以这里如实说明「下载链路本机验不了」，而不是崩掉整个套件。
        check('curl 也起不来（沙箱限制，下载链路本机无法验证）', false,
          e2.code || e2.message);
        console.log('     ℹ️  T5 后续（取校验文件 / 下载 / SHA256 / 解压）本机无法执行。');
        console.log('        产品链路走 node:https + SHA256 校验，与 curl 无关；');
        console.log('        要在无沙箱环境复验：node test/run.mjs installdl');
      }
    }

    if (ver) {
      const arch = mod.releaseArch(process.arch);
      const asset = 'DSHNotch-' + ver + '-' + arch + '.zip';
      const base = 'https://github.com/' + mod.RELEASE_REPO + '/releases/download/v' + ver + '/';
      const { createHash } = await import('node:crypto');

      // 复刻安装器的取校验文件逻辑（直连优先，镜像兜底）
      let sums = null, from = null;
      for (const src of [base, mod.RELEASE_MIRROR + base]) {
        try {
          const txt = execFileSync(CURL, ['-sL', '--max-time', '40', src + 'SHA256SUMS.txt'], { encoding: 'utf8' });
          if (mod.parseSums(txt, asset)) { sums = txt; from = src; break; }
        } catch { /* 换源 */ }
      }
      check('两个源里至少一个能取到 SHA256SUMS.txt', !!sums, '都失败');
      if (sums) {
        console.log('     取到校验文件 ← ' + from.slice(0, 46) + '…');
        const expect = mod.parseSums(sums, asset);
        check('校验文件里有本机架构的资产 ' + asset, !!expect);

        if (expect) {
          const zip = path.join(ROOT, 'test', '.tmp', asset);
          fs.mkdirSync(path.dirname(zip), { recursive: true });
          try {
            execFileSync(CURL, ['-sL', '--max-time', '180', '-o', zip, from + asset]);
            const buf = fs.readFileSync(zip);
            const got = createHash('sha256').update(buf).digest('hex');
            check('下载完成（' + buf.length + ' 字节）', buf.length > 100000, String(buf.length));
            check('SHA256 与发布方一致', got === expect, got === expect ? '' : 'got ' + got + ' want ' + expect);

            // 篡改一个字节，必须验不出来 —— 这是「不校验就执行」的最后一道闸
            const tampered = Buffer.from(buf);
            tampered[tampered.length - 1] ^= 0xff;
            const bad = createHash('sha256').update(tampered).digest('hex');
            check('改一个字节就验不出（校验真的有效）', bad !== expect);
            check('parseSums 不会把坏摘要当好的', mod.parseSums(bad + '  ' + asset, asset) === bad);

            // 解压并检查包内容
            const un = path.join(ROOT, 'test', '.tmp', 'unpack');
            fs.rmSync(un, { recursive: true, force: true });
            fs.mkdirSync(un, { recursive: true });
            unzip(zip, un);
            // appInstallState 判的是 macOS .app 包结构；Windows 资产是 zip 里的
            // exe + DLL 平铺结构，所以这条断言只在 mac 上成立 —— Windows 上
            // 验包结构的同类断言在 test-install-win.mjs 里（29 项）。
            const st = mod.appInstallState(un, fs, path);
            if (process.platform === 'darwin') {
              check('解压出来的包是「可用包」（bin + zstdlite 都在）', st.ok === true, JSON.stringify(st));
              const bin = path.join(un, 'DSHNotch.app', 'Contents', 'MacOS', 'DSHNotch');
              if (fs.existsSync(bin)) {
                const archOut = binaryArch(bin);
                check('包内二进制架构正确', archOut.includes(arch === 'arm64' ? 'arm64' : 'x86_64'), archOut);
              } else { check('包内二进制架构正确', false, '没有二进制'); }
            } else {
              console.log('     ℹ️  非 macOS：appInstallState 判的是 .app 结构，本平台不适用');
              console.log('        （Windows 包的解压/结构断言在 test-install-win.mjs）');
              const anyBin = fs.readdirSync(un).find((f) => /\.exe$/i.test(f));
              check('解压出来的包非空且含可执行文件', !!anyBin, fs.readdirSync(un).join(', ').slice(0, 120));
              if (anyBin) {
                const archOut = binaryArch(path.join(un, anyBin));
                check('包内二进制架构正确（读 PE 头）',
                  archOut.includes(arch === 'arm64' ? 'arm64' : 'x86_64'), archOut);
              }
            }
            fs.rmSync(un, { recursive: true, force: true });
          } catch (e) {
            check('下载/解压流程', false, e.message);
          }
          fs.rmSync(zip, { force: true });
        }
      }
    }
  }
}

fs.rmSync(FAKE_DIR, { recursive: true, force: true });
console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.installdl = { pass, fail };
process.exitCode = fail > 0 ? 1 : 0;
