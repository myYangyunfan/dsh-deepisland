'use strict';
// 把 windows/ 下的新源码打成 app.asar（替代 electron-builder 的打包，避开本机 MITM 代理下载证书问题）。
// 用法: node scripts/make-asar.js [输出路径]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'app.asar');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notch-asar-'));

// 与 package.json 的 build.files 保持一致：src/**/*、assets/**/*、package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.build;
delete pkg.scripts;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
};
copyDir(path.join(ROOT, 'src'), path.join(stage, 'src'));
copyDir(path.join(ROOT, 'assets'), path.join(stage, 'assets'));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
asar.createPackage(stage, OUT).then(() => {
  fs.rmSync(stage, { recursive: true, force: true });
  const size = fs.statSync(OUT).size;
  console.log('app.asar 已生成:', OUT, '(' + (size / 1024).toFixed(1) + ' KB)');
  // 列一下确认关键文件都在
  const list = asar.listPackage(OUT).filter((p) => /snapshot\.js|renderer\.js|styles\.css|main\.js|index\.html/.test(p));
  console.log('关键文件:', list.join(', '));
}).catch((e) => { console.error('生成失败:', e); process.exit(1); });
