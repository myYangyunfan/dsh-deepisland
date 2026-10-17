const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

async function main() {
  console.log('=== 开始构建最新灵动岛并更新本地运行环境 ===');

  const root = path.resolve(__dirname, '..');
  const asarCli = path.join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  const tempDir = path.join(root, 'dist', '_temp_app');
  const outAsar = path.join(root, 'dist', 'app.asar');

  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  // 复制 src, assets, package.json
  console.log('1. 复制最新源码与静态资源...');
  fs.cpSync(path.join(root, 'src'), path.join(tempDir, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'assets'), path.join(tempDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(tempDir, 'package.json'));

  console.log('2. 打包生成 app.asar...');
  execSync(`node "${asarCli}" pack "${tempDir}" "${outAsar}"`, { stdio: 'inherit' });
  const asarStat = fs.statSync(outAsar);
  console.log(`✓ 成功生成 app.asar (${(asarStat.size / 1024).toFixed(1)} KB)`);

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    console.error('未找到 LOCALAPPDATA 环境变量');
    return;
  }
  const appDir = path.join(localAppData, 'Programs', 'DSHNotch');
  const targetAsar = path.join(appDir, 'resources', 'app.asar');
  const exePath = path.join(appDir, 'DSHNotch.exe');

  if (!fs.existsSync(targetAsar)) {
    console.warn(`未检测到已安装的目标路径: ${targetAsar}，跳过原地热更。`);
    return;
  }

  console.log('3. 关闭运行中的 DSHNotch 进程...');
  try {
    execSync('taskkill /F /IM DSHNotch.exe', { stdio: 'ignore' });
  } catch {}
  // 等待进程完全退出
  await new Promise(r => setTimeout(r, 800));

  console.log('4. 替换目标 app.asar...');
  fs.copyFileSync(outAsar, targetAsar);
  console.log(`✓ 已成功替换: ${targetAsar}`);

  console.log('5. 重新启动 DSHNotch 灵动岛...');
  const child = spawn(exePath, [], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  console.log('✓ DSHNotch 已以最新内核重新启动并常驻！');
  console.log('=== 本地热更完成 ===');
}

main().catch(err => {
  console.error('更新失败:', err);
  process.exit(1);
});
