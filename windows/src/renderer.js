'use strict';
/**
 * 渲染进程 —— 岛的界面（macOS 版同款架构）。
 *
 * 只做四件事：把主进程推来的快照画出来、把点击翻译成一个 IPC、
 * 驱动展开/收起的弹簧形变、判定「指针在不在岛上」以切换点击穿透。
 * **不读文件、不算状态** —— 那些都在主进程（`monitor.js` / `projections.js`）。
 *
 * ## 架构：窗口不动，岛在窗口里动
 *
 * 窗口按最大展开态一次开好（main.js 的 MAX_WINDOW），岛顶对齐、水平居中
 * 钉在窗口里。展开/收起只是 `.island` 自己改宽改高（CSS 弹簧，340ms，
 * 对齐 Swift 的 .spring(response:0.34)），窗口尺寸全程不变 —— GPU 合成
 * 的形变才是 60fps 的来源；「逐帧改窗口尺寸」的老路在 DWM 上必然抖。
 *
 * ## 点击穿透：常态穿透，悬停接管
 *
 * 窗口平时 setIgnoreMouseEvents(true, {forward:true})：比岛大一圈的透明
 * 区域不吞下方应用的点击，鼠标移动事件仍被转发进来。渲染层用转发的
 * 位置做命中判定：进岛 → 请主进程临时接管（可点/可拖），出岛 → 立刻
 * 恢复穿透。与 macOS 版 NotchPanel.isInteractive 同一条纪律。
 *
 * ## 展开/收起
 *
 * - 悬停展开（`expandOnHover`，默认开）：**驻留 200ms** 再展开、移开
 *   **350ms** 后收起 —— macOS 版的手感（0.2s / 0.35s），开防误触、收跟手；
 * - 点状态行**钉住**（`pinned`），钉住后不再因移开而收起；
 * - 「等待人工确认」自动展开（macOS 版同款：这一档状态就是要打断你）；
 * - 点详情块/会话行/统计行 = 跳到那个会话。
 */

(function () {
  const el = (id) => document.getElementById(id);

  /** 悬停驻留（毫秒）：进入等一等（防「划过屏幕顶端」误触），离开宽限一点。 */
  const HOVER_OPEN_MS = 200;
  const HOVER_CLOSE_MS = 350;
  /** 折叠态命中区外扩（Mac hoverHotRect 的 insetBy(-8)）：跟手比精确重要。 */
  const HOT_MARGIN_PX = 8;
  /** .island 高度弹簧的收尾：之后释放回 auto，免得显式高度裁住内容变化。 */
  const HEIGHT_SETTLE_MS = 420;

  const state = {
    snap: null,
    pinned: false,
    expandedNow: false,
    pointer: null,          // 最近一次转发的指针位置（页面坐标）
    overIsland: false,
    jump: null,
    jumpTimer: 0,
    /** 头部提示区：跳转反馈优先于钉住状态（Mac hintArea 同款优先级）。 */
    dshHint: null,
    dshTimer: 0,
    hoverOpenTimer: 0,
    hoverCloseTimer: 0,
    heightTimer: 0,
    interactiveReq: null,
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
   * 折叠态只有一行 28px 的摘要撑不起它的分量；展开成 HUD 把等待行
   * 怙到眼前，用户才不会一直晾着 DSH。与 macOS 版行为一致。
   */
  function shouldExpand(snap) {
    if (state.pinned) return true;
    const cfg = (snap && snap.config) || {};
    const raw = cfg.raw || {};
    const waiting = !!(snap && Array.isArray(snap.entries)
      && snap.entries[0] && snap.entries[0].status === 'waiting');
    if (waiting) return true;
    const hoverOn = raw.expandOnHover === false ? false : true;
    return hoverOn && state.overIsland;
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

    // 光晕跟随主会话的状态色（Mac: status.glowRGB）
    document.documentElement.style.setProperty('--glow', (primary && primary.glow) || '#50505A');

    // 装饰光总开关（glowEffect，默认开）。状态色本身不受它管 ——
    // 关掉的是「光」，不是「信息」。
    const glowOn = !(cfg.raw && cfg.raw.glowEffect === false);

    const expanded = shouldExpand(snap);
    state.expandedNow = expanded;

    // 状态属性驱动 CSS：data-expanded（形变）、data-live（内/外发光）、
    // data-glow（装饰光门控）。必须每拍都写：pinned 由点击改变时不重推快照。
    const island = el('island');
    if (island) {
      island.dataset.expanded = expanded ? '1' : '0';
      island.dataset.glow = glowOn ? '1' : '0';
      island.dataset.live = (primary && isLive(primary.status)) ? '1' : '0';
    }

    // 高度弹簧先于布局类内容写：量高要在内容换完之后（见 animateIslandHeight）
    el('pinned-hint').textContent = state.pinned ? '已钉住 · 点状态行取消' : '';

    if (!entries.length) {
      el('primary').innerHTML = emptyRow();
      el('list').innerHTML = '';
      el('stats').innerHTML = '';
      el('footer').innerHTML = expanded ? footerHtml(snap) : '';
    } else if (expanded) {
      el('primary').innerHTML = '';
      el('list').innerHTML = '';
      el('stats').innerHTML = statsHtml(primary);
      el('footer').innerHTML = footerHtml(snap);
      renderExpandedExtras(entries, primary);
    } else {
      el('primary').innerHTML = compactRow(primary, entries);
      el('list').innerHTML = '';
      el('stats').innerHTML = '';
      el('footer').innerHTML = '';
      clearExpandedExtras();
    }

    bindClicks(entries, primary);

    animateIslandHeight();

    // 岛的尺寸变了，指针的「在岛上/不在」可能已经翻转 —— 重估穿透与悬停。
    evaluatePointer();
  }

  /* ───────────── 折叠态：一条信息带（Mac compactRow 口径） ───────────── */

  function compactRow(e, entries) {
    let tail = '';
    if (entries.length > 1) {
      // 多会话：这个位置给「几个在跑/共几个」，等确认转橙（Mac 同款取舍）
      const live = entries.filter((x) => isLive(x.status)).length;
      const txt = live > 0 ? live + '/' + entries.length : String(entries.length);
      const orange = entries.some((x) => x.status === 'waiting');
      tail = '<span class="chip"' + (orange ? ' style="--chip-ink:#FFAA00"' : '') + '>⚏ ' + txt + '</span>';
    } else if (e.subagentText) {
      tail = '<span class="chip" style="--chip-ink:rgb(166,199,255)">👥 ' + esc(e.subagentText) + '</span>';
    } else {
      tail = '<span class="chip">' + esc(e.tag) + '</span>';
    }

    let gauge = '';
    if (e.contextText && e.contextLevel > 0) {
      gauge = '<span class="gauge' + (e.contextLevel === 2 ? ' danger' : ' warn') + '">' + esc(e.contextText) + '</span>';
    } else if (e.todoText) {
      gauge = '<span class="gauge">☑ ' + esc(e.todoText) + '</span>';
    }

    const elapsed = (isLive(e.status) && e.elapsedText)
      ? '<span class="gauge">' + esc(e.elapsedText) + '</span>' : '';

    return '<span class="dot" style="--dot:' + esc(e.glow) + '"></span>'
      + '<span class="title">' + esc(e.label) + '</span>'
      + tail + gauge + elapsed;
  }

  function emptyRow() {
    return '<span class="dot"></span>'
      + '<span class="title" style="color:var(--text-dim)">没有活跃会话</span>'
      + '<span class="chip">Ready</span>';
  }

  /* ───────────── 展开态：头部 +（详情/列表）+ 统计（Mac HUD 口径） ───────────── */

  /** 头部 / 详情 / 待办这三块只在展开时存在 —— 折叠时整体摘掉。 */
  function renderExpandedExtras(entries, primary) {
    let hdr = document.getElementById('hdr');
    if (!hdr) {
      hdr = document.createElement('div');
      hdr.id = 'hdr';
      hdr.className = 'hdr';
      el('island').insertBefore(hdr, el('pinned-hint').nextSibling);
    }
    const multi = entries.length > 1;
    const step = primary && primary.turnStepText
      ? '<span class="h-step mono">' + esc(primary.turnStepText) + '</span>' : '';
    hdr.innerHTML = '<span class="dot" style="--dot:' + esc(primary.glow) + '"></span>'
      + '<span class="badge">' + esc(primary.tag) + '</span>'
      + '<span class="h-title">' + (multi
        ? esc(entries.length) + ' 个会话'
        : esc(primary.label)) + '</span>'
      + step
      + '<span class="hint' + (state.dshHint ? ' ok' : (state.pinned ? ' pin' : '')) + '">'
      + esc(hintText()) + '</span>';

    let detail = document.getElementById('detail');
    let todo = document.getElementById('todo');
    if (!multi) {
      if (!detail) {
        detail = document.createElement('div');
        detail.id = 'detail';
        detail.className = 'detail';
        el('island').insertBefore(detail, el('list'));
      }
      detail.style.display = '';
      detail.innerHTML = esc(primary.detailText || primary.label);
      if (!todo) {
        todo = document.createElement('div');
        todo.id = 'todo';
        todo.className = 'todo';
        el('island').insertBefore(todo, el('list'));
      }
      if (primary.todoText) {
        todo.style.display = '';
        todo.innerHTML = (primary.todoCurrent
            ? '<span class="cur">' + esc(primary.todoCurrent) + '</span>' : '<span class="cur"></span>')
          + '<span class="prog mono">' + esc(primary.todoText) + '</span>';
      } else {
        todo.style.display = 'none';
      }
    } else {
      if (detail) detail.style.display = 'none';
      if (todo) todo.style.display = 'none';
    }

    el('list').innerHTML = multi
      ? entries.slice(0, 6).map((e, i) => rowHtml(e, i)).join('')
      : '';
  }

  function clearExpandedExtras() {
    for (const id of ['hdr', 'detail', 'todo']) {
      const node = document.getElementById(id);
      if (node) node.remove();
    }
  }

  function hintText() {
    if (state.dshHint) return state.dshHint;
    if (state.pinned) return '已钉住 · 点状态行取消';
    return '点对话跳转 · 点状态行钉住';
  }

  function rowHtml(e, i) {
    const live = isLive(e.status);
    return '<div class="row' + (live ? ' live' : '') + (i === 0 ? ' primary-row' : '') + '"'
      + ' data-id="' + esc(e.id) + '" style="--dot:' + esc(e.glow) + '">'
      + '<span class="dot"></span>'
      + '<span class="label">' + esc(e.label) + '</span>'
      + '<span class="action">' + esc(e.actionText || e.tag) + '</span>'
      + '<span class="tag mono">' + esc(e.tag) + '</span>'
      + '<span class="elapsed mono">' + (live && e.elapsedText ? esc(e.elapsedText) : '--:--') + '</span>'
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
    return '<span class="stat' + (cls || '') + '">' + esc(label) + ': <b class="mono">' + esc(value) + '</b></span>';
  }

  function footerHtml(snap) {
    const bridgeOk = snap.bridge && snap.bridge.ok;
    const left = '<span class="foot-left"><i class="bridge-dot' + (bridgeOk ? ' on' : '') + '"></i>桥'
      + (bridgeOk ? ' ' + esc(String(snap.bridge.port)) : '未连上')
      // 有待处理但没被消费的跳转 → 直接说出来。
      // 「点了会话、DSH 没切过去」在界面上和「一切正常」长得一样时，
      // pending 是唯一的线索（health() 已透传）。
      + (bridgeOk && snap.bridge.pending > 0
        ? ' <span class="pending" title="有 ' + Number(snap.bridge.pending)
          + ' 条跳转请求还没被 DSH 取走">待处理 ' + Number(snap.bridge.pending) + '</span>'
        : '')
      + '</span>';
    // 「设置」必须出现在岛上。岛本身不做设置界面（入口在 DSH 的
    // 设置 → 🏝️ 灵动岛，两边共用一份配置），但用户是先在屏幕上看到岛的，
    // 不给一个指路的口，他只能自己猜设置在哪。
    const settings = '<span class="link" data-act="settings">设置</span>';
    const right = snap.jump && (Date.now() - snap.jump.at < 6000)
      ? '<span class="jump' + (snap.jump.kind === 'failed' ? ' failed' : '') + '">'
        + esc(snap.jump.brief) + '</span>' : '';
    return left + right + settings;
  }

  /* ───────────── 点击：钉住 / 跳转 / 设置 ───────────── */

  function bindClicks(entries, primary) {
    // 折叠态的主行 = 「点一下钉住」（Mac：整块岛点一下 = 钉住/取消）
    const p = el('primary');
    p.onclick = () => { state.pinned = !state.pinned; render(state.snap); };

    // 详情块（单会话）= 跳到该会话；统计行（多会话）= 跳主会话
    const detail = document.getElementById('detail');
    if (detail && primary) {
      detail.onclick = () => jumpTo(entries[0]);
    }
    const stats = el('stats');
    if (stats && primary) {
      stats.onclick = () => jumpTo(entries[0]);
    }

    for (const node of el('list').querySelectorAll('.row')) {
      node.onclick = () => {
        const id = node.getAttribute('data-id');
        const entry = entries.find((x) => x.id === id);
        if (entry) jumpTo(entry);
      };
    }

    const set = el('footer').querySelector('[data-act="settings"]');
    if (set) {
      set.onclick = (ev) => {
        ev.stopPropagation();
        window.island.openDsh().then((r) => {
          // 做不到就说做不到。这里不写「已打开设置」这种一定为真的文案 ——
          // 能不能把 DSH 带起来取决于它自己有没有实现单实例锁。
          state.dshHint = (r && r.ok) ? '已切到 DSH' : 'DSH 设置 → 🏝️ 灵动岛';
          render(state.snap);
          clearTimeout(state.dshTimer);
          state.dshTimer = setTimeout(() => { state.dshHint = null; render(state.snap); }, 6000);
        }).catch(() => { /* 主进程已记日志 */ });
      };
    }
  }

  function jumpTo(entry) {
    if (!entry) return;
    window.island.jump({ id: entry.id, label: entry.label })
      .then((r) => {
        state.jump = r;
        clearTimeout(state.jumpTimer);
        state.jumpTimer = setTimeout(() => { state.jump = null; render(state.snap); }, 6000);
        render(state.snap);
      })
      .catch(() => { /* 主进程已记日志 */ });
  }

  /* ───────────── 高度弹簧：窗口不动，岛自己改高 ───────────── */

  /**
   * .island 的高度过渡：换内容前后的两个显式高度交给 CSS 弹簧。
   * 窗口是按最大展开态开好的，岛在窗口里长高/缩矮不会被裁（外发光
   * 画在窗口的 bleed 里）。过渡结束后释放回 auto：显式高度会把
   * 后续的内容变化（行数增减）裁掉。
   */
  function animateIslandHeight() {
    const island = el('island');
    if (!island) return;
    const from = island.offsetHeight;
    if (island.style.height) island.style.height = 'auto';
    const natural = island.offsetHeight;
    if (Math.abs(natural - from) < 1) { island.style.height = ''; return; }
    island.style.height = Math.round(from) + 'px';
    void island.offsetHeight;   // 强制回流：让「旧高」先落到布局上
    island.style.height = Math.round(natural) + 'px';
    clearTimeout(state.heightTimer);
    state.heightTimer = setTimeout(() => { island.style.height = ''; }, HEIGHT_SETTLE_MS);
  }

  /* ───────────── 穿透切换 + 悬停驻留 ─────────────
   *
   * 窗口平时穿透（forward:true 把 mousemove 转发进来），这里用转发位置
   * 对岛的**当前**矩形做命中（岛会变大变小，热区必须跟着当前尺寸走 ——
   * 拿窗口当热区会把岛外一圈透明区都算成「岛上」，Mac 的 islandRect
   * 注释就是这件事）。状态翻转时才发 IPC，平时零开销。
   */

  function hitIsland(x, y) {
    const r = el('island').getBoundingClientRect();
    const m = state.expandedNow ? 2 : HOT_MARGIN_PX;
    return x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m;
  }

  function evaluatePointer() {
    if (!state.pointer) return;
    const over = hitIsland(state.pointer.x, state.pointer.y);
    if (over === state.overIsland) return;
    state.overIsland = over;
    if (state.interactiveReq !== over) {
      state.interactiveReq = over;
      window.island.setInteractive(over).catch(() => { /* 主进程已记日志 */ });
    }
    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    if (over) {
      state.hoverOpenTimer = setTimeout(() => {
        if (state.overIsland && state.snap) render(state.snap);
      }, HOVER_OPEN_MS);
    } else {
      state.hoverCloseTimer = setTimeout(() => {
        if (!state.overIsland && state.snap) render(state.snap);
      }, HOVER_CLOSE_MS);
    }
  }

  document.addEventListener('mousemove', (e) => {
    state.pointer = { x: e.clientX, y: e.clientY };
    evaluatePointer();
  });

  window.island.onSnapshot(render);
})();
