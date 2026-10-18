// 「插件装完就能用」这条链路在 Windows 上的自检 + v2 契约断言。
//
// 这段逻辑散在两个进程里（主进程的 bringDshToFront、渲染层的设置入口），
// 都碰不到纯 Node 测试。这里用**源码断言 + 契约断言**两条腿验：
//   1. 契约：preload 暴露的名字必须与主进程 ipcMain.handle 注册的名字逐个对上。
//      这两个文件由不同的人在不同时间改，写错一个字母的症状是「点了没反应」，
//      而运行时**不报任何错** —— 只有断言能拦住。
//   2. 源码：renderer 引用的每一个 window.island.X 都必须真的存在。
//
// v2（2026-10-18 全方面优化）把口径更新到 docs/windows-v2-contract.md：
// - 快照 DTO（无 activity/proj/file/now）+ rev 去重 + 自适应轮询；
// - 高度由 ResizeObserver 写 `--island-h` 驱动，渲染热路径零同步布局；
// - 穿透三道防线（pointermove rAF + mouseleave/transitionend + 主进程 500ms 看门狗）；
// - 右键原生菜单、键盘导航、真弹簧 linear()、无 box-shadow 过渡、reduced-motion。
//
// 用法: node windows/test/setup-entry.test.js
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const raw = {
  preload: read('preload.js'),
  main: read('main.js'),
  renderer: read('renderer.js'),
  styles: read('styles.css'),
  html: read('index.html'),
  bridge: read('bridge.js'),
  snapshot: read('snapshot.js'),
};

/**
 * 去掉注释后的源码。
 *
 * 为什么必须剥：注释里会写反例（「旧版 `offsetHeight` 强制回流」「禁止
 * `transition: all`」），不剥的话「禁止」这句注释会把自己判成违规 ——
 * v1 第一版测试就踩过这个坑（注释被当成代码，全红）。
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const code = {
  preload: stripComments(raw.preload),
  main: stripComments(raw.main),
  renderer: stripComments(raw.renderer),
  styles: stripComments(raw.styles),
  bridge: stripComments(raw.bridge),
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

/** 取一个顶层函数体（renderer 里的函数都是 IIFE 内 2 空格缩进的 function 声明）。 */
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const start = src.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return '';
}

/** 从源码里抽出所有 `ipcMain.handle('island:x')` 之类的通道名。 */
function channelsBy(src, re) {
  const out = new Set();
  let m;
  const r = new RegExp(re.source, re.flags);
  while ((m = r.exec(src))) out.add(m[1]);
  return out;
}

const invokeChannels = channelsBy(code.preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
const subscribeChannels = channelsBy(code.preload, /subscribe\(\s*'([^']+)'/g);
const handledChannels = channelsBy(code.main, /ipcMain\.handle\(\s*'([^']+)'/g);
const sentChannels = channelsBy(code.main, /sendToRenderer\(\s*'([^']+)'/g);

const eqSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

console.log('=== S1: 通道名必须两边一致（10 invoke + 4 send）===');
{
  check('preload 用 invoke 的通道数是 13（含自定义拖窗三通道）', invokeChannels.size === 13, [...invokeChannels].join(','));
  check('preload 订阅的推送通道数是 4', subscribeChannels.size === 4, [...subscribeChannels].join(','));
  check('主进程 ipcMain.handle 的通道集合 == preload invoke 集合',
    eqSet(handledChannels, invokeChannels),
    '多：' + [...handledChannels].filter((c) => !invokeChannels.has(c)).join(',')
      + ' 少：' + [...invokeChannels].filter((c) => !handledChannels.has(c)).join(','));
  check('主进程 sendToRenderer 的通道集合 == preload subscribe 集合',
    eqSet(sentChannels, subscribeChannels),
    '多：' + [...sentChannels].filter((c) => !subscribeChannels.has(c)).join(',')
      + ' 少：' + [...subscribeChannels].filter((c) => !sentChannels.has(c)).join(','));
  check('两组合计 17 个通道', invokeChannels.size + subscribeChannels.size === 17);
  check('invoke 与 send 两组不重叠',
    [...invokeChannels].every((c) => !sentChannels.has(c)));
  check('主进程注册了 island:open-dsh', handledChannels.has('island:open-dsh'));
  check('主进程注册了右键菜单 island:context-menu', handledChannels.has('island:context-menu'));
  check('主进程注册了 island:notify（renderer 暂未用，但通道先就绪）', handledChannels.has('island:notify'));
  check('主进程会推 island:snapshot', sentChannels.has('island:snapshot'));
  check('主进程看门狗会推 island:pointer-leave', sentChannels.has('island:pointer-leave'));
  check('右键菜单的钉住走 island:pin-toggle 回渲染层', sentChannels.has('island:pin-toggle'));
  // 悬停主驱动：窗口带 `-webkit-app-region: drag` 时 Electron 的 forward 转发会被
  // 掐断（实测同位置 46 条 → 1 条），所以主进程必须自己推光标坐标。
  check('主进程会推 island:cursor（悬停主驱动）', sentChannels.has('island:cursor'));
  check('旧通道 island:resize / island:expand 已从 main/preload 移除',
    !/island:resize/.test(code.main) && !/island:resize/.test(code.preload)
      && !/island:expand/.test(code.main) && !/island:expand/.test(code.preload));
}

console.log('\n=== S2: 渲染层引用的方法必须真的暴露了 ===');
{
  const exposed = new Set();
  const body = code.preload.slice(code.preload.indexOf('exposeInMainWorld'));
  const re = /^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm;
  let m;
  while ((m = re.exec(body))) exposed.add(m[1]);

  const called = new Set();
  const re2 = /window\.island\.([a-zA-Z][a-zA-Z0-9]*)/g;
  while ((m = re2.exec(code.renderer))) called.add(m[1]);

  check('preload 暴露了 17 个方法', exposed.size === 17, [...exposed].join(','));
  check('渲染层确实调了桥外的方法', called.size > 0, [...called].join(','));
  const missing = [...called].filter((n) => !exposed.has(n));
  check('每个调用都在 preload 里暴露过', missing.length === 0, '缺：' + missing.join(','));
  check('渲染层调用的方法集合与预期一致（11 个）',
    eqSet(called, new Set(['onSnapshot', 'onPointerLeave', 'onCursor', 'onPinToggle', 'jump',
      'setInteractive', 'openDsh', 'contextMenu', 'dragStart', 'dragMove', 'dragEnd'])), [...called].join(','));
  check('渲染层用上了 openDsh（设置入口真的接上了）', called.has('openDsh'));
  check('渲染层订阅了快照推送 onSnapshot', called.has('onSnapshot'));
  check('渲染层订阅了看门狗回收 onPointerLeave', called.has('onPointerLeave'));
  check('渲染层订阅了右键菜单的钉住切换 onPinToggle', called.has('onPinToggle'));
  check('渲染层调用了右键菜单 contextMenu', called.has('contextMenu'));
  check('notify 已暴露但渲染层未调用（契约允许的预留）',
    exposed.has('notify') && !called.has('notify'));

  const pairs = [
    ['onSnapshot', 'island:snapshot'],
    ['onPointerLeave', 'island:pointer-leave'],
    ['onPinToggle', 'island:pin-toggle'],
    ['jump', 'island:jump'],
    ['setInteractive', 'island:set-interactive'],
    ['openDsh', 'island:open-dsh'],
    ['contextMenu', 'island:context-menu'],
    ['notify', 'island:notify'],
  ];
  for (const [method, channel] of pairs) {
    const at = code.preload.indexOf(method + '(');
    const seg = at < 0 ? '' : code.preload.slice(at, at + 420);
    check('方法 ' + method + ' 对应通道 ' + channel, seg.includes("'" + channel + "'"));
  }
}

console.log('\n=== S3: 「设置」入口必须看得见、点得到 ===');
{
  check('index.html 渲染出 data-act="settings"', /data-act="settings"/.test(raw.html));
  check('index.html 有 #settings-link 固定节点（不再靠重建）', /id="settings-link"/.test(raw.html));
  check('hud 点击分派里处理 [data-act="settings"] → openDsh',
    /closest\('\[data-act="settings"\]'\)\)\s*\{\s*openDsh\(\);/.test(code.renderer));
  check('折叠态双击 = 打开 DSH（openDsh）',
    /addEventListener\('dblclick'[\s\S]{0,120}openDsh\(\)/.test(code.renderer));
  // 岛整体是 -webkit-app-region: drag，可点元素若不显式排除，
  // 点下去会被当成「拖窗口」而不是「点击」——这个 bug 在无边框窗口里很隐蔽。
  check('岛体不再声明 app-region: drag（否则 Windows 会把点击当拖窗、并掐断悬停转发）',
    !/\.island\s*\{[\s\S]{0,400}?-webkit-app-region:\s*drag/.test(code.styles),
    '仍存在 .island { -webkit-app-region: drag }');
  check('自定义拖窗三通道已接通（drag-start / drag-move / drag-end）',
    invokeChannels.has('island:drag-start') && invokeChannels.has('island:drag-move')
      && invokeChannels.has('island:drag-end'));
  check('有 hover 反馈（否则用户不知道它能点）', /\.footer \.link:hover/.test(code.styles));
  check('键盘焦点环覆盖设置入口（.link:focus-visible）', /\.link:focus-visible/.test(code.styles));
}

console.log('\n=== S4: 做不到的事不许说成做到了 ===');
{
  // bringDshToFront 依赖 DSH 自己实现了单实例锁，本仓库无法验证。
  // 所以它必须返回「用了哪条路」，让界面能如实说话。
  check('bringDshToFront 返回 ok/how', /function bringDshToFront\(\)[\s\S]{0,1600}return \{ ok:/.test(code.main));
  check('单实例那条路如实标注为未验证',
    /requestSingleInstanceLock[\s\S]{0,260}(无法验证|未验证)/.test(raw.main), '没写清限制');
  // 反向断言：不能出现「已打开设置」这种一定为真的文案。
  const renderedStrings = (code.renderer.match(/'[^'\n]*'|"[^"\n]*"/g) || []).join('\n');
  check('没有写死「已打开设置」这类必然为真的提示', !/已打开设置/.test(renderedStrings));
  check('成功与失败两种提示是分开的',
    /已切到 DSH/.test(renderedStrings) && /DSH 设置\s*→\s*🏝️/.test(renderedStrings),
    '提示没有区分两种情况');
  check('失败路径不假设成功（按 r.ok 分支）',
    /state\.dshHint = \(r && r\.ok\) \? '已切到 DSH' : 'DSH 设置/.test(code.renderer));
}

console.log('\n=== S5: 托盘里也有同一个入口 ===');
{
  check('托盘菜单有打开 DSH 设置项', /打开 DSH 设置/.test(raw.main));
  check('它调用的是同一个函数（不存在两套实现）',
    (code.main.match(/bringDshToFront\(/g) || []).length >= 3,
    '调用处数量 = ' + (code.main.match(/bringDshToFront\(/g) || []).length);
  check('右键菜单里的「打开 DSH 设置」也走 bringDshToFront',
    /label: '打开 DSH 设置', click: \(\) => \{ bringDshToFront\(\); \}/.test(raw.main));
}

console.log('\n=== S6: 插件的 Windows 自动安装分支仍然在 ===');
{
  const lib = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'index.js'), 'utf8');
  check("win32 走 ensureWindowsAppInstalled", /platform === 'win32'[\s\S]{0,200}ensureWindowsAppInstalled/.test(lib));
  check('资产名按平台分叉', /DSHNotch-' \+ ver \+ '-win-/.test(lib), '资产名没分叉');
  check('darwin 分支没被改动', /if \(platform !== 'darwin'\)[\s\S]{0,120}未支持的平台/.test(lib));
}

console.log('\n=== S7: 快照字段必须容缺（否则首帧白屏）===');
// 这条是被真机验证逼出来的：喂一份缺 config 的快照，旧渲染进程抛
// `Cannot read properties of undefined (reading 'scale')`，岛整个白屏 ——
// 但窗口还在、进程还在，日志只有一行红字，症状看起来像「装了插件没反应」。
// v2 的 config() 同时兼容新协议（顶层字段）与旧快照（config.raw）。
{
  const configFn = fnBody(code.renderer, 'config');
  check('找到了 config 函数', configFn.length > 100, '长度 ' + configFn.length);
  const onSnap = fnBody(code.renderer, 'onSnapshot');
  check('onSnapshot 先挡非对象快照', /if \(!snap \|\| typeof snap !== 'object'\) return;/.test(onSnap));
  check('entries 用 Array.isArray 兜底（首帧没有 entries 也不崩）',
    /Array\.isArray\(snap\.entries\) \? snap\.entries : \[\]/.test(onSnap));
  check('config 取值统一走兜底（(state.snap && state.snap.config) || {}）',
    /\(state\.snap && state\.snap\.config\) \|\| \{\}/.test(configFn));
  check('同一函数无 snap.config 裸取',
    !/(?<![.\w])snap\.config\./.test(configFn),
    '命中：' + (configFn.match(/(?<![.\w])snap\.config\.\w+/g) || []).join(','));
  check('注释里写明了 config 兜底是刻意的（raw 兜住旧快照）',
    /raw.*兜住旧快照|旧快照/.test(raw.renderer));
  check('scale 有默认值 1（兜底路径不会写出 --scale: undefined）',
    /typeof c\.scale === 'number' \? c\.scale[\s\S]{0,80}: 1/.test(configFn));
  check('旧快照的 config.raw 仍然兼容（raw 兜底）',
    /const raw = \(c\.raw && typeof c\.raw === 'object'\) \? c\.raw : \{\}/.test(configFn));
  check('bridge 也走兜底（(state.snap && state.snap.bridge) || {}）',
    /\(state\.snap && state\.snap\.bridge\) \|\| \{\}/.test(code.renderer));
  check('第一行快照前先 render() 空态，避免白屏',
    /render\(\);\s*\/\/ 首帧先给/.test(raw.renderer) && /window\.island\.onSnapshot\(onSnapshot\)/.test(raw.renderer));
}

console.log('\n=== S8: 窗口架构契约（固定最大窗口 + 穿透 + 顶端贴屏 + 岛内动画）===');
// macOS 版丝滑的来源是「窗口按最大展开态开好、内容在窗口里动画」。
// Windows 版照搬这条后，任何一处退回「窗口跟内容跑」的老路都会把
// 动画重新拖进 DWM 的抖动里，所以逐条钉住：
//   main.js     窗口尺寸恒为 MAX_WINDOW、y = workArea.y、穿透为常态
//   index.html  岛顶对齐居中（没有 .neck —— 窗口顶=屏顶，无需连接器）
//   styles.css  顶平方角、宽度/高度/圆角同一条弹簧
//   renderer.js 只改岛体尺寸（data-mode + --island-h），不碰窗口
{
  check('main.js 定义固定窗口尺寸 MAX_WINDOW', /const MAX_WINDOW = \{ w: \d+, h: \d+ \}/.test(code.main));
  check('窗口 y 与工作区顶端重合（顶边方角落在屏幕边界上）',
    /const y = area\.y;/.test(code.main), '应是 area.y，不留顶部 bleed');
  check('窗口摆放只读 MAX_WINDOW（不跟岛体尺寸跑）',
    /const ww = Math\.round\(MAX_WINDOW\.w \* scale\);/.test(code.main)
      && /const hh = Math\.round\(MAX_WINDOW\.h \* scale\);/.test(code.main));
  check('穿透为常态：创建后 setIgnoreMouseEvents(true, {forward:true})',
    /setIgnoreMouseEvents\(true, \{ forward: true \}\)/.test(code.main));
  check('渲染层可临时接管：island:set-interactive → setIgnoreMouseEvents(!value)',
    /'island:set-interactive'[\s\S]{0,360}setIgnoreMouseEvents\(!value, \{ forward: true \}\)/.test(code.main));
  check('窗口透明 + 初始不显示（等首帧再 show，避免闪白）',
    /transparent: true/.test(code.main) && /show: false/.test(code.main)
      && /win\.once\('ready-to-show'/.test(code.main));
  check('窗口失焦不降频（backgroundThrottling:false）', /backgroundThrottling: false/.test(code.main));
  check('渲染层不驱动窗口尺寸（没有 setSize/setBounds）',
    !/setBounds\(|setSize\(/.test(code.renderer));

  check('岛在窗口里顶端居中（body flex + align-items:flex-start）',
    /html, body\s*\{[\s\S]{0,700}?display: flex/.test(code.styles)
      && /align-items: flex-start/.test(code.styles)
      && /justify-content: center/.test(code.styles));
  check('index.html 已无 .neck（窗口顶=屏顶，连接器失去存在理由）',
    !/class="neck"/.test(raw.html));

  // 形状：顶平 + 底圆角。对齐 swift/UI/NotchShape.swift 的结论。
  check('岛本体只有底部圆角（顶部方角贴屏幕顶边）',
    /border-radius:\s*0 0 var\(--r-collapsed\)/.test(code.styles),
    (code.styles.match(/border-radius:[^;]*/) || [''])[0]);

  check('render() 写 data-mode（compact/hud 是 v2 的主驱动）',
    /setAttr\(island, 'data-mode', mode\)/.test(code.renderer));
  check('data-expanded 保留为布尔镜像（旧断言/CSS 兼容）',
    /setAttr\(island, 'data-expanded', expanded \? '1' : '0'\)/.test(code.renderer));
  check('CSS 同时认 [data-mode="hud"] 与 [data-expanded="1"]',
    /\[data-mode="hud"\]/.test(code.styles) && /\[data-expanded="1"\]/.test(code.styles));
  check('过渡时长与 Swift 的 .spring(response:0.34) 对齐',
    /--spring-ms:\s*340ms/.test(code.styles), 'Swift 侧是 0.34s');
  check('圆角口径与 Mac 一致（折叠 12 / 展开 20）',
    /--r-collapsed:\s*12px/.test(code.styles) && /--r-expanded:\s*20px/.test(code.styles));
  check('宽度由 --island-w 驱动、展开态覆盖为 436',
    /width:\s*var\(--island-w\)/.test(code.styles) && /--island-w-expanded:\s*436px/.test(code.styles));
  check('高度由 --island-h 驱动（不再 height:auto 做过场）',
    /height:\s*var\(--island-h\)/.test(code.styles) && /--island-h:\s*auto/.test(code.styles));
  check('宽/高/圆角共用同一条弹簧（一起动才读作「张开」）',
    /transition: width var\(--spring-ms\) var\(--spring\),[\s\S]{0,140}height var\(--spring-ms\) var\(--spring\),[\s\S]{0,140}border-radius var\(--spring-ms\) var\(--spring\)/.test(code.styles));
}

console.log('\n=== S9: 桥的 pending 必须一路透传到界面 ===');
// 「用户点了会话、DSH 没切过去」是 Windows 端最难自查的故障：
// 界面上一切正常，没有任何报错。此时唯一的线索就是桥队列里的 pending。
{
  check('health() 透传 pending',
    /pending:\s*obj && typeof obj\.pending === 'number'/.test(code.bridge));
  check('health() 也透传 version（判断跑的是不是新插件）',
    /version:\s*obj && obj\.version/.test(code.bridge));
  check('主进程判定「需要刷新」时把 pending 算进去',
    /r\.pending \|\| 0\) !== \(bridgeState\.pending \|\| 0\)/.test(code.main));
  check('托盘菜单显示待处理条数', /条待处理/.test(code.main));
  check('快照 bridge DTO 带 pending（snapshot.js 负责）',
    /pending: count\(o\.pending\)/.test(raw.snapshot));
  check('岛页脚在有待处理时给出提示（renderFooter 拼「待处理 N」）',
    /' · 待处理 ' \+ pending/.test(code.renderer));
  check('.pending 用告警色（区别于绿色的正常态）',
    /\.pending\s*\{[^}]*color:\s*#FFAA00/.test(code.styles));
  check('bridge-dot 有 on 状态（桥正常 vs 未连上可区分）',
    /\.bridge-dot\.on\s*\{[^}]*background/.test(code.styles));
}

console.log('\n=== S10: 交互与动效契约（Mac 对齐口径 + v2 三道防线）===');
// 设计口径逐条来自 swift/UI/NotchContentView.swift，失配的症状全是
// 「看起来不如 Mac」而非报错，所以用源码断言钉死。
{
  check('悬停驻留与 Mac 同档（开 200ms / 收 350ms）',
    /HOVER_OPEN_MS = 200/.test(code.renderer) && /HOVER_CLOSE_MS = 350/.test(code.renderer));
  check('「等待确认」自动展开（与 macOS 版同一条纪律）',
    /state\.primary && state\.primary\.status === 'waiting'/.test(code.renderer));
  check('没会话时不展开（避免一块空板）',
    /if \(!state\.entries\.length\) return false;/.test(code.renderer));

  check('命中按岛的当前矩形算（islandRect 缓存，不是窗口热区）',
    /function hitIsland/.test(code.renderer) && /const r = islandRect\(\);/.test(code.renderer));
  check('折叠态热区外扩 8px、展开 4px（Mac hoverHotRect 的 insetBy(-8)）',
    /HOT_MARGIN_PX = 8/.test(code.renderer) && /HOT_MARGIN_EXPANDED = 4/.test(code.renderer));
  check('命中翻转才发穿透切换 IPC（平时零开销）',
    /if \(state\.interactive === on\) return;/.test(code.renderer)
      && /window\.island\.setInteractive\(on\)/.test(code.renderer));
  check('两路指针事件都收（真实鼠标给 pointermove，forward:true 转发 mousemove）',
    /addEventListener\('pointermove', onPointerMove/.test(code.renderer)
      && /addEventListener\('mousemove', onPointerMove/.test(code.renderer));
  // 2026-10-19 真机事故：带 `-webkit-app-region: drag` 的窗口上 Electron 的
  // forward 转发会断（同位置 all-no-drag 46 条 vs 带拖拽区 1 条），症状是
  // 「只有岛上一小块能触发展开」。修法是主进程轮询真实光标并推给渲染层。
  check('悬停主驱动 = 主进程光标轮询（绕开拖拽区对 forward 转发的破坏）',
    /CURSOR_POLL_MS = 33/.test(code.main)
      && /screen\.getCursorScreenPoint\(\)/.test(fnBody(code.main, 'cursorInWindow'))
      && /onCursor\(callback\)/.test(code.preload)
      && /if \(typeof window\.island\.onCursor === 'function'\)/.test(code.renderer));
  check('主进程光标接管后，渲染层忽略 DOM 转发事件（避免两路坐标打架）',
    /if \(state\.cursorFromMain\) return;/.test(code.renderer)
      && /state\.cursorFromMain = true/.test(code.renderer));
  check('指针一出窗立刻收回穿透（cursor-out 比 500ms 看门狗快）',
    /releasePointer\('cursor-out'\)/.test(code.main));
  check('窗口隐藏/退出时停掉光标轮询（不空转）',
    /function stopCursorWatch/.test(code.main)
      && /before-quit[\s\S]{0,600}stopCursorWatch\(\)/.test(code.main));
  check('pointermove 只记位置 + 脏标记，命中判定合并到 rAF',
    /function queuePointerRecheck/.test(fnBody(code.renderer, 'queuePointerRecheck'))
      && /requestAnimationFrame/.test(fnBody(code.renderer, 'queuePointerRecheck')));
  check('矩形缓存 + 脏标记失效（每帧最多读一次布局）',
    /state\.rectDirty/.test(code.renderer) && /if \(state\.rect && !state\.rectDirty\) return state\.rect;/.test(code.renderer));
  check('尺寸过渡结束（width/height）后复算命中',
    /addEventListener\('transitionend'/.test(code.renderer)
      && /ev\.propertyName !== 'width' && ev\.propertyName !== 'height'/.test(code.renderer));
  check('1s 兜底复算（转发事件丢失时不卡在旧状态）',
    /SAFETY_RECHECK_MS = 1000/.test(code.renderer));
  check('mouseleave 复位悬停态',
    /document\.addEventListener\('mouseleave', onPointerLeave\)/.test(code.renderer));
  check('onPointerLeave 必须真的通知主进程收回穿透（否则透明区吞点击）',
    /function onPointerLeave[\s\S]{0,900}setInteractive\(false\)/.test(fnBody(code.renderer, 'onPointerLeave')));
  check('出岛分支立刻交还穿透（setInteractive(false)）',
    /state\.overIsland = over;[\s\S]{0,1600}setInteractive\(false\)/.test(fnBody(code.renderer, 'evaluatePointer')));

  check('键盘 Esc 取消钉住', /ev\.key === 'Escape'/.test(code.renderer) && /state\.pinned = false/.test(code.renderer));
  check('HUD 展开时 ↑/↓ 移动行焦点',
    /ev\.key === 'ArrowDown'/.test(code.renderer) && /ev\.key === 'ArrowUp'/.test(code.renderer));
  check('Enter 跳转焦点行', /ev\.key === 'Enter' && state\.focusIndex >= 0/.test(code.renderer));
  check('焦点行加 .focused（CSS 有焦点环）',
    /setClass\(row\.node, 'focused'/.test(code.renderer) && /\.row\.focused/.test(code.styles));

  check('右键 = 主进程原生菜单（渲染层只发请求）',
    /addEventListener\('contextmenu'/.test(code.renderer)
      && /window\.island\.contextMenu\(\{ pinned: state\.pinned \}\)/.test(code.renderer)
      && /Menu\.buildFromTemplate/.test(code.main) && /menu\.popup\(\{ window: win \}\)/.test(code.main));
  for (const item of ['钉住', '取消钉住', '隐藏灵动岛', '打开 DSH 设置', '打开配置目录', '退出']) {
    check('原生菜单包含「' + item + '」', raw.main.includes("'" + item + "'") || raw.main.includes('"' + item + '"'));
  }
  check('菜单里的钉住走渲染层唯一真相源（island:pin-toggle）',
    /sendToRenderer\('island:pin-toggle'\)/.test(code.main)
      && /window\.island\.onPinToggle\(togglePin\)/.test(code.renderer));

  check('点详情/统计 = 跳主会话', /target\.closest\('#detail'\)/.test(code.renderer)
    && /target\.closest\('#stats'\)/.test(code.renderer) && /jumpPrimary\(\)/.test(code.renderer));
  check('点行 = 跳对应会话（事件委托，行复用不重绑）',
    /ev\.target\.closest\('\.row'\)/.test(code.renderer) && /state\.entries\.find/.test(code.renderer));
  check('点折叠主行 = 钉住 / 取消', /addEventListener\('click', \(\) => togglePin\(\)\)/.test(code.renderer));

  check('内发光带口径与 Mac 一致（34 / 48，34% → 0）',
    /--band-collapsed:\s*34px/.test(code.styles) && /--band-expanded:\s*48px/.test(code.styles)
      && /color-mix\(in srgb, var\(--glow\) 34%, transparent\)/.test(code.styles));
  check('外发光沿剪影、跟活跃状态走（data-live）',
    /\[data-live="1"\]/.test(code.styles) && /box-shadow/.test(code.styles));
  check('状态点 6px（Mac 口径，不是 9px）',
    /\.dot\s*\{[\s\S]{0,220}?width: 6px/.test(code.styles));
  check('装饰光受 glowEffect 门控（关掉只剩信息，不剩光）',
    /setAttr\(island, 'data-glow', cfg\.glowEffect \? '1' : '0'\)/.test(code.renderer)
      && /\[data-glow="0"\]/.test(code.styles));
  check('prefers-reduced-motion 全量让位（无障碍）',
    /@media \(prefers-reduced-motion: reduce\)/.test(code.styles)
      && /animation: none !important/.test(code.styles)
      && /transition-duration: 0\.01ms !important/.test(code.styles));

  check('冒烟按岛体矩形裁剪截图（不带窗口 bleed）',
    /capturePage\(rect\)/.test(code.main) && /smoke-collapsed\.png/.test(code.main) && /smoke-expanded\.png/.test(code.main));
  check('冒烟用合成 mousemove + pointermove 触发展开',
    /new MouseEvent\('mousemove'/.test(code.main) && /new PointerEvent\('pointermove'/.test(code.main));
}

console.log('\n=== S11: 性能不变量（契约 §7）===');
// 这些断言全部是「回归即隐形」的那一类：违反了不报错，只是岛悄悄变卡。
{
  const hotFns = ['render', 'renderCompact', 'renderHud', 'renderRows', 'renderStats', 'tickClock', 'onSnapshot'];
  const bodies = hotFns.map((n) => fnBody(code.renderer, n));
  check('找齐了热路径函数（7 个）', bodies.every((b) => b.length > 40),
    hotFns.filter((n, i) => bodies[i].length <= 40).join(','));

  const hot = bodies.join('\n');
  for (const banned of ['offsetHeight', 'offsetWidth', 'scrollHeight', 'getBoundingClientRect', 'innerHTML']) {
    check('热路径没有 ' + banned, !hot.includes(banned));
  }

  // 整个 renderer 里只允许 islandRect() 一处同步读布局（命中判定，脏标记 + rAF + 1s 兜底）
  const layoutReads = (code.renderer.match(/getBoundingClientRect\(/g) || []).length;
  check('全渲染层只有 1 处 getBoundingClientRect（islandRect）', layoutReads === 1, '共 ' + layoutReads + ' 处');
  check('这一处在 islandRect() 里',
    /function islandRect[\s\S]{0,300}getBoundingClientRect/.test(fnBody(code.renderer, 'islandRect')));
  check('没有 innerHTML 赋值（骨架一次创建，之后只改文本/属性）',
    !/innerHTML\s*=/.test(code.renderer) && !/innerHTML\s*=/.test(code.main));

  check('会话行按 id 复用（state.rows + createRow + insertBefore）',
    /state\.rows\.get\(entry\.id\)/.test(code.renderer)
      && /function createRow/.test(code.renderer)
      && /host\.insertBefore\(row\.node/.test(code.renderer));
  check('统计行是固定槽位（STAT_DEFS 6 个，不重建）',
    /const STAT_DEFS = \[/.test(code.renderer)
      && (code.renderer.match(/\['[a-z]+', '/g) || []).length === 6
      && /function createStat/.test(code.renderer));
  check('写 DOM 前先比较旧值（同值不写）',
    /if \(node\.textContent !== v\) node\.textContent = v;/.test(code.renderer)
      && /if \(node\.style\.getPropertyValue\(prop\) === value\) return;/.test(code.renderer)
      && /if \(node\.getAttribute\(name\) !== String\(value\)\)/.test(code.renderer)
      && /if \(has !== !!on\) node\.classList\.toggle/.test(code.renderer));

  // 去重：主进程 rev 相同不发；渲染层 rev 相同直接跳过；rev 在 render 成功后才记
  check('主进程按 rev 去重（相同不 send）', /payload\.rev !== lastRev/.test(code.main));
  check('主进程不再用「整包 JSON 字符串比较」做去重', !/lastSnapshotJson/.test(code.main));
  check('渲染层 rev 相同直接跳过整次渲染',
    /snap\.rev === state\.rev\) return;/.test(code.renderer));
  check('rev 在 render 成功之后才记录（render 抛错可重试）',
    /render\(\);[\s\S]{0,260}state\.rev = snap\.rev;/.test(fnBody(code.renderer, 'onSnapshot')));

  check('主进程改用递归 setTimeout + nextDelay 自适应 250/1000ms',
    /setTimeout\(tick, nextDelay\(payload && payload\.entries, hidden\)\)/.test(code.main)
      && !/setInterval\(tick/.test(code.main));
  check('nextDelay 的落点在 snapshot.js（可被纯 Node 单测）',
    /const \{ buildSnapshot, nextDelay \} = require\('\.\/snapshot\.js'\)/.test(code.main));
  check('主进程已无固定 250ms 轮询常量', !/TICK_MS = 250/.test(code.main));

  // 每拍只 load 一次配置；桥探测按时间而不是 tickIndex（间隔已不固定）
  check('每拍只 load 一次配置（cfg 复用）', /const cfg = config\.load\(\);/.test(code.main));
  check('桥探测按时间 2s，不再按 tickIndex % 8',
    /BRIDGE_PROBE_MS = 2000/.test(code.main) && /now - lastBridgeProbeAt >= BRIDGE_PROBE_MS/.test(code.main));

  // 穿透看门狗（主进程唯一不依赖渲染层事件源的那道防线）
  check('看门狗 500ms', /WATCHDOG_MS = 500/.test(code.main));
  check('用真实光标位置 vs 窗口矩形判定', /screen\.getCursorScreenPoint\(\)/.test(code.main) && /win\.getBounds\(\)/.test(code.main));
  check('出窗强制收回穿透并通知渲染层',
    /releasePointer\('watchdog'\)/.test(code.main)
      && /try \{ win\.setIgnoreMouseEvents\(true, \{ forward: true \}\); \} catch/.test(code.main)
      && /sendToRenderer\('island:pointer-leave'\)/.test(code.main));
  check('看门狗只在接管期间工作（常态穿透无事可做）', /if \(!interactive\) return;/.test(code.main));
  check('冒烟模式跳过看门狗判定（合成 hover 与真实光标无关）',
    /if \(process\.env\.DSH_NOTCH_SMOKE === '1'\) return;/.test(code.main));
  check('窗口隐藏/移动/显示器变化都复位穿透',
    /win\.on\('hide', \(\) => releasePointer/.test(code.main)
      // 拖窗期间窗口 move 是「预期内的」：不能因此收回穿透，否则拖拽会被打断
      && /win\.on\('move', \(\) => \{ if \(dragOrigin\) return; releasePointer\('window-move'\)/.test(code.main)
      && /screen\.on\('display-added', repo\)/.test(code.main)
      && /screen\.on\('display-removed', repo\)/.test(code.main)
      && /screen\.on\('display-metrics-changed', repo\)/.test(code.main));
  check('退出路径清掉轮询与看门狗定时器',
    /clearTimeout\(loopTimer\)/.test(code.main) && /clearInterval\(watchdogTimer\)/.test(code.main));

  // 首帧送达：页面就绪后补发最近一拍（rev 去重下这是唯一保证）
  check('did-finish-load 后补发最近一拍（首帧不白屏）',
    /did-finish-load[\s\S]{0,400}sendSnapshot\(lastPayload\)/.test(code.main));
  check('rendererLoaded 之前不推进 lastRev（避免首帧永久丢失）',
    /if \(rendererLoaded && payload\.rev !== lastRev\)/.test(code.main));
  check('takeSnapshot 的 DTO 由 buildSnapshot 统一产出',
    /function takeSnapshot[\s\S]{0,700}buildSnapshot\(\{ entries, config: cfg, bridge: bridgeState, jump: lastJump, now \}\)/.test(code.main));
}

console.log('\n=== S12: 动效与视觉口径（契约 §3/§6）===');
{
  const spring = /--spring:\s*(linear\([^;]+\))\s*;/.exec(raw.styles);
  check('--spring 是 61 点 linear() 真弹簧', !!spring, '没找到 linear()');
  const curve = spring ? spring[1] : '';
  const pairs = curve.match(/-?\d+(?:\.\d+)? -?\d+(?:\.\d+)?%/g) || [];
  check('弹簧采样点数为 61', pairs.length === 61, '实际 ' + pairs.length);
  check('弹簧关键点位与契约一致（起步 / 过冲 / 收尾）',
    curve.includes('0.0052 1.67%') && curve.includes('1.0152 83.33%') && curve.endsWith('1 100%)'));
  const overshoot = Math.max(...pairs.map((p) => Number(p.split(/\s+/)[0])));
  check('过冲约 1.5%（最大 1.0152）', Math.abs(overshoot - 1.0152) < 1e-9, String(overshoot));

  check('--spring-ms 340ms 且 --snap 内容入场曲线单独定义',
    /--spring-ms:\s*340ms/.test(code.styles) && /--snap:\s*cubic-bezier/.test(code.styles)
      && /--snap-ms:\s*220ms/.test(code.styles));
  check('禁止 transition: all', !/transition\s*:[^;}]*\ball\b/.test(code.styles));
  check('禁止对 box-shadow / filter 做过渡',
    !/transition\s*:[^;}]*(box-shadow|filter)/i.test(code.styles));
  check('外发光是独立伪元素、只过渡 opacity（软件渲染下的关键取舍）',
    /\.island::after\s*\{[\s\S]{0,500}?box-shadow:/.test(code.styles)
      && /\.island::after\s*\{[\s\S]{0,500}?transition: opacity/.test(code.styles));
  check('纯黑底（Mac Color.black，不是深灰渐变）',
    /\.island\s*\{[\s\S]{0,900}?background:\s*#000\b/.test(code.styles));
  check('数字等宽（tabular-nums）',
    /font-variant-numeric:\s*tabular-nums/.test(code.styles));
  check('发丝线白 8%', /--hairline:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/.test(code.styles));
  check('详情正文色 rgb(166,214,255)', /--detail-ink:\s*rgb\(166,\s*214,\s*255\)/.test(code.styles));
  check('尺寸变化限制在岛内（.island-clip contain: layout paint）',
    /\.island-clip\s*\{[\s\S]{0,700}?contain:\s*layout paint/.test(code.styles)
      && (code.styles.match(/contain:\s*layout paint/g) || []).length >= 1);
  check('显隐走 .is-off class（不用 hidden 属性）',
    /\.is-off\s*\{\s*display: none !important;/.test(code.styles)
      && /classList\.toggle\('is-off'/.test(code.renderer));

  check('上下文压力条 2px + 两档告警色（>50% 琥珀 / >80% 红）',
    /\.pressure\s*\{[\s\S]{0,300}?height: 2px/.test(code.styles)
      && /\.pressure\[data-level="1"\]/.test(code.styles)
      && /\.pressure\[data-level="2"\]/.test(code.styles));
  check('压力条由 contextFraction 驱动（renderer 写 width %）',
    /setCssVar\(\$\('pressure-fill'\), 'width', pct \+ '%'\)/.test(code.renderer));
  check('行 hover 反馈白 13%', /\.row:hover\s*\{\s*background:\s*rgba\(255,\s*255,\s*255,\s*0\.13\)/.test(code.styles));
  check('键盘焦点环 outline（仅键盘焦点）',
    /\.row:focus-visible[\s\S]{0,220}?outline:\s*1px solid/.test(code.styles));
  check('胶囊底白 10%', /--chip:\s*rgba\(255,\s*255,\s*255,\s*0\.10\)/.test(code.styles));
  check('图标用 CSS mask + 内联 SVG（零外链 / 零字体依赖）',
    /mask-image:\s*var\(--ico\)/.test(code.styles) && /url\("data:image\/svg\+xml/.test(code.styles));

  // 分层入场：hdr(0) → pressure(20) → detail(50) → todo(80) → list(110) → stats(140) → footer(170)
  check('分层入场用 layer-in 关键帧（opacity + translateY 3px）',
    /@keyframes layer-in[\s\S]{0,160}?translateY\(3px\)/.test(code.styles)
      && /animation: layer-in var\(--snap-ms\) var\(--snap\) both/.test(code.styles));
  const delays = [0, 20, 50, 80, 110, 140, 170];
  check('入场延迟阶梯完整（0/20/50/80/110/140/170ms）',
    delays.every((d) => new RegExp('animation-delay:\\s*' + d + 'ms').test(code.styles)));

  // 状态动效（契约 §6.4 的定值），全部受 data-glow 门控
  check('思考：状态点 2.4s 呼吸（scale 1→1.25）',
    /animation: dot-breathe 2\.4s/.test(code.styles) && /scale\(1\.25\)/.test(code.styles));
  check('工具：1.6s 弹性呼吸 + 内发光带 3s 流光',
    /animation: dot-tool 1\.6s/.test(code.styles)
      && /animation: band-sheen 3s linear infinite/.test(code.styles));
  check('等待确认：1.2s 心跳 + 外发光脉冲 opacity 0.55→0.9',
    /animation: dot-heartbeat 1\.2s/.test(code.styles)
      && /animation: glow-pulse 1\.2s/.test(code.styles)
      && /0%, 100% \{ opacity: 0\.55; \}/.test(code.styles));
  check('完成：一次性绿色微光（done-glint 只跑一次）',
    /animation: done-glint 1\.1s/.test(code.styles));
  check('循环动画受 data-glow="0" 关闭（关掉光效不剩闪烁）',
    (code.styles.match(/\[data-glow="0"\]/g) || []).length >= 2);
  check('reduced-motion 下循环动画全关（animation:none，而不是缩短）',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}?animation: none !important/.test(code.styles));

  // 视觉语言不漂移
  check('--scale / --glow / --dot 三个变量由 renderer 写',
    /setCssVar\(root, '--scale'/.test(code.renderer)
      && /setCssVar\(root, '--glow'/.test(code.renderer)
      && /setCssVar\(row\.dot, '--dot'/.test(code.renderer));
  check('不同状态只改 --glow（renderer 是唯一写入方，CSS 不再定义第二份）',
    /setCssVar\(root, '--glow', glow\)/.test(code.renderer)
      && /状态色板由 renderer 写/.test(raw.styles)
      && !/\.island\[data-status="[a-z]+"\]\s*\{[^}]*--glow:/.test(code.styles)
      && /\.row\[data-status="waiting"\]\s*\{\s*--dot: #FFAA00/.test(code.styles));
  check('--island-w / --island-h / --spring / --r-* / --band-* 变量齐全',
    ['--island-w:', '--island-h:', '--spring:', '--spring-ms:', '--snap:', '--snap-ms:',
      '--r-collapsed:', '--r-expanded:', '--band-collapsed:', '--band-expanded:']
      .every((v) => code.styles.includes(v)));
}

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
process.exitCode = fail > 0 ? 1 : 0;
