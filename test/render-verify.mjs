// 在真实浏览器中验证灵动岛渲染（macOS/Win 双风格 + 折叠/展开 + 子代理徽章）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 从真实 client.js 抽取 CSS 落盘（页面侧 file:// fetch 需要同目录可读）
const TMP = path.join(__dirname, '.tmp');
mkdirSync(TMP, { recursive: true });
const clientSrc = readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
const css = clientSrc.match(/const CSS_STYLES = `([\s\S]*?)`;/)[1];
if (!css || css.length < 5000) { console.error('❌ 未能从 client.js 抽取 CSS_STYLES'); process.exit(1); }
writeFileSync(path.join(TMP, 'extracted.css'), css);
// 页面模板复制到 .tmp，使其与 extracted.css 同目录（模板本身保持干净）
writeFileSync(path.join(TMP, 'render-check.html'), readFileSync(path.join(__dirname, 'render-check.html'), 'utf8'));

const CHROME = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PORT = 9224;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-allow-origins=*', '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', '--disable-features=RendererCodeIntegrity',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/vibe-cdp-render`,
  '--window-size=1200,700', '--hide-scrollbars', '--allow-file-access-from-files',
  pathToFileURL(path.join(__dirname,'.tmp','render-check.html')).href,
], { stdio: 'ignore' });

const shot1Path = path.join(TMP,'macos-collapsed.png');
const shot2Path = path.join(TMP,'macos-expanded.png');
const shot3Path = path.join(TMP,'windows-waiting.png');
let ws; const errs = [];
try {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
    if (!page) await sleep(400);
  }
  if (!page) throw new Error('CDP 连接失败');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description?.slice(0,150) || '');
  };
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id:i, method, params })); return new Promise(r => pending.set(i, r)); };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description };
    return JSON.parse(r.result.result.value);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);

  let pass = 0, fail = 0;
  const check = (n, c, e='') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + '  → ' + e); } };

  console.log('\n=== R1: 真实 CSS 加载 ===');
  // file:// 下 cssRules 会被 CORS 拦（读不到内容但样式已生效，R2-R4 的计算样式即为证据）。
  // 这里直接 fetch 原始 CSS 文本验证内容完整性。
  const css = await evaluate(`(async () => {
    const txt = await (await fetch('extracted.css')).text();
    return JSON.stringify({ len: txt.length,
      hasRoot: txt.includes('dsh-vibe-island-root'), hasMac: txt.includes('platform-macos'),
      hasWin: txt.includes('backdrop-filter'), hasSubagent: txt.includes('vibe-subagent-badge'),
      braces: (txt.match(/{/g)||[]).length === (txt.match(/}/g)||[]).length,
      ruleCount: (txt.match(/}/g)||[]).length });
  })()`);
  console.log('  CSS 原始长度: ' + css.len + ' | 规则数: ' + css.ruleCount);
  check('CSS 已加载且非空', css.len > 5000, String(css.len));
  check('含 #dsh-vibe-island-root 规则', css.hasRoot);
  check('含 macOS 皮肤规则', css.hasMac);
  check('含 Windows 毛玻璃规则', css.hasWin);
  check('含新增子代理徽章样式', css.hasSubagent);
  check('花括号配对', css.braces);

  console.log('\n=== R2: macOS 折叠态（tool 状态 + 子代理）===');
  const mac = await evaluate(`(() => {
    const p = document.querySelector('.vibe-island-pill');
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    return JSON.stringify({
      cls: p.className, w: Math.round(r.width), h: Math.round(r.height),
      title: document.querySelector('.vibe-compact-title')?.textContent,
      dot: document.querySelector('.vibe-indicator-dot')?.className,
      timer: document.querySelector('.vibe-compact-timer')?.textContent,
      badges: [...document.querySelectorAll('.vibe-compact-badge')].map(e=>e.textContent),
      glow: !!document.querySelector('.vibe-island-glow.glow-tool'),
      bg: cs.backgroundColor, radius: cs.borderBottomLeftRadius, radiusTop: cs.borderTopLeftRadius,
      wrapperTop: getComputedStyle(document.querySelector('.vibe-island-wrapper')).top,
    });
  })()`);
  console.log('  ' + JSON.stringify(mac, null, 2).split('\n').join('\n  '));
  check('胶囊已渲染', mac.h > 0 && mac.w > 0, `${mac.w}x${mac.h}`);
  check('折叠态高度 34px', mac.h === 34, mac.h + 'px');
  check('宽度 200-250px', mac.w >= 200 && mac.w <= 250, mac.w + 'px');
  check('状态类含 tool + platform-macos', /dot-tool/.test(mac.dot) && /platform-macos/.test(mac.cls), mac.cls);
  check('标题为「执行 bash」', mac.title === '执行 bash', mac.title);
  check('计时器显示 01:05', mac.timer === '01:05', mac.timer);
  check('子代理徽章 👥 3 存在', mac.badges.includes('👥 3'), JSON.stringify(mac.badges));
  check('工具徽章 bash 存在', mac.badges.includes('bash'), JSON.stringify(mac.badges));
  check('工具光晕已激活', mac.glow);
  check('macOS 皮肤：底部圆角 18px', mac.radius === '18px', mac.radius);
  check('macOS 皮肤：顶部圆角 0', mac.radiusTop === '0px', mac.radiusTop);
  check('macOS 皮肤：纯黑底', mac.bg === 'rgb(0, 0, 0)', mac.bg);

  const pr1 = await evaluate(`(() => { const r=document.querySelector('.vibe-island-pill').getBoundingClientRect(); return JSON.stringify({x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}); })()`); const c1=pr1; console.log('  pill rect: '+JSON.stringify(c1)); const shot1 = await send('Page.captureScreenshot', { format:'png', clip:{ x:c1.x-24, y:c1.y-24, width:c1.w+48, height:c1.h+48, scale:3 } });
  writeFileSync(path.join(__dirname,'.tmp','macos-collapsed.png'), Buffer.from(shot1.result.data, 'base64'));

  console.log('\n=== R3: 展开 HUD ===');
  await evaluate(`(() => { window.__render(document.getElementById('dsh-vibe-island-root'),
    { status:'tool', title:'执行 bash', currentTool:'bash', elapsed:65, toolCount:4, subagentCount:3,
      expanded:true, platform:'platform-macos', placement:'notch' }); return 1; })()`);
  await sleep(600);
  const hud = await evaluate(`(() => {
    const p = document.querySelector('.vibe-island-pill');
    const r = p.getBoundingClientRect();
    return JSON.stringify({
      expanded: p.className.includes('state-expanded'), w: Math.round(r.width), h: Math.round(r.height),
      badge: document.querySelector('.vibe-hud-badge-status')?.textContent,
      code: document.querySelector('.vibe-hud-code')?.textContent,
      stats: [...document.querySelectorAll('.vibe-hud-stat-item')].map(e=>e.textContent),
    });
  })()`);
  console.log('  ' + JSON.stringify(hud, null, 2).split('\n').join('\n  '));
  check('切换到展开态', hud.expanded);
  check('展开尺寸 440x146', hud.w === 440 && hud.h === 146, `${hud.w}x${hud.h}`);
  check('状态徽章 Executing Tool', hud.badge === 'Executing Tool', hud.badge);
  check('命令代码块显示', hud.code === 'ls -la /tmp', hud.code);
  check('工具调用统计 4 次', hud.stats.some(s=>s.includes('4 次')), JSON.stringify(hud.stats));
  check('子代理统计 3 并行', hud.stats.some(s=>s.includes('3 并行')), JSON.stringify(hud.stats));

  const pr2 = await evaluate(`(() => { const r=document.querySelector('.vibe-island-pill').getBoundingClientRect(); return JSON.stringify({x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}); })()`); const c2=pr2; const shot2 = await send('Page.captureScreenshot', { format:'png', clip:{ x:c2.x-24, y:c2.y-24, width:c2.w+48, height:c2.h+48, scale:2 } });
  writeFileSync(path.join(__dirname,'.tmp','macos-expanded.png'), Buffer.from(shot2.result.data, 'base64'));

  console.log('\n=== R4: Windows Fluent 皮肤 + waiting 状态 ===');
  const win = await evaluate(`(() => {
    window.__render(document.getElementById('dsh-vibe-island-root'),
      { status:'waiting', title:'等待人工确认', currentTool:'ask', elapsed:12, toolCount:1, subagentCount:0,
        expanded:false, platform:'platform-windows', placement:'floating' });
    const p = document.querySelector('.vibe-island-pill');
    const cs = getComputedStyle(p);
    const w = document.querySelector('.vibe-island-wrapper');
    return JSON.stringify({ cls:p.className, radius:cs.borderRadius, bg:cs.backgroundColor,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      dot: document.querySelector('.vibe-indicator-dot')?.className,
      glow: !!document.querySelector('.vibe-island-glow.glow-waiting'),
      wrapperTop: getComputedStyle(w).top, hasActive: p.className.includes('has-active'),
      badges: [...document.querySelectorAll('.vibe-compact-badge')].map(e=>e.textContent) });
  })()`);
  await sleep(400);
  console.log('  ' + JSON.stringify(win, null, 2).split('\n').join('\n  '));
  check('Windows 皮肤：全圆角 9999px', win.radius === '9999px', win.radius);
  check('Windows 皮肤：亚克力半透明底', /rgba\(18, 18, 24, 0\.88\)/.test(win.bg), win.bg);
  check('Windows 皮肤：backdrop-filter 模糊', /blur\(24px\)/.test(win.backdrop || ''), win.backdrop);
  check('waiting 状态琥珀点', /dot-waiting/.test(win.dot), win.dot);
  check('waiting 光晕激活', win.glow);
  check('placement-floating 偏移 12px', win.wrapperTop === '12px', win.wrapperTop);
  check('无子代理时不显示徽章', !win.badges.some(b=>b.includes('👥')), JSON.stringify(win.badges));

  const pr3 = await evaluate(`(() => { const r=document.querySelector('.vibe-island-pill').getBoundingClientRect(); return JSON.stringify({x:r.x+scrollX,y:r.y+scrollY,w:r.width,h:r.height}); })()`); const c3=pr3; const shot3 = await send('Page.captureScreenshot', { format:'png', clip:{ x:c3.x-24, y:c3.y-24, width:c3.w+48, height:c3.h+48, scale:3 } });
  writeFileSync(path.join(__dirname,'.tmp','windows-waiting.png'), Buffer.from(shot3.result.data, 'base64'));

  console.log('\n=== R5: 页面错误 ===');
  const errRes = await send('Runtime.evaluate', { expression: `(window.__errors || []).length`, returnByValue: true });
  const errCount = errRes.result?.result?.value;
  check('页面无 JS 运行时错误', errCount === 0, 'count=' + errCount);
  const realErrs = errs.filter(e => e && !/favicon|net::ERR_FILE/.test(e));
  check('无 CDP 捕获异常', realErrs.length === 0, JSON.stringify(realErrs.slice(0, 2)));

  console.log('\n' + '='.repeat(48));
  console.log('渲染验证: 通过 ' + pass + ' / 失败 ' + fail);
  console.log('='.repeat(48));
  console.log('\n📸 截图:');
  console.log('   test/.tmp/macos-collapsed.png   (macOS 折叠 + 子代理徽章)');
  console.log('   test/.tmp/macos-expanded.png    (展开 HUD)');
  console.log('   test/.tmp/windows-waiting.png   (Windows Fluent + waiting)');
} catch (e) {
  console.error('失败: ' + e.message);
} finally {
  try { ws && ws.close(); } catch {}
  child.kill('SIGKILL');
}
