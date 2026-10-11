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

console.log('\n=== S8: 连接器（.neck）与主进程的几何必须对得上 ===');
// 这套东西横跨三个文件，任何一处单独改都不会报错，只会「看起来有点怪」：
//   index.html  → 有没有 .neck 节点
//   styles.css  → .neck 的高度 / 负 margin / pointer-events
//   main.js     → 窗口高度是否 +NECK、y 是否 -NECK
// 三者任一失配的后果都不直观（颈部被裁掉、方角露在屏幕里、
// 或者屏幕最顶端凭空多出一条 10px 的点击带），所以逐条钉住。
{
  const html = read('index.html');
  const neckH = 10;

  check('index.html 里有 .neck 节点', /class="neck"/.test(html));
  check('.neck 是 aria-hidden（纯装饰，不该被读屏念出来）',
    /class="neck"\s+aria-hidden="true"/.test(html));

  // 形状：顶平 + 底圆角。对齐 swift/UI/NotchShape.swift 的结论。
  check('岛本体只有底部圆角（顶部交给 .neck 的方角）',
    /\.island\s*\{[\s\S]{0,400}?border-radius:\s*0 0 14px 14px/.test(styles),
    (styles.match(/\.island\s*\{[\s\S]{0,400}?border-radius:[^;]*/) || [''])[0].slice(0, 80));

  check('.neck 用负 margin 探出岛的 box',
    /\.neck\s*\{[\s\S]{0,400}?margin-top:\s*calc\(-1 \*/.test(styles));
  check('.neck 必须 pointer-events:none（否则吃掉屏幕顶端 10px 点击带）',
    /\.neck\s*\{[\s\S]{0,400}?pointer-events:\s*none/.test(styles));

  // 主进程侧：窗口高度要 +NECK、y 要 -NECK
  check('main.js 定义了 NECK_OVERHANG', /const NECK_OVERHANG = (\d+)/.test(main),
    '没找到常量');
  const m = main.match(/const NECK_OVERHANG = (\d+)/);
  const declared = m ? Number(m[1]) : -1;
  check('NECK_OVERHANG 与 CSS 的 .neck 高度一致（不一致会露边）',
    declared === neckH, 'main=' + declared + ' css=' + neckH);
  check('窗口高度 = (h + NECK_OVERHANG) * scale',
    /const hh = Math\.round\(\(h \+ NECK_OVERHANG\) \* scale\)/.test(main));
  check('窗口 y 向上探出（否则方角露在屏幕里）',
    /area\.y - NECK_OVERHANG \* scale/.test(main));
  check('y 不能真把岛推出屏幕（任务栏在上时 workArea.y 为负）',
    /Math\.max\(area\.y,/.test(main));

  // 渲染层：data-expanded 是 CSS 过渡的驱动源
  check('render() 写 data-expanded（否则过渡不触发）',
    /island\.dataset\.expanded = expanded \? '1' : '0'/.test(renderer)
    || /dataset\.expanded = expanded \? "1" : "0"/.test(renderer));
  check('CSS 有[data-expanded="1"] 的展开态样式',
    /\[data-expanded="1"\]/.test(styles));
  check('过渡时长与 Swift 的 .spring(response:0.34) 对齐',
    /--spring-ms:\s*340ms/.test(styles), 'Swift 侧是 0.34s');
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

console.log('\n' + '='.repeat(44));
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(44));
process.exitCode = fail > 0 ? 1 : 0;
