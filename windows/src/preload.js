'use strict';
/**
 * 预加载脚本 —— 渲染进程与主进程之间唯一的通道。
 *
 * 只暴露**最小的**一组方法，不开 `nodeIntegration`、不把 `ipcRenderer` 整个
 * 递过去 —— 渲染层的内容全是我们自己写的，但加载的任何第三方资源都不该
 * 拿到进程间通信的能力。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  /** 订阅快照推送。返回取消订阅的函数。 */
  onSnapshot(callback) {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('island:snapshot', handler);
    return () => ipcRenderer.removeListener('island:snapshot', handler);
  },

  /** 跳到某个会话。payload: { id, label } */
  jump(payload) {
    return ipcRenderer.invoke('island:jump', payload);
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
});
