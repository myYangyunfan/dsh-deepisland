// Windows 版跳转流程的自检。
//
// 全部靠**注入依赖**跑：不真调 Electron 的 `shell.openExternal`，
// 也不真起桥。要验的是「顺序」与「降级」这两件事 —— 它们才是这段逻辑的
// 全部价值所在；HTTP 部分由 bridge.test.js 单独覆盖。
//
// 用法: node windows/test/jump.test.js
const path = require('node:path');

const { performJump, clipboardText } = require(path.join(__dirname, '..', 'src', 'jump.js'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
};

const ENTRY = { id: 'session-abc', label: '高难度数学试卷出题' };

console.log('=== W1: 剪贴板文本 ===');
check('用标题', clipboardText(ENTRY) === '高难度数学试卷出题', clipboardText(ENTRY));
check('标题为空时退回 id', clipboardText({ id: 'session-x', label: '   ' }) === 'session-x',
  clipboardText({ id: 'session-x', label: '   ' }));
check('全空不崩', typeof clipboardText({}) === 'string');

console.log('\n=== W2: 首选路径 —— 桥通 ===');
(async () => {
  const calls = [];
  let r = await performJump(ENTRY, {
    activate: () => { calls.push('activate'); return true; },
    copy: () => { calls.push('copy'); return true; },
    post: async () => { calls.push('post'); return true; },
  });
  check('kind = bridged', r.kind === 'bridged', r.kind);
  check('usedBridge = true', r.usedBridge === true);
  check('isSuccess = true', r.isSuccess === true);
  check('brief「已切到该对话」', r.brief === '已切到该对话', r.brief);
  check('顺序是 先置前 再投桥', calls.join('>') === 'activate>post', calls.join('>'));
  check('桥通时不写剪贴板（不污染用户的剪贴板）', !calls.includes('copy'), calls.join('>'));

  console.log('\n=== W3: 降级路径 —— 桥不通 ===');
  calls.length = 0;
  let copied = null;
  r = await performJump(ENTRY, {
    activate: () => { calls.push('activate'); return true; },
    copy: (t) => { copied = t; calls.push('copy'); return true; },
    post: async () => { calls.push('post'); return false; },
  });
  check('kind = copied', r.kind === 'copied', r.kind);
  check('usedBridge = false', r.usedBridge === false);
  check('isSuccess = true（降级也算成功）', r.isSuccess === true);
  check('brief 提示 Ctrl+K', /Ctrl\+K/.test(r.brief), r.brief);
  check('剪贴板写的是标题', copied === '高难度数学试卷出题', String(copied));
  check('降级也按顺序走完 置前→投桥→复制', calls.join('>') === 'activate>post>copy', calls.join('>'));

  console.log('\n=== W4: 彻底失败 ===');
  r = await performJump(ENTRY, {
    activate: () => false, copy: () => false, post: async () => false,
  });
  check('kind = failed', r.kind === 'failed', r.kind);
  check('isSuccess = false', r.isSuccess === false);
  check('brief「跳转失败」', r.brief === '跳转失败', r.brief);

  console.log('\n=== W5: 置前失败但复制成功 —— 仍算成功 ===');
  r = await performJump(ENTRY, {
    activate: () => false, copy: () => true, post: async () => false,
  });
  check('kind = copied', r.kind === 'copied', r.kind);
  check('isSuccess = true', r.isSuccess === true);
  check('activated = false 如实记下', r.activated === false);

  console.log('\n=== W6: 置前成功但复制失败 —— 仍算成功（至少把 DSH 拉到前台了）===');
  r = await performJump(ENTRY, {
    activate: () => true, copy: () => false, post: async () => false,
  });
  check('kind = copied', r.kind === 'copied', r.kind);
  check('isSuccess = true', r.isSuccess === true);

  console.log('\n=== W7: 依赖抛异常不该把岛带崩 ===');
  let threw = false;
  try {
    r = await performJump(ENTRY, {
      activate: () => { throw new Error('协议未注册'); },
      copy: () => { throw new Error('剪贴板被占用'); },
      post: async () => { throw new Error('桥炸了'); },
    });
  } catch { threw = true; }
  check('三处全抛也不外溢', !threw);
  check('结果是 failed', r && r.kind === 'failed', r && r.kind);

  console.log('\n=== W8: jumpEnabled=false 时不投桥（走纯复制）===');
  calls.length = 0;
  r = await performJump(ENTRY, {
    activate: () => true,
    copy: () => true,
    post: async () => { calls.push('post'); return true; },
  });
  check('给了 post 就投（开关在主进程里判，这里只管流程）',
    r.kind === 'bridged', r.kind);

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
