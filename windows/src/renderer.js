'use strict';
/**
 * 渲染进程 —— 岛的界面。
 *
 * 只做两件事：把主进程推来的快照画出来，把点击翻译成一个 IPC。
 * **不读文件、不算状态** —— 那些都在主进程（`monitor.js` / `projections.js`）。
 *
 * ## 折叠 / 展开
 *
 * - 悬停展开（`expandOnHover`，默认开）；
 * - 点主行**钉住**（`pinned`），钉住后不再因移开鼠标而收起；
 * - 窗口高度由 `offsetHeight` 实测后回传主进程 —— 透明窗口不能留空白，
 *   空白处会吃掉鼠标点击，用户会觉得「这一点怎么没反应」。
 */

(function () {
  const el = (id) => document.getElementById(id);

  const state = {
    snap: null,
    pinned: false,
    hovering: false,
    jump: null,
    jumpTimer: 0,
    /** 点「设置」后的临时提示（几秒后自行消失）。 */
    dshHint: null,
    dshTimer: 0,
  };

  /** HTML 转义：会话标题来自 DSH 的磁盘数据，不能被当成标记解析。 */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const LIVE = { thinking: 1, tool: 1, waiting: 1, done: 1 };

  function isLive(status) {
    return !!LIVE[status];
  }

  /** 是否展开。钉住 > 悬停。 */
  function shouldExpand(snap) {
    if (state.pinned) return true;
    const cfg = (snap && snap.config) || {};
    const hoverOn = cfg.raw && cfg.raw.expandOnHover === false ? false : true;
    return hoverOn && state.hovering;
  }

  function render(snap) {
    state.snap = snap;

    // ⚠️ snap.config 必须容缺，不能直接 `snap.config.scale`。
    // 同文件下面的 shouldExpand() 写的是 `snap.config.raw && ...`（有防御），
    // 而这里曾经裸取 —— 同一个对象两套写法。只要有任何一条路径发来的快照
    // 少了 config（首帧、IPC 竞态、preload 未就绪时的兜底快照），
    // 就会在渲染进程抛 `Cannot read properties of undefined`，
    // 结果是**整个岛白屏**，而且窗口还在、进程还在、日志里只有一行红字，
    // 症状看起来像「装了但没反应」—— 极难定位。
    //
    // 这里统一兜底成空对象，让 scale 退回 1、其余字段读 undefined，
    // 也就是「按默认尺寸渲染」而不是崩。
    const cfg = (snap && snap.config) || {};
    document.documentElement.style.setProperty('--scale', String(cfg.scale || 1));

    const entries = Array.isArray(snap.entries) ? snap.entries : [];
    const primary = entries.length ? entries[0] : null;

    // 光晕跟随主会话的状态色
    document.documentElement.style.setProperty('--glow', (primary && primary.glow) || '#50505A');

    const expanded = shouldExpand(snap);

    // 折叠/展开写进 data 属性，CSS 靠它驱动过渡（.neck 收窄、非主行淡入上浮）。
    // 必须**每次 render 都写**：state.pinned 由点击改变时不会重新推快照，
    // 只靠主进程那条 island:expand 回包的话，这里就没有驱动源了。
    const island = el('island');
    if (island) island.dataset.expanded = expanded ? '1' : '0';

    el('pinned-hint').textContent = state.pinned ? '已钉住 · 点状态行取消' : '';
    el('primary').innerHTML = primary ? primaryRow(primary) : emptyRow(cfg);
    el('list').innerHTML = expanded ? entries.slice(1).map(rowHtml).join('') : '';
    el('stats').innerHTML = (expanded && primary) ? statsHtml(primary) : '';
    el('footer').innerHTML = footerHtml(snap, expanded);

    bindClicks(entries);
    window.island.setExpanded(expanded);
    requestResize();
  }

  function primaryRow(e) {
    return '<span class="dot' + (isLive(e.status) ? ' live' : '') + '"></span>'
      + '<span class="title">' + esc(e.label) + '</span>'
      + '<span class="badge' + (isLive(e.status) ? ' accent' : '') + '">' + esc(e.tag) + '</span>';
  }

  function emptyRow() {
    return '<span class="dot"></span>'
      + '<span class="title" style="color:var(--text-dim)">没有活跃会话</span>'
      + '<span class="badge">Ready</span>';
  }

  function rowHtml(e) {
    const bits = [];
    if (e.contextText) bits.push('ctx ' + esc(e.contextText));
    if (e.todoText) bits.push('todo ' + esc(e.todoText));
    return '<div class="row' + (e.status === 'idle' ? ' idle' : '') + '" data-id="' + esc(e.id) + '">'
      + '<span class="dot' + (isLive(e.status) ? ' live' : '') + '" style="background:' + esc(e.glow) + '"></span>'
      + '<span class="label">' + esc(e.label) + '</span>'
      + '<span class="tag">' + esc(e.tag) + '</span>'
      + (bits.length ? '<span class="mini">' + bits.join(' · ') + '</span>' : '')
      + '</div>';
  }

  function statsHtml(e) {
    const items = [];
    if (e.elapsedText) items.push(stat('耗时', e.elapsedText));
    if (e.turnStepText) items.push(stat('轮次', e.turnStepText));
    if (e.toolCountText) items.push(stat('工具', e.toolCountText));
    if (e.outputText) items.push(stat('输出', e.outputText));
    if (e.contextText) {
      const cls = e.contextLevel === 2 ? ' danger' : (e.contextLevel === 1 ? ' warn' : '');
      items.push(stat('上下文', e.contextText, cls));
    }
    if (e.todoText) items.push(stat('待办', e.todoText));
    if (e.subagentText) items.push(stat('子代理', e.subagentText));
    return items.join('');
  }

  function stat(label, value, cls) {
    return '<span class="stat' + (cls || '') + '">' + esc(label) + ' <b>' + esc(value) + '</b></span>';
  }

  function footerHtml(snap, expanded) {
    if (!expanded) return '';
    const bridgeOk = snap.bridge && snap.bridge.ok;
    const right = snap.jump && (Date.now() - snap.jump.at < 6000)
      ? '<span class="jump' + (snap.jump.kind === 'failed' ? ' failed' : '') + '">'
        + esc(snap.jump.brief) + '</span>'
      : '';
    const left = '<span><i class="bridge-dot' + (bridgeOk ? ' on' : '') + '"></i>桥'
      + (bridgeOk ? ' ' + esc(String(snap.bridge.port)) : '未连上')
      // 有待处理但没被消费的跳转 → 直接说出来。
      // 之前这个信息被bridge.health() 丢掉了，于是「点了会话、DSH 没切过去」
      // 在界面上和「一切正常」长得一模一样，用户只能自己去猜。
      // 现在 health() 已透传 pending，这里把它显出来。
      + (bridgeOk && snap.bridge.pending > 0
        ? ' <span class="pending" title="有 ' + Number(snap.bridge.pending)
          + ' 条跳转请求还没被 DSH 取走">待处理 ' + Number(snap.bridge.pending) + '</span>'
        : '')
      + '</span>';
    // 「设置」必须出现在岛上。岛本身不做设置界面（入口在 DSH 的
    // 设置 → 🏝️ 灵动岛，两边共用一份配置），但用户是先在屏幕上看到岛的，
    // 不给一个指路的口，他只能自己猜设置在哪。
    const settings = '<span class="link" data-act="settings">设置</span>';
    const tail = state.dshHint || settings;
    if (!right) return '<span class="foot-left">' + left + '</span>' + tail;
    return '<span class="foot-left">' + left + '</span>' + right + tail;
  }

  function bindClicks(entries) {
    const p = el('primary');
    p.onclick = () => { state.pinned = !state.pinned; render(state.snap); };

    const set = el('footer').querySelector('[data-act="settings"]');
    if (set) {
      set.onclick = (ev) => {
        ev.stopPropagation();
        window.island.openDsh().then((r) => {
          // 做不到就说做不到。这里不写「已打开设置」这种一定为真的文案 ——
          // 能不能把 DSH 带起来取决于它自己有没有实现单实例锁。
          state.dshHint = (r && r.ok)
            ? '<span class="link">已切到 DSH</span>'
            : '<span class="link">DSH 设置 → 🏝️ 灵动岛</span>';
          render(state.snap);
          clearTimeout(state.dshTimer);
          state.dshTimer = setTimeout(() => { state.dshHint = null; render(state.snap); }, 6000);
        }).catch(() => { /* 主进程已记日志 */ });
      };
    }

    for (const node of el('list').querySelectorAll('.row')) {
      node.onclick = () => {
        const id = node.getAttribute('data-id');
        const entry = entries.find((x) => x.id === id);
        if (!entry) return;
        window.island.jump({ id: entry.id, label: entry.label })
          .then((r) => {
            state.jump = r;
            clearTimeout(state.jumpTimer);
            state.jumpTimer = setTimeout(() => { state.jump = null; render(state.snap); }, 6000);
            render(state.snap);
          })
          .catch(() => { /* 主进程已记日志 */ });
      };
    }
  }

  // 高度回传：用 rAF 合并，避免一次渲染里量两次
  let resizePending = false;
  function requestResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      const h = el('island').offsetHeight;
      const w = 380;
      window.island.resize(w, h).catch(() => { /* 主进程已记日志 */ });
    });
  }

  // 悬停展开
  document.addEventListener('mouseenter', () => {
    state.hovering = true;
    if (state.snap) render(state.snap);
  });
  document.addEventListener('mouseleave', () => {
    // 鼠标移出窗口（去点别的窗口）→ 收起，除非钉住
    state.hovering = false;
    if (state.snap) render(state.snap);
  });

  window.island.onSnapshot(render);
})();
