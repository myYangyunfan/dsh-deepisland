'use strict';
/**
 * 从岛跳到 DSH 里的对应对话 —— Windows 版。
 *
 * 移植自 `swift/Sources/DSHNotch/Core/SessionJump.swift`。
 *
 * ## 与 macOS 版的差异（都是被迫的，不是偷懒）
 *
 * | 环节 | macOS | Windows |
 * |------|-------|---------|
 * | 置前 DSH | `NSWorkspace.open(dsh://open)` | `shell.openExternal('dsh://open')` |
 * | 切会话 | `POST /jump` 走插件桥 | 同一套桥，跨平台无差别 |
 * | 降级定位 | 复制标题 + 代按 ⌘K/⌘V | 只复制标题（**不能代按键**） |
 *
 * 代按键那一步砍掉的原因：macOS 靠 `CGEvent.post` + 辅助功能权限，Windows 上
 * 没有等价的、不越界的做法（发全局按键要么需要驱动，要么会被 UAC/焦点规则
 * 静默丢弃）。所以 Windows 的降级路径是「把 DSH 拉到前台 + 标题进剪贴板」，
 * 用户自己按 **Ctrl+K** 再 Ctrl+V。这比假装能自动化要诚实。
 *
 * ⚠️ `dsh://open` 是否由 DSH **在 Windows 上注册**，本仓库尚未实测（作者没有
 * Windows 机器）。`shell.openExternal` 在协议未注册时会失败，这里捕获并记录，
 * 降级路径照走 —— 功能不受影响，只是「置前」这一步可能无效。
 */

const bridge = require('./bridge.js');

/**
 * 跳转结果。
 * @typedef {{ kind: 'bridged'|'copied'|'failed',
 *             sessionId: string, text: string, brief: string,
 *             usedBridge: boolean, isSuccess: boolean, activated: boolean }} Outcome
 */

/** 写进剪贴板的文本：标题优先，空白时退回会话 id。 */
function clipboardText(entry) {
  const t = String((entry && entry.label) || '').trim();
  return t || ((entry && entry.id) || '');
}

/**
 * 执行一次跳转。
 *
 * 顺序讲究：**先置前，再投桥**。
 * 置前放在前面，是因为插件的 `openSession` 只换视图、不管窗口焦点；
 * 窗口先到前台，用户看到的才是「已经切好的那个会话」。
 *
 * @param {object} entry 会话条目（至少要有 id / label）
 * @param {{
 *   activate?: () => (boolean|Promise<boolean>),
 *   copy?: (text: string) => boolean,
 *   post?: (sessionId: string, title: string) => Promise<boolean>,
 *   timeoutMs?: number,
 * }} deps 依赖注入。**刻意做成可注入**：本文件要在纯 Node 下自检，
 *        不能硬依赖 Electron 的 `shell` / `clipboard`。
 * @returns {Promise<Outcome>}
 */
async function performJump(entry, deps = {}) {
  const id = (entry && entry.id) || '';
  const title = (entry && entry.label) || '';
  const text = clipboardText(entry);

  const activate = deps.activate || (() => false);
  const copy = deps.copy || (() => false);
  const post = deps.post || ((sid, ttl) => bridge.postJump(sid, ttl, { timeoutMs: deps.timeoutMs }));

  // 1) 置前 DSH —— 无论走不走桥都要做，后台点击时全靠它
  let activated = false;
  try {
    activated = !!(await activate());
  } catch (e) {
    console.error('[dsh-notch] 置前 DSH 失败:', e && e.message);
    activated = false;
  }

  // 2) 首选：交给插件桥直接切会话
  let bridged = false;
  try {
    bridged = !!(await post(id, title));
  } catch (e) {
    console.error('[dsh-notch] 投桥失败:', e && e.message);
    bridged = false;
  }
  if (bridged) {
    return {
      kind: 'bridged', sessionId: id, text: title, brief: '已切到该对话',
      usedBridge: true, isSuccess: true, activated,
    };
  }

  // 3) 降级：标题进剪贴板，用户自己 Ctrl+K / Ctrl+V
  let copied = false;
  try {
    copied = !!copy(text);
  } catch (e) {
    console.error('[dsh-notch] 写剪贴板失败:', e && e.message);
    copied = false;
  }

  if (!activated && !copied) {
    return {
      kind: 'failed', sessionId: id, text, brief: '跳转失败',
      usedBridge: false, isSuccess: false, activated,
    };
  }
  return {
    kind: 'copied', sessionId: id, text, brief: '已复制标题 · Ctrl+K 粘贴',
    usedBridge: false, isSuccess: true, activated,
  };
}

module.exports = { performJump, clipboardText };
