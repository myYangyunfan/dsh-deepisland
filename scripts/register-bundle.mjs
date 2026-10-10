#!/usr/bin/env node
/**
 * 一步注册：把本插件加进 DSH profile 的 `dsh.profile.bundles`。
 *
 * ## 为什么要这一步
 *
 * 插件管理器的「安装」只跑 `pnpm add`，只写 `dependencies`；
 * 而宿主按 `dsh.profile.bundles` 顺序叠 patch 树（asar 内置文档原文：
 * *"the tree is composed by applying each bundle's patch lists in
 * `dsh.profile.bundles` order over an empty entry list, then the profile's own
 * patches"*）。两者在 `initProfile` 里各自初始化，**无任何自动合并**
 * → **不登记就不会被加载**。
 *
 * 为什么用户在界面上看不出异常：宿主确实有个 `reportSkippedBundles` 会往 stderr
 * 打印跳过原因，但它只列**「在 bundles 里、却加载失败」**的条目。
 * 本插件的情况是**压根不在 bundles 里** —— 连「被跳过」都算不上，
 * 所以既不在跳过列表里，也不影响其他 bundle，**一点提示都没有**。
 * 表现就是：插件管理器里显示「已安装」，但功能毫无反应。
 *
 * 鸡生蛋：插件没法自己登记（不在 bundles 里 → `apply()` 不被调用）。
 *
 * ## 为什么用这个脚本，而不是让用户手改 JSON
 *
 * 装插件的人**手上没有仓库**，只有 profile 里的插件目录。
 * 所以本文件在需要时会把「你实际该跑的那一行」直接打出来（用插件目录的真实路径）。
 *
 * ## 用法
 *
 *   node scripts/register-bundle.mjs           # 登记
 *   node scripts/register-bundle.mjs --check   # 只看状态，不改
 *   node scripts/register-bundle.mjs --remove  # 摘掉（依赖保留）
 *   node scripts/register-bundle.mjs desktop   # 指定 profile
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const BUNDLE = '@dsh-external/dsh-vibe-island';
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const REMOVE = args.includes('--remove');
const explicit = args.find((a) => !a.startsWith('-'));

const HOME = os.homedir();
const PROFILES = path.join(HOME, '.dsh', 'profiles');
const SELF = 'scripts/register-bundle.mjs';
const DEFAULT_PROFILE = 'desktop';

function allProfiles() {
  try {
    return fs.readdirSync(PROFILES, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}

/**
 * 列出宿主的命令行，找 `dsh-desktop-host ... <profiles>/<name>` 里的 name。
 *
 * 跨平台：macOS 用 `ps -ax -o command=`，Windows 用 `wmic process get CommandLine`
 * （Win10+ 自带；本仓库实测受限环境下 wmic 可能被禁，所以两层都做、
 * 任何一层失败都退回「猜默认 profile」而不是抛错）。
 *
 * ⚠️ 这里以前只调 `/bin/ps`：Windows 上该路径不存在 → execFileSync 抛 ENOENT，
 * 被 catch 吞掉 → **永远**退回 'desktop'。多 profile 机器上如果 DSH 跑的是
 * web/headless，就会把登记写进错误的 profile，且脚本全程一声不吭。
 */
function hostCommandLines() {
  const attempts = process.platform === 'win32'
    ? [
        // PowerShell 走 Get-CimInstance（wmic 在新版本 Windows 已废弃）
        { cmd: 'powershell.exe', args: ['-NoProfile', '-Command',
          'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'] },
        { cmd: 'wmic.exe', args: ['process', 'get', 'CommandLine'] },
      ]
    : [{ cmd: '/bin/ps', args: ['-ax', '-o', 'command='] }];

  for (const { cmd, args } of attempts) {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    } catch { /* 换下一个 */ }
  }
  return null;
}

/** 猜 DSH 在跑哪个 profile：宿主进程命令行里带 profiles/<name> 的那个。 */
function detectProfile() {
  if (explicit) return explicit;
  const out = hostCommandLines();
  if (out) {
    const esc = path.join(PROFILES).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const line of out.split('\r?\n')) {
      if (!line.includes('dsh-desktop-host')) continue;
      const m = line.match(new RegExp(esc + '[\\\\/]([^\\\\/\\s]+)'));
      if (m) return m[1];
    }
  }
  // 探测失败/宿主没在跑：不是无声无息，而是提示用户可显式指定。
  console.log('ℹ️  没探测到在跑的 DSH 宿主进程，按约定使用 ' + DEFAULT_PROFILE + '。');
  console.log('   若 DSH 跑的是别的 profile，请显式指定：node ' + path.basename(SELF) + ' <profile>');
  return DEFAULT_PROFILE;
}

/** 复刻宿主 packageDirFromAnchor：按包名在 profile 的 node_modules 下找。 */
function resolves(dir) {
  try {
    const anchor = path.join(dir, 'package.json');
    for (const p of createRequire(anchor).resolve.paths(BUNDLE) || []) {
      if (fs.existsSync(path.join(p, BUNDLE, 'package.json'))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 随包安装后脚本自己在哪 —— 用户手上没有仓库，得指给他实际路径。 */
function installedCopies() {
  const out = [];
  for (const prof of allProfiles()) {
    const p = path.join(PROFILES, prof, 'node_modules', ...BUNDLE.split('/'), SELF);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

/** 别的 profile 也装了同一插件时一并提示（多 profile 场景容易漏）。 */
function otherProfilesWithPlugin() {
  // 注意：要排除**当前正在操作的这个** profile。
  // 之前用 explicit 判断，而它只在用户显式传了 profile 时有值 ——
  // 结果自动探测的情况下会把当前 profile 自己报成「另一个也要登记」。
  return allProfiles().filter((p) => {
    if (p === profile) return false;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(PROFILES, p, 'package.json'), 'utf8'));
      return !!(m.dependencies || {})[BUNDLE];
    } catch { return false; }
  });
}

const profile = detectProfile();
const dir = path.join(PROFILES, profile);

if (!fs.existsSync(dir)) {
  console.error(`❌ 找不到 profile 目录：${dir}`);
  console.error(`   本机现有 profile：${allProfiles().join(', ') || '(无)'}`);
  process.exit(1);
}

const manifestPath = path.join(dir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles || [];
const inBundles = bundles.includes(BUNDLE);
const inDeps = !!(manifest.dependencies || {})[BUNDLE];

console.log(`DSH profile        ${profile}`);
console.log(`插件在 dependencies ${inDeps ? '✅' : '❌'}`);
console.log(`目录可被解析        ${resolves(dir) ? '✅' : '❌'}`);
console.log(`已在 bundles      ${inBundles ? '✅' : '❌  ← 不登记就不会被加载'}`);

if (CHECK) {
  if (inBundles) {
    console.log('\n✅ 已登记。重启 DSH Desktop 即生效。');
    const others = otherProfilesWithPlugin();
    if (others.length) {
      console.log(`   ℹ️  另有 profile 也装了本插件但未检查：${others.join(', ')}`);
      console.log('      每个 profile 的 bundles 是独立的，需要各自登记。');
    }
  } else {
    console.log('\n❌ 未登记。跑这一行（脚本已随插件装好，路径是现成的）：');
    const copies = installedCopies();
    const target = copies[0]
      || path.join(dir, 'node_modules', ...BUNDLE.split('/'), SELF);
    console.log(`   node ${JSON.stringify(target)}`);
    if (copies.length > 1) {
      console.log('\n   其它 profile 里也有一份，按需跑：');
      for (const c of copies.slice(1)) console.log(`   node ${JSON.stringify(c)}`);
    }
    console.log('\n   然后重启 DSH Desktop。');
  }
  process.exit(inBundles ? 0 : 1);
}

if (REMOVE) {
  if (!inBundles) { console.log('\n本来就不在 bundles 里，无需改动。'); process.exit(0); }
  manifest.dsh.profile.bundles = bundles.filter((b) => b !== BUNDLE);
  const backup = manifestPath + '.bak-register';
  fs.copyFileSync(manifestPath, backup);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n✅ 已从 bundles 摘除（依赖仍保留）。备份：${backup}`);
  console.log('   重启 DSH 生效。');
  process.exit(0);
}

if (inBundles) {
  console.log('\n✅ 已在 bundles 里，无需改动。重启 DSH 即生效。');
  process.exit(0);
}

if (!inDeps) {
  console.error('\n❌ 这个 profile 的 dependencies 里没有本插件。');
  console.error('   先在 DSH 的插件页安装：');
  console.error('   git+https://github.com/myYangyunfan/dsh-deepisland.git');
  process.exit(1);
}
if (!resolves(dir)) {
  console.error(`\n❌ 目录解析不到（依赖没装好）。试：cd ${dir} && pnpm install`);
  process.exit(1);
}

manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = [...bundles, BUNDLE];

const backup = manifestPath + '.bak-register';
fs.copyFileSync(manifestPath, backup);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('\n✅ 已加入 dsh.profile.bundles：');
for (const b of manifest.dsh.profile.bundles) console.log('     · ' + b);
console.log(`   备份：${backup}`);
console.log('\n👉 重启 DSH Desktop 后生效。然后确认桥起来了：');
// 这里原来硬编码 macOS 的 ~/Library/Application Support/DSHNotch/bridge.json。
// Windows 上照抄会让人去 cat 一个永远不存在的路径 → 以为桥没起来。
// 必须跟桥客户端用同一套目录推导（见 lib/index.js 的 appDataDir）。
{
  const appData = process.env.APPDATA;
  const bridgeJson = process.platform === 'win32'
    ? path.join(appData || path.join(HOME, 'AppData', 'Roaming'), 'DSHNotch', 'bridge.json')
    : process.platform === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support', 'DSHNotch', 'bridge.json')
      : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'DSHNotch', 'bridge.json');
  console.log('   ' + JSON.stringify(bridgeJson) + '  （存在即桥起来了）');
}
if (process.platform === 'darwin') {
  console.log('   macOS 上还会自动把 DSHNotch.app 装好。');
}
