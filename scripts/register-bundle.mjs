#!/usr/bin/env node
/**
 * 把本插件注册进 DSH profile 的 `dsh.profile.bundles`。
 *
 * ## 为什么需要这个脚本
 *
 * **插件管理器的「安装」只做了一半。** 宿主内置文档原文：
 *
 * > Bundles are npm packages whose manifest declares `"dsh": { "bundle": { "patch":
 * > "./cordis.patch.yml" } }`; the tree is composed by applying each bundle's patch
 * > lists in **`dsh.profile.bundles` order** over an empty entry list, then the
 * > profile's own patches.
 *
 * 而插件管理器实现（asar 内置文档）：
 *
 * > 插件管理器跑 **`pnpm add`**
 *
 * `pnpm add` 只写 `dependencies`，**不会碰 `dsh.profile.bundles`**。
 * 两者是独立字段（`initProfile` 里 `dependencies: {}` 与 `bundles: [...bundles]`
 * 各自初始化，无任何自动合并）。
 *
 * 后果：装完插件后它**不会被加载**，而且宿主对跳过的 bundle
 * **一行提示都不打**（`skippedBundles` 走的是 "nothing is printed"），
 * 所以用户看不到任何报错，只会觉得「装了没反应」。
 *
 * ## 用法
 *
 *   node scripts/register-bundle.mjs              # 自动探测 DSH 在跑哪个 profile
 *   node scripts/register-bundle.mjs desktop      # 指定 profile
 *   node scripts/register-bundle.mjs --check      # 只看状态，不改
 *   node scripts/register-bundle.mjs --remove     # 从 bundles 摘掉（依赖保留）
 *
 * 幂等：已注册就是 no-op。改前自动备份 `package.json`。
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

function say(s) { console.log(s); }

/** 找出 DSH 真正在用的 profile：优先 ps 里的宿主命令行，退回 desktop。 */
function detectProfile() {
  if (explicit) return explicit;
  try {
    const out = execFileSync('/bin/ps', ['-ax', '-o', 'command'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes('dsh-desktop-host')) continue;
      const m = line.match(new RegExp(path.join(PROFILES) + '[\\/]([^\\/\\s]+)'));
      if (m) return m[1];
    }
  } catch { /* ps 受限时走默认 */ }
  return 'desktop';
}

/** profile 是否装了本插件（dependencies 里有）。 */
function hasDependency(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return !!(m.dependencies && m.dependencies[BUNDLE]);
  } catch { return false; }
}

/** 目录能否被宿主的 packageDirFromAnchor 解析到（复刻其逻辑）。 */
function resolves(dir) {
  try {
    const anchor = path.join(dir, 'package.json');
    for (const p of createRequire(anchor).resolve.paths(BUNDLE) || []) {
      if (fs.existsSync(path.join(p, BUNDLE, 'package.json'))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

const profile = detectProfile();
const dir = path.join(PROFILES, profile);

if (!fs.existsSync(dir)) {
  console.error(`❌ profile 不存在：${dir}`);
  process.exit(1);
}

const manifestPath = path.join(dir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles || [];
const inBundles = bundles.includes(BUNDLE);
const inDeps = hasDependency(dir);

say(`DSH profile      ${profile}`);
say(`插件在 dependencies ${inDeps ? '✅' : '❌（先用插件管理器装上）'}`);
say(`目录可被解析       ${resolves(dir) ? '✅' : '❌ 装依赖缺失或路径不对'}`);
say(`已在 bundles     ${inBundles ? '✅' : '❌  ← 这就是它不生效的原因'}`);

if (CHECK) {
  say('');
  say(inBundles
    ? '✅ 已注册。重启 DSH Desktop 生效。'
    : `❌ 未注册。执行：node scripts/register-bundle.mjs ${profile}`);
  process.exit(inBundles ? 0 : 1);
}

if (REMOVE) {
  if (!inBundles) { say('\n本来就不在 bundles 里，无需改动。'); process.exit(0); }
  manifest.dsh.profile.bundles = bundles.filter((b) => b !== BUNDLE);
  const backup = manifestPath + '.bak-register';
  fs.copyFileSync(manifestPath, backup);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  say(`\n✅ 已从 bundles 摘除（依赖仍保留）。备份：${backup}`);
  say('   重启 DSH 生效。');
  process.exit(0);
}

if (inBundles) { say('\n✅ 已在 bundles 里，无需改动。重启 DSH 生效。'); process.exit(0); }

if (!inDeps) {
  console.error('\n❌ profile 的 dependencies 里没有本插件。先在 DSH 插件管理器里安装：');
  console.error('   git+https://github.com/myYangyunfan/dsh-deepisland.git');
  process.exit(1);
}
if (!resolves(dir)) {
  console.error('\n❌ 目录解析不到（依赖没装好）。试：');
  console.error(`   cd ${dir} && pnpm install`);
  process.exit(1);
}

manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = [...bundles, BUNDLE];

const backup = manifestPath + '.bak-register';
fs.copyFileSync(manifestPath, backup);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

say('');
say('✅ 已加入 dsh.profile.bundles：');
for (const b of manifest.dsh.profile.bundles) say('     · ' + b);
say(`   备份：${backup}`);
say('');
say('👉 重启 DSH Desktop 后生效。然后：');
say('   cat ~/Library/Application\\ Support/DSHNotch/bridge.json   # 应出现');
say('   插件在 macOS 上还会自动把 DSHNotch.app 装好。');
