'use strict';
/**
 * 预加载脚本 —— 渲染进程与主进程之间唯一的通道。
 *
 * 只暴露**最小的**一组方法，不开 `nodeIntegration`、不把 `ipcRenderer` 整个
 * 递过去 —— 渲染层的内容全是我们自己写的，但加载的任何第三方资源都不该
 * 拿到进程间通信的能力。
 *
 * ⚠️ 这里的通道名必须与 `main.js` 里 `ipcMain.handle` / `webContents.send`
 * 用到的**逐个一致**（多一个、少一个、拼错一个字母的症状都是「点了没反应」，
 * 运行时不会报错）。`test/setup-entry.test.js` 的 S1 组把两边做成集合相等；
 * 若 `main.js` 里在注释中把通道名写成带引号的字面量，也会被算进集合 ——
 * 所以两边要么都有、要么都别写成带引号的字符串。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 订阅主进程 → 渲染进程的单向事件，返回取消订阅函数。 */
function subscribe(channel, callback) {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('island', {
  /** 订阅快照推送（v2 DTO，主进程只在 rev 变化时发）。返回取消订阅的函数。 */
  onSnapshot(callback) {
    return subscribe('island:snapshot', callback);
  },

  /**
   * 看门狗收回穿透后的通知。
   *
   * 主进程每 500ms 用真实光标位置对比窗口矩形；指针已经出了窗口、但渲染层
   * 没收到 mouseleave（`forward:true` 只在窗口内转发事件）时，主进程会强制
   * 恢复穿透并广播这条事件。渲染层收到后必须把 overIsland / interactiveReq
   * 置 false 并重渲染 —— 否则岛会保持「悬停展开」的假象，要等下一次鼠标移动
   * 才恢复，用户体感就是「岛粘在屏幕上」。
   */
  onPointerLeave(callback) {
    return subscribe('island:pointer-leave', () => callback());
  },

  /**
   * 主进程右键菜单里点了「钉住 / 取消钉住」。
   *
   * 菜单由主进程弹（原生菜单，能盖在穿透窗口之上），但 pinned 的唯一真相源
   * 在渲染层（它还要同时管展开/收起、Esc、点主行）。所以菜单项只发一条
   * 「切换」请求回来，由渲染层走它自己的那条 toggle 路径，避免两处各存一份
   * 状态然后在某个分支上打架。
   */
  onPinToggle(callback) {
    return subscribe('island:pin-toggle', () => callback());
  },

  /**
   * 自定义拖窗（替代 \`-webkit-app-region: drag\`）。
   *
   * 真机实测：带 app-region: drag 的窗口上，Windows 会把岛体内的点击当成
   * 「拖窗」处理（WM_NCLBUTTONDOWN），页面收不到 click；同时 Electron 的
   * forward:true 转发也会被掐断。拖拽区不能白给，所以改成渲染层报告指针
   * 屏幕坐标、主进程按位移移动窗口。
   */
  dragStart() { return ipcRenderer.invoke('island:drag-start'); },
  dragMove(point) { return ipcRenderer.invoke('island:drag-move', point || {}); },
  dragEnd() { return ipcRenderer.invoke('island:drag-end'); },

  /** 跳到某个会话。payload: { id, label } */
  jump(payload) {
    return ipcRenderer.invoke('island:jump', payload);
  },

  /**
   * 主进程推来的「指针在窗口里的 CSS 坐标」（约 30Hz，位置不变就不发）。
   *
   * ## 为什么不用浏览器自己的 mousemove
   *
   * 窗口带 `-webkit-app-region: drag` 拖拽区时，Electron 的
   * `setIgnoreMouseEvents(true, {forward:true})` 转发会被掐断 —— 真机实测：
   * 同一位置全部改成 no-drag 时 500ms 收到 46 条转发事件，带拖拽区时只有 1 条。
   * 表现就是「只有岛上一个很窄的位置能触发展开」。
   *
   * 拖拽区不能删（唯一的拖窗手段），于是由主进程直接读真实光标
   * （`screen.getCursorScreenPoint`）换算成窗口坐标推过来。渲染层拿到的就是
   * 「指针此刻在哪」，命中判定与悬停逻辑不再依赖任何转发行为。
   */
  onCursor(callback) {
    return subscribe('island:cursor', (pos) => callback(pos));
  },

  /**
   * 指针进岛/出岛时切换窗口的点击穿透（macOS 版 isInteractive 的对应物）。
   *
   * 窗口按最大展开态开、比岛大一圈，平时必须穿透（否则岛下方的应用
   * 点不动），只有指针真的在岛上时才临时接管 —— 岛里的行/按钮才点得到。
   * 判定在渲染层做（转发来的 mousemove × 岛的当前矩形），翻转时才发这条 IPC。
   */
  setInteractive(value) {
    return ipcRenderer.invoke('island:set-interactive', !!value);
  },

  hide() { return ipcRenderer.invoke('island:hide'); },
  show() { return ipcRenderer.invoke('island:show'); },
  quit() { return ipcRenderer.invoke('island:quit'); },
  toggleNotch() { return ipcRenderer.invoke('island:toggle-notch'); },

  /**
   * 「打开设置」。
   *
   * 岛上不自己做设置界面 —— 唯一的设置入口是 DSH 的
   * 「设置 → 🏝️ 灵动岛」面板，两边共用同一份 client-config.json，
   * 在这里再画一套界面只会变成第二个真相源。
   *
   * 于是问题来了：**用户装完插件，怎么知道设置在哪？**
   * 就是靠这个。点一下把 DSH 窗口带到前台，用户自然在那里看到面板。
   * 主进程侧依次试：窗口聚焦 → 再问一次单实例锁（把已有实例带起来）。
   */
  openDsh() { return ipcRenderer.invoke('island:open-dsh'); },
  openConfigDir() { return ipcRenderer.invoke('island:open-config-dir'); },

  /**
   * 岛体右键 → 主进程弹原生菜单（钉住/取消钉住、隐藏灵动岛、打开 DSH 设置、
   * 打开配置目录、退出）。
   *
   * 菜单必须由主进程弹：岛窗口常态是鼠标穿透的，渲染层画不出能盖住其它
   * 应用的菜单；而且「退出」「隐藏」这类动作本来就在主进程。payload.pinned
   * 只用来决定第一项显示「钉住」还是「取消钉住」。
   */
  contextMenu(payload) {
    return ipcRenderer.invoke('island:context-menu', payload || {});
  },

  /**
   * 系统级提示（Windows 托盘气泡）。
   *
   * 用在「点了会话但 DSH 没接住」这类降级路径上：岛上的文字提示会被下一跳
   * 快照刷掉，而用户可能正看着别处。主进程在托盘不存在时如实返回
   * `{ ok: false }`，渲染层不要假设它一定成功。
   */
  notify(payload) {
    return ipcRenderer.invoke('island:notify', payload || {});
  },
});
