// 插件能否被 DSH 加载的**前置条件**自检。
//
// 背景：插件管理器的「安装」只跑 pnpm add，只写 dependencies；
// 而宿主按 dsh.profile.bundles 顺序叠 patch 树。光装完不登记 = 不会被加载，
// 且宿主对跳过的 bundle 一行提示都不打。这些都属于「配错就静默失效」，
// 必须有断言守着。
//
// 用法: node test/run.mjs mount
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = '@dsh-external/dsh-vibe-island';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + '  → ' + extra); }
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh.plugin.json'), 'utf8'));
const patchYml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');

console.log('\n=== T1: manifest 声明齐全（宿主读的就是这些）===');
// 依据 asar 内置文档：bundle 需声明 dsh.bundle.patch，客户端需声明 dsh.client.platform
check('package.json 有 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml',
  JSON.stringify(pkg.dsh?.bundle));
check('package.json 有 dsh.client.platform', pkg.dsh?.client?.platform === 'web',
  JSON.stringify(pkg.dsh?.client?.platform));
check('声明了 ./client 导出（客户端半边的入口）',
  pkg.exports?.['./client']?.default === './lib/client.js', JSON.stringify(pkg.exports));
check('type=module（宿主按 ESM 加载）', pkg.type === 'module', pkg.type);
check('dsh.plugin.json 的 main 指向服务端半边',
  pluginJson.main === './lib/index.js', pluginJson.main);
check('cordis.patch.yml 真的存在（bundle.patch 指向它）', fs.existsSync(path.join(ROOT, 'cordis.patch.yml')));
check('cordis.patch.yml 把自己 insert 进树',
  patchYml.includes('name:') && patchYml.includes(BUNDLE), patchYml.slice(0, 80).replace(/\n/g, " | "));

// 🔴 查证结论：宿主**根本不读 dsh.plugin.json**（asar 里出现 0 次）——
// 那是给人看的说明文件，不参与加载。所以「树里的 id 从哪来」只有一个答案：
// cordis.patch.yml 的 insert 条目。dsh.plugin.json 的 id 与它不一致时**不影响加载**，
// 但会让人误判，故此处只提示、不判失败。
{
  const treeId = /id:\s*(\S+)/.exec(patchYml)?.[1] || '(没写 id)';
  const same = pluginJson.id === treeId;
  check('cordis.patch.yml 的 insert 写了 id', treeId !== '(没写 id)', treeId);
  if (!same) {
    console.log(`     ℹ️  dsh.plugin.json 的 id（${pluginJson.id}）与 patch 树里的 id（${treeId}）不同。`);
    console.log('        这是**正常的**：宿主不读 dsh.plugin.json，加载只看 cordis.patch.yml。');
  } else {
    check('两处 id 一致（读起来不让人困惑）', true);
  }
}

// ---- T2: 宿主兼容性检查会不会把插件跳过 --------------------------------
console.log('\n=== T2: peerDependencies 兼容性（宿主会跳过不满足的 bundle）===');
// 宿主 evaluatePluginCompatibility：只检查名字以 @deepseek-ai/dsh- 开头的 peer，
// 要求 semver.satisfies(runtimeVersion, range)。对 prerelease 也生效。
{
  const peers = Object.entries(pkg.peerDependencies || {});
  const checked = peers.filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'));
  check('peerDependencies 是对象', Array.isArray(checked));
  for (const [n, r] of checked) {
    // "*" / "workspace:*" 对任意版本都满足（含 0.2.0-rc.2 这种 prerelease）
    const safe = r === '*' || r === 'workspace:*' || r === 'workspace:^' || r === 'workspace:~';
    check(`peer ${n} = "${r}" 不会被兼容性检查拦下`, safe,
      '写成具体版本号会在宿主版本不匹配时整个 bundle 被跳过（且无提示）');
  }
  // engines 字段宿主**不读**（跳过只看 peerDependencies）。它只是给 pnpm 看的，
  // 写窄了不会导致 bundle 被跳过，所以这里只记录事实、不作断言。
  console.log(`     ℹ️  engines.dsh = ${JSON.stringify(pkg.engines)} —— 宿主不读这个字段（仅 pnpm 用），`);
  console.log(`        bundle 是否被跳过只看上面那些 peerDependencies。`);
}

// ---- T3: inject 纪律（写错会让插件永久 pending）------------------------
console.log('\n=== T3: inject 只声明必定存在的服务 ===');
{
  const clientSrc = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
  const m = clientSrc.match(/exports\.inject\s*=\s*\[([^\]]*)\]/);
  check('找得到 exports.inject', !!m);
  const list = (m ? m[1] : '').split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean);
  check('inject 里有 slots 与 sessions', list.includes('slots') && list.includes('sessions'), list.join(','));
  // 这两个曾把我们坑到：settingsScope 在 asar 出现 0 次；uiWorkspace 是运行时探测的
  check('inject 不含 settingsScope（宿主 asar 里 0 次出现）', !list.includes('settingsScope'), list.join(','));
  check('inject 不含 configForms（可被 profile 禁用 → 会永久 pending）', !list.includes('configForms'));
  check('inject 不含 uiWorkspace（必须运行时 ctx.get 探测）', !list.includes('uiWorkspace'));
  check('uiWorkspace 确实是运行时探测的', /ctx\.get\(\s*["']uiWorkspace["']\s*\)/.test(clientSrc));
}

// ---- T4: 本机 profile 的实际注册状态 ------------------------------------
console.log('\n=== T4: 本机 profile 注册状态（回答「装完能不能直接用」）===');
{
  const profilesDir = path.join(os.homedir(), '.dsh', 'profiles');
  let profile = 'desktop';
  // 宿主进程命令行第 4 段是 profile 路径
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('/bin/ps', ['-ax', '-o', 'command'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes('dsh-desktop-host')) continue;
      const mm = line.match(new RegExp(path.join(profilesDir) + '[\\/]([^\\/\\s]+)'));
      if (mm) { profile = mm[1]; break; }
    }
  } catch { /* ps 受限 → 用默认 */ }

  const dir = path.join(profilesDir, profile);
  console.log(`     DSH 在跑的 profile：${profile}`);

  if (!fs.existsSync(dir)) {
    check('profile 目录存在', false, dir);
  } else {
    check('profile 目录存在', true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const inDeps = !!(manifest.dependencies || {})[BUNDLE];
    const bundles = manifest.dsh?.profile?.bundles || [];
    const inBundles = bundles.includes(BUNDLE);

    check('插件装在 dependencies 里', inDeps,
      '还没装 —— 先在 DSH 插件管理器输入 git+https://github.com/myYangyunfan/dsh-deepisland.git');

    // 复刻宿主 packageDirFromAnchor：按包名在 node_modules 下找
    let resolvable = false;
    try {
      const anchor = path.join(dir, 'package.json');
      for (const p of createRequire(anchor).resolve.paths(BUNDLE) || []) {
        if (fs.existsSync(path.join(p, BUNDLE, 'package.json'))) { resolvable = true; break; }
      }
    } catch { /* ignore */ }
    check('目录能被宿主的解析逻辑找到', resolvable, '依赖没装好，试 cd ' + dir + ' && pnpm install');

    check('已登记进 dsh.profile.bundles（否则不会被加载，且无任何提示）', inBundles,
      '跑 node scripts/register-bundle.mjs ' + profile);

    if (!inBundles) {
      console.log('');
      console.log('     ⚠️  当前这台机器上插件【不会被加载】：');
      console.log('        插件管理器的安装只跑 pnpm add（只写 dependencies），');
      console.log('        而宿主按 dsh.profile.bundles 顺序叠 patch 树，且跳过时一行提示都不打。');
      console.log('        补登记：node scripts/register-bundle.mjs ' + profile);
    }
  }
}

// ---- T5: 登记脚本必须随包发布，且双击路径可用 --------------------------
console.log('\n=== T5: 登记脚本（用户唯一要做的动作）===');
{
  // 装插件的人手上**没有仓库**，只有 profile 里的插件目录。
  // 脚本不在 files 里 = 用户根本跑不到它，这一步就等于不存在。
  check('package.json 的 files 含 scripts（脚本要随包装走）',
    Array.isArray(pkg.files) && pkg.files.includes('scripts'), JSON.stringify(pkg.files));

  const s1 = path.join(ROOT, 'scripts', 'register-bundle.mjs');
  const s2 = path.join(ROOT, 'scripts', 'setup.command');
  check('scripts/register-bundle.mjs 存在', fs.existsSync(s1));
  check('scripts/setup.command 存在（双击即可，不必开终端）', fs.existsSync(s2));

  if (fs.existsSync(s1)) {
    const src = fs.readFileSync(s1, 'utf8');
    check('登记脚本认得插件包名', src.includes(BUNDLE));
    // 用户只有插件目录，脚本必须能自己算出「你该跑哪一行」
    check('脚本会打印可直接复制的插件目录路径（用户没有仓库）',
      /installedCopies|node_modules/.test(src) && src.includes('node '),
      '缺少「告诉我跑哪条」的输出');
    check('脚本支持 --check（只查不改）', src.includes('--check'));
    check('脚本支持 --remove（可撤销）', src.includes('--remove'));
    check('改前会备份 package.json', /bak-register/.test(src));
    check('幂等（已在 bundles 里就不重复添加）', /已在 bundles 里，无需改动/.test(src));
  }

  if (fs.existsSync(s2)) {
    const sh = fs.readFileSync(s2, 'utf8');
    // 脚本必须走官方 CLI 的 remove → add cycle，而不是手改 JSON。
    // 原因：宿主 CLI 只同步「本次新增」的依赖（源码里
    // `for (const name of dependencies) { if (beforeDeps.has(name)) continue; … }`），
    // 对「已在 dependencies、不在 bundles」的插件直接 add 会被
    // "Already up to date" 跳过。先 remove 让它变成未安装，add 才是真新增。
    if (fs.existsSync(s2)) {
      const sh2 = fs.readFileSync(s2, "utf8");
      check("setup.command 调用宿主官方 CLI（官方支持的增删入口）",
        sh2.includes("plugin --profile") && sh2.includes("add"), "没找到 CLI 调用");
      check("setup.command 先 remove 再 add（绕过 Already up to date 跳过）",
        /remove[\s\S]{0,400}add/.test(sh2) || /remove.*\n.*add/.test(sh2),
        "缺少 remove → add 的顺序");
      check("setup.command 登记后自己核对结果（CLI 不会报告 bundles 是否同步）",
        /in_bundles/.test(sh2), "没有核对逻辑");
      check("CLI 失败时有兜底（直接改 manifest）", sh2.includes("bak-register"));
    }

    check('setup.command 是可执行的（双击才会跑）',
      (fs.statSync(s2).mode & 0o111) !== 0,
      'mode=' + (fs.statSync(s2).mode & 0o777).toString(8));
    check('setup.command 自己找 profile（不要求用户填）',
      /dsh-desktop-host/.test(sh) && /PROFILES/.test(sh));
    check('setup.command 提示要重启 DSH', /重启/.test(sh));
    // 中文文件名在部分工具链下会显示成问号，这里守 ASCII 文件名
    check('文件名是纯 ASCII（避免编码环境下的显示问题）', /^[\x20-\x7e]+$/.test(path.basename(s2)),
      path.basename(s2));
  }
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
globalThis.__results = globalThis.__results || {};
globalThis.__results.mount = { pass, fail };
