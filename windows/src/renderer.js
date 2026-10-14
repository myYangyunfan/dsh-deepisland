'use strict';
/**
 * 渲染进程 —— 岛的界面。
 *
 * 只做两件事：把主进程推来的快照画出来，把点击翻译成一个 IPC。
 * **不读文件、不算状态** —— 那些都在主进程（`monitor.js` / `projections.js`）。
 *
 * ## 折叠 / 展开
 *
 * - 悬停展开（`expandOnHover`，默认开）。**有驻留门槛**：鼠标划过屏幕
 *   顶端是常态（去点最大化/标签页），没有门槛的即悬即展会一路误触。
 *   macOS 版就是这个手感（悬停约 0.2s 展开、移开约 0.35s 收起），
 *   这里取同一档：180ms 开、120ms 收 —— 开要防误触，收要跟手。
 * - 点主行**钉住**（`pinned`），钉住后不再因移开鼠标而收起；
 * - 「等待人工确认」时自动展开提醒（与 macOS 版同一条纪律）：
 *   这件事值得打断用户，不能指望他恰好在看岛。
 * - 窗口尺寸由 `offsetHeight/offsetWidth` 实测回传主进程 —— 透明窗口
 *   不能留空白，空白处会吃掉鼠标点击，用户会觉得「这一点怎么没反应」。
 *   高度/宽度在 CSS 里做弹簧过渡（.body 的 height、.island 的 width），
 *   ResizeObserver 把逐帧尺寸同步给主进程，窗口贴着动画走。
 */

(function () {
  const el = (id) => document.getElementById(id);

  /** 悬停驻留：进入要等（防误触），离开走得快（跟手）。毫秒。 */
  const HOVER_OPEN_MS = 180;
  const HOVER_CLOSE_MS = 120;
  /** 折叠动画结束后才把「已折叠」报给主进程（见 setExpanded 的说明）。 */
  const COLLAPSE_SETTLE_MS = 380;
  /** .body 高度过渡的收尾：之后释放回 auto，避免显式高度裁住内容变化。 */
  const HEIGHT_SETTLE_MS = 420;
  /** 折叠→展开的那一次，行错峰入场的播完时长（含 delay）。 */
  const FRESH_CLEAR_MS = 460;

  const state = {
    snap: null,
    pinned: false,
    hovering: false,
    jump: null,
    jumpTimer: 0,
    /** 点「设置」后的临时提示（几秒后自行消失）。 */
    dshHint: null,
    dshTimer: 0,
    hoverOpenTimer: 0,
    hoverCloseTimer: 0,
    collapseTimer: 0,
    heightTimer: 0,
    freshTimer: 0,
    prevExpanded: false,
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

  /**
   * 是否展开。优先级：钉住 > 等待确认 > 悬停。
   *
   * 「等待确认」自动展开的理由：这一档状态的意义就是「需要人」，
   * 折叠态只有一行 28px 的摘要，撑不起它的分量；展开成面板把
   * 等待行怼到眼前，用户才不会一直晾着 DSH。与 macOS 版行为一致。
   */
  function shouldExpand(snap) {
    if (state.pinned) return true;
    const cfg = (snap && snap.config) || {};
    const raw = cfg.raw || {};
    const waiting = !!(snap && Array.isArray(snap.entries)
      && snap.entries[0] && snap.entries[0].status === 'waiting');
    if (waiting) return true;
    const hoverOn = raw.expandOnHover === false ? false : true;
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

    // 装饰动效总开关（glowEffect，默认开）。状态色本身不受它管 ——
    // 关掉的是「会动的光」，不是「信息」。
    const glowOn = !(cfg.raw && cfg.raw.glowEffect === false);

    const expanded = shouldExpand(snap);

    // 折叠/展开写进 data 属性，CSS 靠它驱动过渡（.neck 收窄、宽度/圆角变化、
    // 非主行淡入上浮）。必须**每次 render 都写**：state.pinned 由点击改变时
    // 不会重新推快照，只靠主进程那条 island:expand 回包的话，这里就没有驱动源了。
    const island = el('island');
    if (island) island.dataset.expanded = expanded ? '1' : '0';
    if (island) {
      island.dataset.glow = glowOn ? '1' : '0';
      island.dataset.live = (glowOn && primary && isLive(primary.status)) ? '1' : '0';
      island.dataset.attention = (glowOn && primary && primary.status === 'waiting') ? '1' : '0';

      // 错峰入场的门：只在「折叠 → 展开」的沿上放行一次。
      // 快照每拍都重建 innerHTML，不设门的话行会每拍重播一遍入场动画。
      if (expanded && !state.prevExpanded) {
        island.dataset.fresh = '1';
        clearTimeout(state.freshTimer);
        state.freshTimer = setTimeout(() => {
          const node = el('island');
          if (node) node.dataset.fresh = '0';
        }, FRESH_CLEAR_MS);
      }
    }
    state.prevExpanded = expanded;

    el('pinned-hint').textContent = state.pinned ? '已钉住 · 点状态行取消' : '';
    el('primary').innerHTML = primary ? primaryRow(primary) : emptyRow(cfg);
    el('list').innerHTML = expanded ? entries.slice(1).map((e, i) => rowHtml(e, i)).join('') : '';
    el('stats').innerHTML = (expanded && primary) ? statsHtml(primary) : '';
    el('footer').innerHTML = footerHtml(snap, expanded);

    bindClicks(entries);

    // 高度动画：先于尺寸回传 —— 它会改 offsetHeight，回传量的是动画起点。
    animateBodyHeight();

    // 主进程的折叠处置要**等动画播完**再收：island:expand(false) 会把窗口
    // 一次性设回折叠尺寸，立刻调的话缩矮动画播到一半就被裁掉了。
    // 展开方向没有这个问题（那条 IPC 只改状态不设尺寸），立即报。
    clearTimeout(state.collapseTimer);
    if (expanded) {
      window.island.setExpanded(true).catch(() => { /* 主进程已记日志 */ });
    } else {
      state.collapseTimer = setTimeout(() => {
        window.island.setExpanded(false).catch(() => { /* 主进程已记日志 */ });
      }, COLLAPSE_SETTLE_MS);
    }
    requestResize();
  }

  /**
   * .body 的高度弹簧：换内容前后的两个显式高度交给 CSS 过渡。
   *
   * - 首帧 / 高度没变：不做任何事（快照每拍都来，大多走这条）；
   * - 过渡结束后释放回 auto：显式高度会把后续内容变化（行数增减）裁掉。
   */
  function animateBodyHeight() {
    const body = el('content');
    if (!body || typeof body.offsetHeight !== 'number') return;
    const from = body.offsetHeight;
    if (body.style.height) body.style.height = 'auto';
    const natural = body.offsetHeight;
    if (Math.abs(natural - from) < 1) { body.style.height = ''; return; }
    body.style.height = Math.round(from) + 'px';
    void body.offsetHeight;   // 强制回流：让「旧高」先落到布局上
    body.style.height = Math.round(natural) + 'px';
    clearTimeout(state.heightTimer);
    state.heightTimer = setTimeout(() => { body.style.height = ''; }, HEIGHT_SETTLE_MS);
  }

  function primaryRow(e) {
    const live = isLive(e.status);
    return '<span class="dot' + (live ? ' live' : '') + ' st-' + esc(e.status) + '"></span>'
      + '<span class="title">' + esc(e.label) + '</span>'
      + '<span class="badge' + (live ? ' accent' : '') + '">' + esc(e.tag) + '</span>';
  }

  function emptyRow() {
    return '<span class="dot"></span>'
      + '<span class="title" style="color:var(--text-dim)">没有活跃会话</span>'
      + '<span class="badge">Ready</span>';
  }

  function rowHtml(e, i) {
    const bits = [];
    if (e.contextText) bits.push('ctx ' + esc(e.contextText));
    if (e.todoText) bits.push('todo ' + esc(e.todoText));
    // --dot 是这一行自己的状态色（声呐环 / 悬停左缘条跟着它走）；
    // --i 是错峰入场的序号（见 styles.css 的 data-fresh 门控）。
    return '<div class="row' + (e.status === 'idle' ? ' idle' : '') + '" data-id="' + esc(e.id) + '"'
      + ' style="--dot:' + esc(e.glow || '#50505A') + ';--i:' + (i || 0) + '">'
      + '<span class="dot' + (isLive(e.status) ? ' live' : '') + ' st-' + esc(e.status) + '"></span>'
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

  // 高度/宽度回传：用 rAF 合并，避免一次渲染里量两次。
  // 宽度不再写死 380 —— 展开时它在 CSS 里从 380 弹到 412，
  // 写死的话动画半途窗口比内容窄，右侧被裁。
  let resizePending = false;
  function requestResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      const island = el('island');
      if (!island) return;
      const h = island.offsetHeight;
      const w = island.offsetWidth;
      window.island.resize(w, h).catch(() => { /* 主进程已记日志 */ });
    });
  }

  // CSS 形变进行中，实际尺寸每一帧都在变 —— 盯住它，让窗口贴着走。
  // 没有这一层，「内容在动、窗口不动」，透明窗口会裁掉动画半途的内容。
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => requestResize()).observe(el('island'));
  }

  // 悬停展开（带驻留门槛，见文件头的理由）
  document.addEventListener('mouseenter', () => {
    clearTimeout(state.hoverCloseTimer);
    clearTimeout(state.hoverOpenTimer);
    state.hoverOpenTimer = setTimeout(() => {
      state.hovering = true;
      if (state.snap) render(state.snap);
    }, HOVER_OPEN_MS);
  });
  document.addEventListener('mouseleave', () => {
    // 鼠标移出窗口（去点别的窗口）→ 收起，除非钉住
    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    state.hoverCloseTimer = setTimeout(() => {
      state.hovering = false;
      if (state.snap) render(state.snap);
    }, HOVER_CLOSE_MS);
  });

  window.island.onSnapshot(render);
})();
