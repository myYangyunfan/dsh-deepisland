'use strict';
/**
 * 渲染进程 —— 岛的界面（v2：骨架只建一次，之后只改文本/属性）。
 *
 * 只做四件事：把主进程推来的快照画出来、把点击翻译成一个 IPC、
 * 驱动展开/收起的弹簧形变、判定「指针在不在岛上」以切换点击穿透。
 * **不读文件、不算状态** —— 那些都在主进程（`monitor.js` / `projections.js`）。
 *
 * ## v2 为什么重写（2026-10-18 全面优化）
 *
 * 旧版每次快照都 `innerHTML =` 重建整块界面，而快照里的 `now` 每拍都变，
 * 于是 4 次/秒：销毁重建全部节点 → 展开动画被打断、hover 的行被抽走、
 * 每拍还 `offsetHeight` 强制同步布局两次。界面「能看但发涩」的根源不在
 * CSS，而在这里。v2 的纪律：
 *
 * 1. **快照去重**：主进程带 `rev`，相同直接跳过整次渲染（见 main.js）；
 * 2. **增量更新**：节点只建一次，之后 `textContent` / class / 变量按差异写；
 * 3. **零同步布局**：高度用 `ResizeObserver` 量、写 `--island-h`，由 CSS
 *    过渡；渲染热路径里没有 `offsetHeight` / `getBoundingClientRect`；
 * 4. **本地时钟**：耗时数字在渲染层按秒自己走，不靠主进程每秒推快照；
 * 5. **指针 rAF 节流**：`pointermove` 只记位置 + 脏标记，命中判定合并到
 *    下一帧；矩形缓存，只在尺寸/模式变化后失效。
 *
 * ## 架构：窗口不动，岛在窗口里动
 *
 * 窗口按最大展开态一次开好（main.js 的 MAX_WINDOW），岛顶对齐、水平居中
 * 钉在窗口里。展开/收起只是 `.island` 自己改宽改高（CSS 真弹簧，340ms，
 * 与 Swift `.spring(response:0.34, dampingFraction:0.8)` 同一条曲线）。
 *
 * ## 点击穿透：常态穿透，悬停接管
 *
 * 窗口平时 `setIgnoreMouseEvents(true, {forward:true})`：比岛大一圈的透明
 * 区域不吞下方应用的点击，鼠标移动事件仍被转发进来。渲染层用转发的
 * 位置对岛体**当前**矩形做命中：进岛 → 请主进程临时接管，出岛 → 立刻
 * 恢复穿透。三道防线（本文件两道 + 主进程 500ms 看门狗）保证「永不粘连」。
 */

(function () {
  const $ = (id) => document.getElementById(id);

  /** 悬停驻留（毫秒）：进入等一等（防「划过屏幕顶端」误触），离开宽限一点。 */
  const HOVER_OPEN_MS = 200;
  const HOVER_CLOSE_MS = 350;
  /** 折叠态命中区外扩（Mac hoverHotRect 的 insetBy(-8)）：跟手比精确重要。 */
  const HOT_MARGIN_PX = 8;
  /** 展开态已经很大，外扩收到 4px，避免把岛下方应用的可点区算进来。 */
  const HOT_MARGIN_EXPANDED = 4;
  /** 耗时走字对齐到整秒；+16ms 是给定时器抖动留的余量。 */
  const CLOCK_TICK_MS = 1000;
  /** 指针事件的兜底复算周期：极端情况下（转发的 move 丢失）也不会卡在旧状态。 */
  const SAFETY_RECHECK_MS = 1000;
  /** 跳转反馈 / 打开设置反馈的驻留时长。 */
  const RESULT_HOLD_MS = 6000;

  const root = document.documentElement;

  const state = {
    snap: null,
    rev: '',
    entries: [],
    primary: null,
    pinned: false,
    expanded: false,
    mode: '',
    /** 指针在岛上的判定结果（决定是否接管鼠标）。 */
    overIsland: false,
    /**
     * 主进程是否已经开始推真实光标位置。
     *
     * 一旦为 true，就**不再相信** document 上的 mousemove/pointermove：
     * 窗口带 `-webkit-app-region: drag` 时 Electron 的 forward 转发会被掐断
     * 或者坐标错位（真机实测：全 no-drag 46 条/带拖拽区 1 条），而主进程推来的
     * 是 `屏幕光标 - 窗口原点`，与岛体矩形同一坐标系，可靠得多。
     * shots.js / perf.js 这类没有主进程的合成场景里它保持 false，仍走原路径。
     */
    cursorFromMain: false,
    pointer: null,
    pointerQueued: false,
    rect: null,
    rectDirty: true,
    interactive: false,
    /** 自定义拖窗状态：{ id, x0, y0, moved } 或 null。 */
    drag: null,
    /** 拖窗结束后短暂抑制 click（否则「拖一下」会顺带钉住/跳转）。 */
    suppressClickUntil: 0,
    hoverOpenTimer: 0,
    hoverCloseTimer: 0,
    jump: null,
    jumpAt: 0,
    jumpTimer: 0,
    dshHint: null,
    dshTimer: 0,
    focusIndex: -1,
    clockTimer: 0,
    lastScale: null,
    lastGlow: null,
    /** 会话行 / 统计项的节点缓存（增量更新的依据）。 */
    rows: new Map(),
    stats: new Map(),
  };

  /* ───────────────────────────── 差异写 DOM 的小工具 ─────────────────────────────
   *
   * 三个 helper 都遵守同一条纪律：**值没变就不碰 DOM**。即使这里少写一次
   * 比较，Chromium 也会因为「写了相同值」触发一次样式失效/重排，4 次/秒
   * 累积起来就是可感知的抖动。读 `textContent`/`getPropertyValue`/`contains`
   * 都不触发布局，所以比较是免费的。
   */

  function setText(node, text) {
    if (!node) return;
    const v = (text === null || text === undefined) ? '' : String(text);
    if (node.textContent !== v) node.textContent = v;
  }

  function setOff(node, off) {
    if (!node) return;
    const has = node.classList.contains('is-off');
    if (has !== !!off) node.classList.toggle('is-off', !!off);
  }

  function setHidden(node, hidden) { setOff(node, hidden); }

  function setClass(node, cls, on) {
    if (!node) return;
    const has = node.classList.contains(cls);
    if (has !== !!on) node.classList.toggle(cls, !!on);
  }

  function setCssVar(node, prop, value) {
    if (!node) return;
    if (node.style.getPropertyValue(prop) === value) return;
    node.style.setProperty(prop, value);
  }

  function setAttr(node, name, value) {
    if (!node) return;
    if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
  }

  /* ───────────────────────────── 纯函数 ───────────────────────────── */

  const GLOW_IDLE = '#50505A';

  function isLive(status) {
    return !!status && status !== 'idle';
  }

  /** 毫秒 → mm:ss（超一小时给 h:mm:ss）。与 activity.js 的 formatDuration 逐字一致。 */
  function formatDuration(ms) {
    if (!(ms > 0) || !Number.isFinite(ms)) return '00:00';
    const total = Math.floor(ms / 1000);
    if (total >= 3600) {
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /**
   * 某条会话的耗时文本。
   *
   * 优先用 `elapsedFrom`（epoch ms）在本地按秒算 —— 这样主进程只需要在
   * 回合开始时推一次，不需要每秒推快照。旧快照只有 `elapsedText` 时退回去。
   */
  function elapsedTextOf(entry) {
    if (!entry) return '';
    if (typeof entry.elapsedFrom === 'number' && entry.elapsedFrom > 0) {
      return formatDuration(Date.now() - entry.elapsedFrom);
    }
    return typeof entry.elapsedText === 'string' ? entry.elapsedText : '';
  }

  /** 当前配置（新协议是顶层字段；`raw` 兜住旧快照与 shots.js）。 */
  function config() {
    const c = (state.snap && state.snap.config) || {};
    const raw = (c.raw && typeof c.raw === 'object') ? c.raw : {};
    const pick = (key, fallback) => {
      if (typeof c[key] === 'boolean') return c[key];
      if (typeof raw[key] === 'boolean') return raw[key];
      return fallback;
    };
    return {
      scale: typeof c.scale === 'number' ? c.scale : (typeof raw.scale === 'number' ? raw.scale : 1),
      glowEffect: pick('glowEffect', true),
      expandOnHover: pick('expandOnHover', true),
      notchEnabled: pick('notchEnabled', true),
      jumpEnabled: pick('jumpEnabled', true),
    };
  }

  /**
   * 是否展开。优先级：钉住 > 等待确认 > 悬停。
   *
   * 「等待确认」自动展开的理由：这一档状态的意义就是「需要人」，折叠态
   * 只有一行摘要撑不起它的分量；展开成 HUD 把等待行怼到眼前，用户才不会
   * 一直晾着 DSH。与 macOS 版行为一致。
   */
  function shouldExpand() {
    if (!state.entries.length) return false;   // 没会话时展开只会是一块空板
    if (state.pinned) return true;
    if (state.primary && state.primary.status === 'waiting') return true;
    return config().expandOnHover && state.overIsland;
  }

  /* ───────────────────────────── 快照入口 ───────────────────────────── */

  function onSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;

    // rev 相同 = 内容一个字节都没变（含配置/桥/跳转）。此时唯一还需要走的
    // 是本地秒级时钟，而它是独立定时器，所以整次渲染都可以跳过。
    if (typeof snap.rev === 'string' && snap.rev && snap.rev === state.rev) return;

    state.snap = snap;

    const cfg = config();
    if (state.lastScale !== cfg.scale) {
      setCssVar(root, '--scale', String(cfg.scale));
      state.lastScale = cfg.scale;
      state.rectDirty = true;
    }

    const entries = Array.isArray(snap.entries) ? snap.entries : [];
    state.entries = entries;
    state.primary = entries.length ? entries[0] : null;

    const glow = (state.primary && state.primary.glow) || GLOW_IDLE;
    if (state.lastGlow !== glow) {
      setCssVar(root, '--glow', glow);
      state.lastGlow = glow;
    }

    applyJumpSnapshot(snap.jump);
    render();
    // rev 记在渲染成功之后：万一 render 抛错，下一拍还有机会重试，
    // 而不是把「这一版内容」永久标记成已渲染（界面会停在旧数据上）。
    if (typeof snap.rev === 'string') state.rev = snap.rev;
  }

  /**
   * 主进程带下来的跳转结果（用户点了岛上的会话）。同一个 `at` 只记一次，
   * 否则每拍快照都会把 6 秒的反馈重新点亮。
   */
  function applyJumpSnapshot(jump) {
    if (!jump || typeof jump.brief !== 'string' || !jump.brief) return;
    const at = typeof jump.at === 'number' ? jump.at : 0;
    if (at && at === state.jumpAt) return;
    state.jumpAt = at;
    state.jump = { kind: jump.kind, brief: jump.brief };
    clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(() => { state.jump = null; render(); }, RESULT_HOLD_MS);
  }

  /* ───────────────────────────── 渲染 ───────────────────────────── */

  function render() {
    const cfg = config();
    const entries = state.entries;
    const primary = state.primary;
    const expanded = shouldExpand();

    if (state.expanded !== expanded) {
      state.expanded = expanded;
      state.rectDirty = true;
      // 收起后行焦点没有意义，顺手复位
      if (!expanded) state.focusIndex = -1;
    }
    const mode = expanded ? 'hud' : 'compact';
    if (state.mode !== mode) { state.mode = mode; state.rectDirty = true; }

    const island = $('island');
    const status = primary ? primary.status : 'idle';
    setAttr(island, 'data-mode', mode);
    setAttr(island, 'data-expanded', expanded ? '1' : '0');
    setAttr(island, 'data-status', status);
    setAttr(island, 'data-live', isLive(status) ? '1' : '0');
    setAttr(island, 'data-glow', cfg.glowEffect ? '1' : '0');
    setAttr(island, 'data-pinned', state.pinned ? '1' : '0');
    setAttr(island, 'aria-label', ariaLabel(primary, entries));

    setText($('pinned-hint'), state.pinned ? '已钉住 · 点状态行取消' : '');
    setHidden($('pinned-hint'), !state.pinned);

    if (expanded) renderHud(entries, primary);
    else renderCompact(entries, primary);

    updateHint();
    scheduleClock();

    // 模式/尺寸可能变了：命中矩形失效，下一帧重估（不在这里同步读布局）
    state.rectDirty = true;
    queuePointerRecheck();
  }

  function ariaLabel(primary, entries) {
    if (!primary) return 'DSH 灵动岛：没有活跃会话';
    const tag = primary.badge || primary.tag || '';
    const name = primary.label || primary.shortId || '';
    const count = entries.length > 1 ? '，共 ' + entries.length + ' 个会话' : '';
    return 'DSH 灵动岛：' + tag + ' ' + name + count;
  }

  /* ───────────── 折叠态：一条信息带（Mac compactRow 口径） ───────────── */

  function renderCompact(entries, primary) {
    setCssVar($('c-dot'), '--dot', (primary && primary.glow) || GLOW_IDLE);
    setText($('c-title'), primary ? (primary.label || primary.shortId || '会话') : '没有活跃会话');

    // 胶囊位：多会话 → 在跑/总数（Mac rectangle.stack.fill）；
    // 单会话 → 子代理数（Mac person.2.fill）或工具标签。
    // ⚠️ 单会话的工具/状态标签**不带图标**：Mac compactRow 里它就是一颗纯文本
    // 胶囊（工具名用等宽字体），硬塞一个扳手图标会让「Thinking」读起来像在
    // 执行工具 —— 图标只在它能表达确定语义（多会话、子代理）时才出现。
    const chip = $('c-chip');
    let icon = '';
    let text = '';
    let ink = '';
    if (!primary) {
      text = 'Ready';
    } else if (entries.length > 1) {
      const live = entries.filter((e) => isLive(e.status)).length;
      text = live > 0 ? live + '/' + entries.length : String(entries.length);
      icon = 'stack';
      if (entries.some((e) => e.status === 'waiting')) ink = '#FFAA00';
    } else if (primary.subagentText) {
      icon = 'users';
      text = primary.subagentText;
      ink = 'rgb(166,199,255)';
    } else if (primary.tag) {
      text = primary.tag;
    }
    setText(chip, text);
    setHidden(chip, !text);
    if (icon) setAttr(chip, 'data-icon', icon); else chip.removeAttribute('data-icon');
    setCssVar(chip, '--chip-ink', ink || '');

    // 仪表位（最多一个）：上下文告警优先，其次待办进度
    const gauge = $('c-gauge');
    let gaugeText = '';
    let level = '';
    if (primary && primary.contextText && primary.contextLevel > 0) {
      gaugeText = primary.contextText;
      level = primary.contextLevel === 2 ? 'danger' : 'warn';
    } else if (primary && primary.todoText) {
      gaugeText = primary.todoText;
      level = 'todo';
    }
    setText(gauge, gaugeText);
    setHidden(gauge, !gaugeText);
    setClass(gauge, 'warn', level === 'warn');
    setClass(gauge, 'danger', level === 'danger');
    setClass(gauge, 'todo', level === 'todo');
    if (gaugeText) setAttr(gauge, 'data-icon', level === 'todo' ? 'check' : 'ctx');

    // 耗时：只在活跃时显示 —— 待命会话的 elapsedFrom 是上一回合起点，
    // 照着算会得出「已经跑了 3 小时」这种莫名数字，比留空更容易误读。
    const elapsed = $('c-elapsed');
    const elapsedOn = !!(primary && isLive(primary.status) && elapsedTextOf(primary));
    setText(elapsed, elapsedOn ? elapsedTextOf(primary) : '');
    setHidden(elapsed, !elapsedOn);
  }

  /* ───────────── 展开态：HUD（Mac expandedHUD 口径） ───────────── */

  function renderHud(entries, primary) {
    const multi = entries.length > 1;

    setCssVar($('h-dot'), '--dot', (primary && primary.glow) || GLOW_IDLE);
    setText($('h-badge'), primary ? (primary.badge || primary.tag || '') : 'READY');
    setText($('h-title'), multi
      ? entries.length + ' 个会话'
      : (primary ? (primary.label || primary.shortId || '') : '没有活跃会话'));
    const step = primary ? primary.turnStepText : '';
    setText($('h-step'), step || '');
    setHidden($('h-step'), !step);

    // 上下文压力条：只在单会话、拿得到比例时出现。
    // 它是「快满了」的早期预警：50% 转琥珀、80% 转红，和仪表同一条口径。
    const pressure = $('pressure');
    const frac = primary && typeof primary.contextFraction === 'number'
      ? primary.contextFraction : null;
    const pressureOn = !!primary && !multi && frac !== null && frac >= 0;
    setHidden(pressure, !pressureOn);
    if (pressureOn) {
      const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
      setCssVar($('pressure-fill'), 'width', pct + '%');
      const level = primary.contextLevel || (pct > 80 ? 2 : pct > 50 ? 1 : 0);
      setAttr(pressure, 'data-level', level);
      setAttr(pressure, 'aria-valuenow', pct);
    }

    // 详情正文块：单会话才有（多会话的正文属于某一个会话，铺全局会误导）
    const detail = $('detail');
    const detailOn = !!primary && !multi;
    setHidden(detail, !detailOn);
    if (detailOn) setText($('detail-text'), primary.detailText || primary.label || '');

    // 待办行
    const todo = $('todo');
    const todoOn = !!primary && !multi && !!primary.todoText;
    setHidden(todo, !todoOn);
    if (todoOn) {
      setText($('todo-cur'), primary.todoCurrent || '');
      setText($('todo-prog'), primary.todoText);
    }

    renderRows(multi ? entries : []);
    renderStats(primary);
    renderFooter();
  }

  /* ───────────── 会话行：按 id 增量复用 ───────────── */

  function createRow(id) {
    const node = document.createElement('div');
    node.className = 'row';
    node.setAttribute('data-id', id);
    node.setAttribute('tabindex', '-1');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'label';
    const action = document.createElement('span');
    action.className = 'action';
    const tag = document.createElement('span');
    tag.className = 'tag mono';
    const elapsed = document.createElement('span');
    elapsed.className = 'elapsed mono';
    node.append(dot, label, action, tag, elapsed);
    return { node, dot, label, action, tag, elapsed };
  }

  function updateRow(row, entry, index) {
    setCssVar(row.dot, '--dot', entry.glow || GLOW_IDLE);
    setClass(row.node, 'live', isLive(entry.status));
    setClass(row.node, 'primary-row', index === 0);
    setClass(row.node, 'focused', index === state.focusIndex);
    setAttr(row.node, 'data-status', entry.status || 'idle');
    setText(row.label, entry.label || entry.shortId || '');
    setText(row.action, entry.actionText || entry.tag || '');
    setText(row.tag, entry.tag || '');
    setText(row.elapsed, isLive(entry.status) ? (elapsedTextOf(entry) || '--:--') : '--:--');
    setAttr(row.node, 'aria-label', '跳转到 ' + (entry.label || entry.shortId || '会话'));
  }

  function renderRows(entries) {
    const host = $('list');
    const wanted = entries.slice(0, 6);
    const keep = new Set(wanted.map((e) => e.id));

    // 先删掉不再展示的（会话结束/被挤出前 6）
    for (const [id, row] of state.rows) {
      if (!keep.has(id)) { row.node.remove(); state.rows.delete(id); }
    }
    // 再按顺序复用/创建；节点已存在时 insertBefore 是移动，不是重建
    wanted.forEach((entry, i) => {
      let row = state.rows.get(entry.id);
      if (!row) { row = createRow(entry.id); state.rows.set(entry.id, row); }
      updateRow(row, entry, i);
      const current = host.children[i];
      if (current !== row.node) host.insertBefore(row.node, current || null);
    });
  }

  /* ───────────── 统计行：固定槽位，只切显隐与值 ─────────────
   *
   * 槽位顺序照 Mac statsRow：耗时 / 工具 / 输出 / 上下文 / 在飞（子代理）。
   * 「待办」不在这里 —— 单会话有独立的待办行（当前项 + 2/5），多会话的
   * 待办属于某一个会话、铺到全局统计行只会重复；Swift 版同样只放在待办行。
   */

  const STAT_DEFS = [
    ['elapsed', '耗时'],
    ['turn', '轮次'],
    ['tools', '工具'],
    ['output', '输出'],
    ['context', '上下文'],
    ['agents', '子代理'],
  ];

  function createStat(key, label) {
    const node = document.createElement('span');
    node.className = 'stat';
    node.setAttribute('data-key', key);
    node.append(document.createTextNode(label + ': '));
    const value = document.createElement('b');
    value.className = 'mono';
    node.appendChild(value);
    return { node, value };
  }

  function statValue(entry, key) {
    if (!entry) return '';
    switch (key) {
      case 'elapsed': return elapsedTextOf(entry);
      case 'turn': return entry.turnStepText || '';
      case 'tools': return entry.toolCountText || '';
      case 'output': return entry.outputText || '';
      case 'context': return entry.contextText || '';
      case 'agents': return entry.subagentText ? entry.subagentText + ' 个' : '';
      default: return '';
    }
  }

  function renderStats(primary) {
    const host = $('stats');
    let visible = 0;
    for (const [key, label] of STAT_DEFS) {
      let item = state.stats.get(key);
      if (!item) {
        item = createStat(key, label);
        state.stats.set(key, item);
        host.appendChild(item.node);
      }
      const value = statValue(primary, key);
      setHidden(item.node, !value);
      if (value) visible += 1;
      setText(item.value, value);
      if (key === 'context') {
        setClass(item.node, 'warn', !!primary && primary.contextLevel === 1);
        setClass(item.node, 'danger', !!primary && primary.contextLevel === 2);
      }
    }
    setHidden(host, visible === 0);
  }

  /* ───────────── 末行：桥状态 / 跳转反馈 / 设置 ───────────── */

  function renderFooter() {
    const bridge = (state.snap && state.snap.bridge) || {};
    const ok = !!bridge.ok;
    setClass($('bridge-dot'), 'on', ok);
    let text = ok ? ('桥 ' + (bridge.port || '')) : '桥未连上';
    const pending = ok && typeof bridge.pending === 'number' ? bridge.pending : 0;
    if (pending > 0) text += ' · 待处理 ' + pending;
    setText($('bridge-text'), text);
    setClass($('bridge-text'), 'pending', pending > 0);

    const jump = $('jump');
    const on = !!(state.jump && state.jump.brief);
    setText(jump, on ? state.jump.brief : '');
    setHidden(jump, !on);
    setClass(jump, 'failed', !!(state.jump && state.jump.kind === 'failed'));
  }

  /* ───────────── 头部提示区：跳转反馈 > 钉住 > 默认提示 ───────────── */

  function updateHint() {
    const hint = $('h-hint');
    let text = '点对话跳转 · 点状态行钉住';
    let kind = '';
    if (state.jump && state.jump.brief) {
      text = state.jump.brief;
      kind = state.jump.kind === 'failed' ? 'failed' : 'ok';
    } else if (state.dshHint) {
      text = state.dshHint;
      kind = 'ok';
    } else if (state.pinned) {
      text = '已钉住 · 点状态行取消';
      kind = 'pin';
    }
    setText(hint, text);
    setClass(hint, 'ok', kind === 'ok');
    setClass(hint, 'pin', kind === 'pin');
    setClass(hint, 'failed', kind === 'failed');
  }

  /* ───────────────────────────── 本地秒级时钟 ─────────────────────────────
   *
   * 耗时数字必须自己走，否则主进程得每秒推一次快照（旧版就是这么干的，
   * 而快照里还带着整个投影对象）。这里只改「时间文本」节点：文本节点改写
   * 不触发重排，主线程成本可以忽略。
   */

  function scheduleClock() {
    clearTimeout(state.clockTimer);
    state.clockTimer = 0;
    const anyLive = state.entries.some((e) => isLive(e.status)
      && (typeof e.elapsedFrom === 'number' || typeof e.elapsedText === 'string'));
    if (!anyLive) return;
    const delay = CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS) + 16;
    state.clockTimer = setTimeout(tickClock, delay);
  }

  function tickClock() {
    state.clockTimer = 0;
    const primary = state.primary;
    if (state.mode === 'compact') {
      if (primary && isLive(primary.status)) setText($('c-elapsed'), elapsedTextOf(primary));
    } else {
      const elapsedItem = state.stats.get('elapsed');
      if (elapsedItem && primary) setText(elapsedItem.value, elapsedTextOf(primary));
      for (const [id, row] of state.rows) {
        const entry = state.entries.find((x) => x.id === id);
        if (entry && isLive(entry.status)) setText(row.elapsed, elapsedTextOf(entry) || '--:--');
      }
    }
    scheduleClock();
  }

  /* ───────────────────────────── 高度：ResizeObserver → CSS 变量 ─────────────────────────────
   *
   * 旧版在每次渲染里 `offsetHeight` → 写 height → 再 `offsetHeight`，3 次
   * 强制同步布局/秒。v2 反过来：让浏览器先把内容布局好（RO 回调），把自然
   * 高度写进 `--island-h`，高度过渡交给 CSS。展开/收起、内容增减、宽度变化
   * 引起换行，全部自动跟上，热路径里一次布局都不强制。
   */

  function observeSize() {
    const body = $('island-body') || document.querySelector('.island-body');
    const island = $('island');
    if (!body || !island) return;
    if (typeof ResizeObserver !== 'function') return;   // 理论到不了，兜底不崩

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentRect 是已完成的布局结果，读它不触发回流
        const h = Math.max(1, Math.round(entry.contentRect.height));
        setCssVar(island, '--island-h', h + 'px');
        state.rectDirty = true;
        queuePointerRecheck();
      }
    });
    ro.observe(body);
  }

  /* ───────────────────────────── 指针命中与穿透 ───────────────────────────── */

  function islandRect() {
    if (state.rect && !state.rectDirty) return state.rect;
    state.rect = $('island').getBoundingClientRect();
    state.rectDirty = false;
    return state.rect;
  }

  function hitIsland(x, y) {
    const r = islandRect();
    const m = state.expanded ? HOT_MARGIN_EXPANDED : HOT_MARGIN_PX;
    return x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m;
  }

  /** 合并到下一帧：pointermove 可能一秒几百次，命中判定只值每帧一次。 */
  function queuePointerRecheck() {
    if (state.pointerQueued) return;
    state.pointerQueued = true;
    requestAnimationFrame(() => {
      state.pointerQueued = false;
      evaluatePointer();
    });
  }

  function setInteractive(on) {
    if (state.interactive === on) return;
    state.interactive = on;
    window.island.setInteractive(on).catch(() => { /* 主进程已记日志 */ });
  }

  function evaluatePointer() {
    if (!state.pointer) return;
    const over = hitIsland(state.pointer.x, state.pointer.y);
    if (over === state.overIsland) return;
    state.overIsland = over;

    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    if (over) {
      // 进岛：先接管鼠标（行/按钮立即可点），展开等驻留时间走完
      setInteractive(true);
      state.hoverOpenTimer = setTimeout(() => {
        if (state.overIsland) render();
      }, HOVER_OPEN_MS);
    } else {
      // 出岛：宽限一会儿再收起（防手抖），但立刻交还穿透 ——
      // 否则岛外的透明区域会继续吞下方应用的点击
      setInteractive(false);
      state.hoverCloseTimer = setTimeout(() => {
        if (!state.overIsland) render();
      }, HOVER_CLOSE_MS);
    }
  }

  function onPointerMove(ev) {
    // 主进程已经在推真实光标 → 忽略 DOM 上的指针事件。
    // 原因见 state.cursorFromMain：带 `-webkit-app-region: drag` 的窗口上，
    // Electron 的 forward 转发会漏/错位，两路混用会让命中判定在水面上下跳。
    if (state.cursorFromMain) return;
    state.pointer = { x: ev.clientX, y: ev.clientY };
    queuePointerRecheck();
  }

  /**
   * 主进程推来的真实光标位置（约 30Hz）。
   *
   * 这是**悬停的主驱动**：窗口带拖拽区时 Electron 的 forwarded mousemove 会断，
   * 靠它才能在整个岛体上稳定触发悬停。`inside:false` = 指针已出窗口。
   */
  function onCursor(pos) {
    state.cursorFromMain = true;
    if (!pos || pos.inside === false) {
      onPointerLeave();
      return;
    }
    state.pointer = { x: pos.x, y: pos.y };
    queuePointerRecheck();
  }

  /** 指针离开窗口 / 主进程看门狗强制收回：复位悬停态，别留下「假常驻」。 */
  function onPointerLeave() {
    state.pointer = null;
    clearTimeout(state.hoverOpenTimer);
    clearTimeout(state.hoverCloseTimer);
    const changed = state.overIsland;
    state.overIsland = false;
    // ⚠️ 必须真的通知主进程收回穿透，不能只改本地 state。
    // 反例：指针从岛上直接滑出窗口（document mouseleave）→ 本地以为已经
    // 出岛，但主进程还停在「接管」态；此时指针在窗口 bleed 的透明区里移动，
    // evaluatePointer 会因为 over === state.overIsland 提前 return，永远补不上
    // 那条 false —— 于是 484×300 窗口里的透明区继续吞桌面点击。看门狗只在
    // 「真实光标已出窗口矩形」时兜底，救不了「已回到窗口内透明区」这一段。
    setInteractive(false);
    if (changed) render();
  }

  /* ───────────────────────────── 交互 ───────────────────────────── */

  function togglePin() {
    state.pinned = !state.pinned;
    render();
  }

  function jumpTo(entry) {
    if (!entry) return;
    window.island.jump({ id: entry.id, label: entry.label })
      .then((r) => {
        state.jump = { kind: r && r.kind, brief: r && r.brief };
        clearTimeout(state.jumpTimer);
        state.jumpTimer = setTimeout(() => { state.jump = null; render(); }, RESULT_HOLD_MS);
        render();
      })
      .catch(() => { /* 主进程已记日志 */ });
  }

  function openDsh() {
    window.island.openDsh().then((r) => {
      // 做不到就说做不到：能不能把 DSH 带起来取决于它自己有没有单实例锁
      state.dshHint = (r && r.ok) ? '已切到 DSH' : 'DSH 设置 → 🏝️ 灵动岛';
      render();
      clearTimeout(state.dshTimer);
      state.dshTimer = setTimeout(() => { state.dshHint = null; render(); }, RESULT_HOLD_MS);
    }).catch(() => { /* 主进程已记日志 */ });
  }

  function openContextMenu() {
    if (!window.island.contextMenu) return;
    window.island.contextMenu({ pinned: state.pinned }).catch(() => { /* 主进程已记日志 */ });
  }

  function jumpPrimary() {
    if (state.primary) jumpTo(state.primary);
  }

  function moveFocus(dir) {
    const rows = state.entries.slice(0, 6);
    if (!rows.length) return;
    if (state.focusIndex < 0) state.focusIndex = dir > 0 ? 0 : rows.length - 1;
    else state.focusIndex = Math.max(0, Math.min(rows.length - 1, state.focusIndex + dir));
    refreshRowFocus();
  }

  function refreshRowFocus() {
    const order = state.entries.slice(0, 6).map((e) => e.id);
    for (const [id, row] of state.rows) {
      setClass(row.node, 'focused', order[state.focusIndex] === id);
    }
  }

  /* ───────────────────────────── 自定义拖窗 ─────────────────────────────
   *
   * 为什么不用 `-webkit-app-region: drag`：真机实测（2026-10-19）发现，窗口一旦
   * 声明拖拽区，Windows 会把岛体里的点击当成**非客户区拖拽**处理 —— 点一下
   * 窗口真的被拖走几个像素，页面收不到 click（钉住/跳转全失效）；同时
   * `forward:true` 的 mousemove 转发也会被掐断（表现为「只有很窄的位置能触发
   * 悬停」）。拖窗能力不能丢，所以改成自己实现：渲染层报指针屏幕坐标，
   * 主进程按位移搬窗口。阈值 4px 用于区分「点击」与「拖窗」。
   */

  const DRAG_THRESHOLD_PX = 4;

  /** 这些区域有自己的点击语义，按下不应启动拖窗。 */
  function isClickControl(target) {
    return !!(target && target.closest && target.closest('[data-act], .row, #detail, #stats'));
  }

  function onDragDown(ev) {
    if (ev.button !== 0 || !state.interactive) return;
    if (isClickControl(ev.target)) return;
    state.drag = { id: ev.pointerId, x0: ev.screenX, y0: ev.screenY, moved: false };
    // ⚠️ 不在这里 setPointerCapture：一旦给岛体加了指针捕获，click 事件会被
    // 重定向到捕获元素，页面上的按钮/行就再也收不到 click（真机踩过）。
    // 只有确认「真的在拖」之后才捕获，那时本来就要吞掉 click。
  }

  function onDragMove(ev) {
    const d = state.drag;
    if (!d || ev.pointerId !== d.id) return;
    const dx = ev.screenX - d.x0;
    const dy = ev.screenY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!d.moved) {
      d.moved = true;
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }
      window.island.dragStart().catch(() => { /* 主进程已记日志 */ });
    }
    window.island.dragMove({ x: ev.screenX, y: ev.screenY }).catch(() => { /* 同上 */ });
  }

  function onDragEnd(ev) {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.moved) {
      state.suppressClickUntil = Date.now() + 400;
      window.island.dragEnd().catch(() => { /* 同上 */ });
      try { ev.currentTarget.releasePointerCapture(d.id); } catch { /* 忽略 */ }
    }
  }

  function bindInteractions() {
    const island = $('island');

    // 折叠态：点一下 = 钉住/取消（整条信息带是可点区）
    $('compact').addEventListener('click', () => togglePin());
    // 钉住提示本身也属于「状态行」：点它就该取消钉住（文案写的就是这个意思）
    $('pinned-hint').addEventListener('click', () => { if (state.pinned) togglePin(); });
    // 双击 = 把 DSH 叫到前面（省得去托盘里找）
    $('compact').addEventListener('dblclick', (ev) => { ev.preventDefault(); openDsh(); });

    // 展开态：按区域分派。可点区（详情/统计/行/设置）自己处理，
    // 其余空白 = 钉住/取消 —— 与 Swift 版的「点非对话区 = 钉住」同一分工。
    $('hud').addEventListener('click', (ev) => {
      const target = ev.target;
      if (target.closest('#list .row')) return;            // 行自己处理
      if (target.closest('#detail')) { jumpPrimary(); return; }
      if (target.closest('#stats')) { jumpPrimary(); return; }
      if (target.closest('[data-act="settings"]')) { openDsh(); return; }
      togglePin();
    });

    // 行点击（事件委托，行节点复用不重新绑定）
    $('list').addEventListener('click', (ev) => {
      const row = ev.target.closest('.row');
      if (!row) return;
      const id = row.getAttribute('data-id');
      const entry = state.entries.find((x) => x.id === id);
      if (entry) jumpTo(entry);
    });

    // 右键：原生菜单（钉住/隐藏/设置/配置目录/退出）
    island.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      openContextMenu();
    });

    // 键盘：Esc 取消钉住；展开态 ↑/↓ 选行、Enter 跳转
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        state.focusIndex = -1;
        refreshRowFocus();
        if (state.pinned) { state.pinned = false; render(); }
        return;
      }
      if (state.mode !== 'hud') return;
      if (ev.key === 'ArrowDown') { moveFocus(1); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { moveFocus(-1); ev.preventDefault(); }
      else if (ev.key === 'Enter' && state.focusIndex >= 0) {
        const entry = state.entries[state.focusIndex];
        if (entry) jumpTo(entry);
        ev.preventDefault();
      }
    });

    // 自定义拖窗（替代 app-region: drag）：移动超过阈值才开始拖，拖完抑制 click。
    island.addEventListener('pointerdown', onDragDown);
    island.addEventListener('pointermove', onDragMove);
    island.addEventListener('pointerup', onDragEnd);
    island.addEventListener('pointercancel', onDragEnd);
    // 拖窗结束后的 click 在捕获阶段吞掉，避免「拖一下」顺带钉住/跳转。
    island.addEventListener('click', (ev) => {
      if (Date.now() < state.suppressClickUntil) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);

    // 指针：只记位置 + 脏标记，判定合并到下一帧。
    // 两路都收的原因不是「保险」：
    //   - 真实鼠标移动两路都会来（pointermove 由 mousemove 合成），rAF 合并后只判一次；
    //   - 窗口 forward:true 转发进来的是 mousemove；
    //   - `DSH_NOTCH_SMOKE` 与 `scripts/shots.js` 用合成的 MouseEvent('mousemove')
    //     驱动悬停（合成事件不会派生 pointermove）—— 只监听 pointermove 的话
    //     「冒烟能展开」这条验证会静默失效，退回 v1 那种「截不到展开态」。
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('mousemove', onPointerMove, { passive: true });

    document.addEventListener('mouseleave', onPointerLeave);
    window.addEventListener('resize', () => { state.rectDirty = true; queuePointerRecheck(); });

    // 尺寸过渡结束：矩形变了，重新判定（指针没动时也要跟上）
    island.addEventListener('transitionend', (ev) => {
      if (ev.target !== island) return;
      if (ev.propertyName !== 'width' && ev.propertyName !== 'height') return;
      state.rectDirty = true;
      queuePointerRecheck();
    });

    // 兜底：转发的 mousemove 在极端场景会丢（快速出窗、系统手势）。
    // 每秒用最近一次指针位置重算一次，配合主进程 500ms 看门狗双保险。
    setInterval(() => {
      state.rectDirty = true;
      evaluatePointer();
    }, SAFETY_RECHECK_MS);

    // 主进程看门狗收回穿透后通知我们复位
    if (typeof window.island.onPointerLeave === 'function') {
      window.island.onPointerLeave(onPointerLeave);
    }
    // 悬停主驱动：真实光标位置（约 30Hz，位置不变不发）。
    // 没有主进程的合成场景（shots.js / perf.js）不暴露它，自动退回 DOM 事件路径。
    if (typeof window.island.onCursor === 'function') {
      window.island.onCursor(onCursor);
    }
    // 右键菜单里的「钉住/取消钉住」：原生菜单在主进程弹，但 pinned 的唯一
    // 真相源在渲染层（它还要同时管展开/收起、Esc、点主行）。菜单只发一条
    // 「切换」回来，走同一条 togglePin，避免两处各存一份状态在某个分支打架。
    if (typeof window.island.onPinToggle === 'function') {
      window.island.onPinToggle(togglePin);
    }
  }

  /* ───────────────────────────── 启动 ───────────────────────────── */

  bindInteractions();
  observeSize();
  render();                              // 首帧先给「没有活跃会话」，避免白屏
  window.island.onSnapshot(onSnapshot);
})();
