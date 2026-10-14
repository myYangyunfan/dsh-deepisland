// 「插件装完就能用」这条链路在 Windows 上的自检。
//
// 这段逻辑散在两个进程里（主进程的 bringDshToFront、渲染层的设置入口），
// 都碰不到纯 Node 测试。这里用**源码断言 + 契约断言**两条腿验：
//   1. 契约：preload 暴露的名字必须与主进程 ipcMain.handle 注册的名字逐个对上。
//      这两个文件由不同的人在不同时间改，写错一个字母的症状是「点了没反应」，
//      而运行时**不报任何错** —— 只有断言能拦住。
//   2. 源码：renderer 引用的每一个 window.island.X 都必须真的存在。
//
// 用法: node windows/test/setup-entry.test.js
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const preload = read('preload.js');
const main = read('main.js');
const renderer = read('renderer.js');
const styles = read('styles.css');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/** 从源码里抽出被引用的 ipc 通道名（单引号/双引号两种写法都算）。 */
function channels(text) {
  const out = new Set();
  const re = /['"](island:[a-z-]+)['"]/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
}

/** preload 暴露到 window.island 上的方法名。 */
function exposedMethods() {
  const out = new Set();
  // 既有 `name() {` 形式，也有 `name: () =>` 形式
  const re = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*[(:]/gm;
  const body = preload.slice(preload.indexOf('exposeInMainWorld'));
  let m;
  while ((m = re.exec(body))) out.add(m[1]);
  return out;
}

console.log('=== S1: 通道名必须两边一致 ===');
{
  const handled = channels(main);
  const used = channels(preload);
  check('主进程注册了 island:open-dsh', handled.has('island:open-dsh'), [...handled].join(', '));
  const missing = [...used].filter((c) => !handled.has(c));
  check('preload 用到的每个通道主进程都注册了', missing.length === 0, '缺：' + missing.join(', '));
  const orphan = [...handled].filter((c) => !used.has(c));
  check('主进程没有多余的空转通道', orphan.length === 0, '多余：' + orphan.join(', '));
}

console.log('\n=== S2: 渲染层引用的方法必须真的暴露了 ===');
{
  const exposed = exposedMethods();
  const called = new Set();
  const re = /window\.island\.([a-zA-Z][a-zA-Z0-9]*)/g;
  let m;
  while ((m = re.exec(renderer))) called.add(m[1]);
  check('渲染层确实调了桥外的方法', called.size > 0, [...called].join(', '));
  const missing = [...called].filter((n) => !exposed.has(n));
  check('每个调用都在 preload 里暴露过', missing.length === 0, '缺：' + missing.join(', '));
  check('渲染层用上了 openDsh（设置入口真的接上了）', called.has('openDsh'), [...called].join(', '));
}

console.log('\n=== S3: 「设置」入口必须看得见、点得到 ===');
{
  check('页脚渲染出 data-act="settings"', /data-act="settings"/.test(renderer));
  check('绑定了它的点击', /data-act\s*=\s*"settings"\]/.test(renderer) || /\[data-act="settings"\]/.test(renderer));
  // 岛整体是 -webkit-app-region: drag，可点元素若不显式排除，
  // 点下去会被当成「拖窗口」而不是「点击」——这个 bug 在无边框窗口里很隐蔽。
  check('可点样式显式排除拖拽区', /\.footer \.link[\s\S]{0,240}-webkit-app-region:\s*no-drag/.test(styles),
    '样式里没有 no-drag');
  check('有 hover 反馈（否则用户不知道它能点）', /\.footer \.link:hover/.test(styles));
}

console.log('\n=== S4: 做不到的事不许说成做到了 ===');
{
  // bringDshToFront 依赖 DSH 自己实现了单实例锁，本仓库无法验证。
  // 所以它必须返回「用了哪条路」，让界面能如实说话。
  check('bringDshToFront 返回 ok/how', /function bringDshToFront\(\)[\s\S]{0,1400}return \{ ok:/.test(main));
  check('单实例那条路如实标注为未验证',
    /single-instance/.test(main) && /无法验证|未验证/.test(main), '没写清限制');
  // 反向断言：不能出现「已打开设置」这种一定为真的文案。
  // 只看会被渲染的字符串字面量（注释里举例说明不算）。
  const renderedStrings = (renderer.match(/'[^'\n]*'|"[^"\n]*"/g) || []).join('\n');
  check('没有写死「已打开设置」这类必然为真的提示', !/已打开设置/.test(renderedStrings));
  check('成功与失败两种提示是分开的',
    /已切到 DSH/.test(renderedStrings) && /DSH 设置\s*→\s*🏝️/.test(renderedStrings),
    '提示没有区分两种情况');
}

console.log('\n=== S5: 托盘里也有同一个入口 ===');
{
  check('托盘菜单有打开 DSH 设置项', /打开 DSH 设置/.test(main));
  check('它调用的是同一个函数（不存在两套实现）',
    (main.match(/bringDshToFront\(/g) || []).length >= 2,
    '调用处数量 = ' + (main.match(/bringDshToFront\(/g) || []).length);
}

console.log('\n=== S6: 插件的 Windows 自动安装分支仍然在 ===');
{
  const lib = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'index.js'), 'utf8');
  check("win32 走 ensureWindowsAppInstalled", /platform === 'win32'[\s\S]{0,200}ensureWindowsAppInstalled/.test(lib));
  check('资产名按平台分叉', /DSHNotch-' \+ ver \+ '-win-'/.test(lib), '资产名没分叉');
  check('darwin 分支没被改动', /if \(platform !== 'darwin'\)[\s\S]{0,120}未支持的平台/.test(lib));
}

console.log('\n=== S7: 快照字段必须容缺（否则首帧白屏）===');
// 这条是被真机验证逼出来的：喂一份缺 config 的快照，
// 渲染进程抛 `Cannot read properties of undefined (reading 'scale')`，
// 岛整个白屏 —— 但窗口还在、进程还在，日志只有一行红字，
// 症状看起来像「装了插件没反应」，极难定位。
//
// 真正的快照（main.js 的 snapshot()）一定带 config，
// 所以纯逻辑自检**测不到**这个 bug —— 只能钉住「不许裸取」。
{
  // 提取 render / shouldExpand 两个函数的源码块
  function fnBody(name) {
    const i = renderer.indexOf('function ' + name);
    if (i < 0) return '';
    // 粗略取到下一个顶层 function 为止
    const rest = renderer.slice(i + 1);
    const j = rest.search(/\n\s{2}function\s+\w/);
    return j < 0 ? rest : rest.slice(0, j);
  }
  const body = fnBody('render') + fnBody('shouldExpand');
  check('找到了这两个函数的源码', body.length > 100, '长度 ' + body.length);
  // 先剥掉注释再查 —— 否则「不许裸取」这句注释里的举例 `snap.config.scale`
  // 会把自己判成违规（第一版就踩了这个：注释被当成代码，全红）。
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('代码里不许出现 snap.config.xxx 形式的裸取',
    !/snap\.config\./.test(code),
    '命中：' + (code.match(/snap\.config\.\w+/g) || []).join(', '));
  check('注释里确实写了这条规则（说明是刻意的，不是巧合）',
    /snap\.config\.scale/.test(body));
  check('config 取值统一走兜底（snap && snap.config || {}）',
    /\(snap && snap\.config\) \|\| \{\}/.test(body));
  check('scale 有默认值 1（兜底路径不会写出 --scale: undefined）',
    /cfg\.scale \|\| 1/.test(body));
}

console.log('\n=== S8: 窗口架构契约（固定最大窗口 + 穿透 + 顶端贴屏） ===');
// macOS 版丝滑的来源是「窗口按最大展开态开好、内容在窗口里动画」。
// Windows 版照搬这条后，任何一处退回「窗口跟内容跑」的老路都会把
// 动画重新拖进 DWM 的抖动里，所以逐条钉住：
//   main.js     窗口尺寸恒为 MAX_WINDOW、y = workArea.y、穿透为常态
//   index.html  岛顶对齐居中（没有 .neck —— 窗口顶=屏顶，无需连接器）
//   styles.css  顶平方角（border-radius 0 0 …）、弹簧时长与 Swift 对齐
//   preload.js  island:set-interactive 与主进程对上（S1 已查通道一致）
{
  const html = read('index.html');

  check('main.js 定义固定窗口尺寸 MAX_WINDOW', /const MAX_WINDOW = \{ w: \d+, h: \d+ \}/.test(main));
  check('窗口 y 与工作区顶端重合（顶边方角落在屏幕边界上）',
    /const y = area\.y;/.test(main), '应是 area.y，不留顶部 bleed');
  check('穿透为常态：创建后 setIgnoreMouseEvents(true, {forward:true})',
    /setIgnoreMouseEvents\(true, \{ forward: true \}\)/.test(main));
  check('渲染层可临时接管：island:set-interactive → setIgnoreMouseEvents(!value)',
    /'island:set-interactive'[\s\S]{0,300}setIgnoreMouseEvents\(!value, \{ forward: true \}\)/.test(main));
  check('没有旧的逐帧尺寸通道（island:resize 已随架构移除）',
    !/island:resize/.test(main) && !/island:resize/.test(preload));
  check('没有旧的展开状态通道（island:expand 已随架构移除）',
    !/island:expand/.test(main) && !/island:expand/.test(preload));

  check('岛在窗口里顶端居中（body flex + align-items:flex-start）',
    /html, body\s*\{[\s\S]{0,600}?display: flex/.test(styles)
      && /align-items: flex-start/.test(styles)
      && /justify-content: center/.test(styles));
  check('index.html 已无 .neck（窗口顶=屏顶，连接器失去存在理由）',
    !/class="neck"/.test(html));

  // 形状：顶平 + 底圆角。对齐 swift/UI/NotchShape.swift 的结论。
  check('岛本体只有底部圆角（顶部方角贴屏幕顶边）',
    /border-radius:\s*0 0 var\(--r-collapsed\)/.test(styles),
    (styles.match(/border-radius:[^;]*/) || [''])[0]);

  // 渲染层：data-expanded 是 CSS 形变的驱动源
  check('render() 写 data-expanded（否则形变不触发）',
    /island\.dataset\.expanded = expanded \? '1' : '0'/.test(renderer));
  check('CSS 有[data-expanded="1"] 的展开态样式',
    /\[data-expanded="1"\]/.test(styles));
  check('过渡时长与 Swift 的 .spring(response:0.34) 对齐',
    /--spring-ms:\s*340ms/.test(styles), 'Swift 侧是 0.34s');
  check('圆角口径与 Mac 一致（折叠 12 / 展开 20）',
    /--r-collapsed:\s*12px/.test(styles) && /--r-expanded:\s*20px/.test(styles));
}

console.log('\n=== S9: 桥的 pending 必须一路透传到界面 ===');
// 「用户点了会话、DSH 没切过去」是 Windows 端最难自查的故障：
// 界面上一切正常，没有任何报错。此时唯一的线索就是桥队列里的 pending。
// 以前 bridge.health() 把服务端返回的 pending 丢了，这条线索就断了，
// 于是托盘菜单和岛上的页脚都只显示「已连上」——
// 「正常」和「点击没生效」长得一模一样。
{
  const bridge = read('bridge.js');
  check('health() 透传 pending',
    /pending:\s*obj && typeof obj\.pending === 'number'/.test(bridge));
  check('health() 也透传 version（判断跑的是不是新插件）',
    /version:\s*obj && obj\.version/.test(bridge));
  check('主进程判定「需要刷新」时把 pending 算进去',
    /r\.pending \|\| 0\) !== \(bridgeState\.pending \|\| 0\)/.test(main));
  check('托盘菜单显示待处理条数',
    /条待处理/.test(main));
  check('岛页脚在有待处理时给出橙色提示',
    /class="pending"/.test(renderer));
  check('.pending 用告警色（区别于绿色的正常态）',
    /\.pending\s*\{[^}]*color:\s*#FFAA00/.test(styles));
}

console.log('\n=== S10: 交互与动效契约（Mac 对齐口径） ===');
// 设计口径逐条来自 swift/UI/NotchContentView.swift，失配的症状全是
// 「看起来不如 Mac」而非报错，所以用源码断言钉死：
//   - 驻留 200/350（Mac 0.2s 展开 / 0.35s 收起）
//   - 等待确认自动展开（Mac 同款）
//   - 穿透切换靠转发 mousemove 的命中判定（窗口大、岛小，热区必须按岛算）
//   - 高度弹簧写在 .island 上，窗口不动
//   - 光效 = 顶部内发光带 + 沿剪影外发光，受 glowEffect 门控
{
  check('悬停驻留与 Mac 同档（开 200ms / 收 350ms）',
    /HOVER_OPEN_MS = 200/.test(renderer) && /HOVER_CLOSE_MS = 350/.test(renderer));
  check('「等待确认」自动展开（与 macOS 版同一条纪律）',
    /entries\[0\]\.status === 'waiting'/.test(renderer));

  check('渲染层用岛的当前矩形做命中（不是拿窗口当热区）',
    /function hitIsland/.test(renderer) && /getBoundingClientRect\(\)/.test(renderer));
  check('命中翻转才发穿透切换 IPC（平时零开销）',
    /window\.island\.setInteractive\(over\)/.test(renderer));
  check('折叠态热区外扩 8px（Mac hoverHotRect 的 insetBy(-8)）',
    /HOT_MARGIN_PX = 8/.test(renderer));
  check('穿透窗口的悬停靠转发的 mousemove 驱动',
    /document\.addEventListener\('mousemove'/.test(renderer));
  check('岛尺寸变化后重估指针命中（展开收起会翻转在/不在）',
    /evaluatePointer\(\);/.test(renderer));

  check('高度弹簧写在 .island 上（from→to 显式值 + 收尾释放）',
    /function animateIslandHeight/.test(renderer)
      && /island\.style\.height = Math\.round\(from\) \+ 'px'/.test(renderer)
      && /island\.style\.height = Math\.round\(natural\) \+ 'px'/.test(renderer));
  check('渲染层不再驱动窗口尺寸（架构上就不该有）',
    !/island\.resize\(/.test(renderer) && !/ResizeObserver/.test(renderer));
  check('宽/高/圆角共用同一条弹簧（一起动才读作「张开」）',
    /transition: width var\(--spring-ms\) var\(--spring\),[\s\S]{0,120}height var\(--spring-ms\) var\(--spring\),[\s\S]{0,120}border-radius var\(--spring-ms\) var\(--spring\)/.test(styles));

  check('内发光带口径与 Mac 一致（34 / 48，34% → 0）',
    /--band-collapsed:\s*34px/.test(styles) && /--band-expanded:\s*48px/.test(styles)
      && /var\(--glow\) 34%, transparent/.test(styles));
  check('外发光沿剪影、跟活跃状态走（data-live）',
    /\[data-live="1"\]/.test(styles) && /box-shadow/.test(styles));
  check('状态点 6px（Mac 口径，不是 9px）',
    /\.dot\s*\{[\s\S]{0,200}?width: 6px/.test(styles));
  check('装饰光受 glowEffect 门控（关掉只剩信息，不剩光）',
    /dataset\.glow = glowOn \? '1' : '0'/.test(renderer)
      && /\[data-glow="0"\]/.test(styles));
  check('prefers-reduced-motion 全量让位（无障碍）',
    /@media \(prefers-reduced-motion: reduce\)/.test(styles));

  check('折叠态有胶囊/仪表（Mac compactRow 口径）',
    /class="chip"/.test(renderer) && /class="gauge/.test(renderer));
  check('展开态有头部徽标 + 详情块 + 待办行（Mac HUD 口径）',
    /className = 'hdr'/.test(renderer) && /className = 'detail'/.test(renderer)
      && /className = 'todo'/.test(renderer));
  check('monitor 补齐了 HUD 数据字段（detailText/actionText/todoCurrent）',
    (() => {
      const mon = fs.readFileSync(path.join(SRC, 'monitor.js'), 'utf8');
      return /e\.detailText = a\.detail/.test(mon) && /e\.actionText = a\.title/.test(mon)
        && /e\.todoCurrent = /.test(mon);
    })());

  check('冒烟按岛体矩形裁剪截图（不带窗口 bleed）',
    /capturePage\(rect\)/.test(main) && /smoke-collapsed\.png/.test(main) && /smoke-expanded\.png/.test(main));
  check('冒烟用合成 mousemove 触发展开（穿透窗口只认转发事件）',
    /new MouseEvent\('mousemove'/.test(main));
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
process.exitCode = fail > 0 ? 1 : 0;
