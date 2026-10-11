'use strict';
/**
 * 开发启动器：`npm start` 实际跑的是这个。
 *
 * ## 为什么不能直接 `electron .`
 *
 * 很多 Windows 开发者的终端是**跑在 Electron 应用里的**（VSCode、各种
 * IDE 的内嵌终端）。这类终端会把 `ELECTRON_RUN_AS_NODE=1` 传进子进程。
 * 带着这个变量启动 Electron，它会以**纯 Node 模式**运行：
 *
 * - `require('electron')` 返回的是**二进制路径字符串**，不是 API 对象；
 * - 于是 `const { app } = require('electron')` 拿到 undefined，
 *   报错是「Cannot read properties of undefined」—— 看不出真正原因。
 *
 * 这个坑在排查时能吞掉半小时。所以启动前先把变量删掉。
 *
 * 打包后的 app 不会经过这里，不受影响。
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

delete process.env.ELECTRON_RUN_AS_NODE;

let electronPath;
try {
  electronPath = require('electron');   // 纯 Node 下这返回二进制路径
} catch {
  console.error('[dsh-notch] 找不到 Electron。先装依赖：');
  console.error('  npm install');
  console.error('  npm run electron:install    # Electron >= 42 不再随 postinstall 下载二进制');
  process.exit(1);
}

if (typeof electronPath !== 'string' || !electronPath) {
  console.error('[dsh-notch] require("electron") 没返回路径，环境异常：' + String(electronPath));
  process.exit(1);
}

const appDir = path.join(__dirname, '..');
const r = spawnSync(electronPath, [appDir], { stdio: 'inherit' });
if (r.error) {
  console.error('[dsh-notch] 启动 Electron 失败：' + r.error.message);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
