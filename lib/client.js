/**
 * @module @dsh-external/dsh-vibe-island/client
 * DeepSeek Harness 智能体刘海灵动岛 - 客户端核心 Bundle
 * 
 * 架构特性：
 * 1. 跨平台双模（macOS 物理刘海吸附 / Windows Fluent 亚克力药丸 / 自由浮动）。
 * 2. 增量事件监听（WeakMap 游标扫描 session.events，提取 Thinking、Tool Call、子代理并行状态）。
 * 3. 极速平滑动画（CSS Spring 变换，展开态 HUD 面板，实时耗时统计与指标仪表盘）。
 * 4. DSH 原生集成：注入 document.body 全局层、settings.section 配置面板与头部快捷开关。
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-vibe-island",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { useState, useEffect, useMemo } = react;
    const h = react.createElement;

    // React 18 createRoot / render 兜底兼容
    let reactDomClient = null;
    try {
      reactDomClient = require("react-dom/client");
    } catch {
      try { reactDomClient = require("react-dom"); } catch {}
    }

    // 快照选择器三级回退（兼容各种内核版本）
    let bindSnapshotSelector;
    try {
      const rendererMod = require("@deepseek-ai/dsh-client-ui-renderer");
      if (typeof rendererMod.useSyncExternalStoreWithSelector === "function") {
        const useSESWS = rendererMod.useSyncExternalStoreWithSelector;
        bindSnapshotSelector = (source) => {
          const subscribe = (fn) => source.subscribe(fn);
          const getSnapshot = () => source.getSnapshot();
          return (selector, isEqual) => useSESWS(subscribe, getSnapshot, void 0, selector, isEqual);
        };
      }
    } catch {}
    if (!bindSnapshotSelector) {
      try {
        const webReactMod = require("@deepseek-ai/dsh-client-web-react");
        if (typeof webReactMod.bindSnapshotSelector === "function") {
          bindSnapshotSelector = webReactMod.bindSnapshotSelector;
        }
      } catch {}
    }
    if (!bindSnapshotSelector) {
      const { useSyncExternalStore } = react;
      bindSnapshotSelector = (source) => {
        const subscribe = (fn) => source.subscribe(fn);
        const getSnapshot = () => source.getSnapshot();
        return (selector) => selector(useSyncExternalStore(subscribe, getSnapshot));
      };
    }

    // ---------------------------------------------------------------------------
    // 常量与样式定义
    // ---------------------------------------------------------------------------
    const CONTAINER_ID = "dsh-vibe-island-root";
    const STYLE_ID = "dsh-vibe-island-styles";
    const NS = "dsh-vibe-island";

    const CSS_STYLES = `
      #dsh-vibe-island-root {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 0;
        pointer-events: none;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        user-select: none;
      }

      .vibe-island-wrapper {
        position: absolute;
        pointer-events: auto;
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        transform-origin: top center;
      }

      /* 放置位置变体 */
      .vibe-island-wrapper.placement-notch {
        top: 0;
        left: 50%;
        transform: translateX(-50%);
      }
      .vibe-island-wrapper.placement-floating {
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
      }
      .vibe-island-wrapper.placement-top-right {
        top: 14px;
        right: 24px;
        left: auto;
        transform: none;
        transform-origin: top right;
      }

      /* 主胶囊本体 */
      .vibe-island-pill {
        position: relative;
        display: flex;
        align-items: center;
        background: #000000;
        color: #ffffff;
        cursor: pointer;
        overflow: hidden;
        box-sizing: border-box;
        transition: width 0.36s cubic-bezier(0.16, 1, 0.3, 1),
                    height 0.36s cubic-bezier(0.16, 1, 0.3, 1),
                    border-radius 0.36s cubic-bezier(0.16, 1, 0.3, 1),
                    box-shadow 0.3s ease,
                    border-color 0.3s ease;
      }

      /* macOS 风格（贴合物理刘海） */
      .vibe-island-pill.platform-macos {
        border-bottom-left-radius: 18px;
        border-bottom-right-radius: 18px;
        border-top-left-radius: 0;
        border-top-right-radius: 0;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-top: none;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
      }
      .vibe-island-wrapper.placement-floating .vibe-island-pill.platform-macos {
        border-radius: 9999px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
      }

      /* Windows Fluent 风格（亚克力圆角） */
      .vibe-island-pill.platform-windows {
        border-radius: 9999px;
        background: rgba(18, 18, 24, 0.88);
        backdrop-filter: blur(24px) saturate(160%);
        -webkit-backdrop-filter: blur(24px) saturate(160%);
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0,0,0,0.3);
      }

      /* 折叠胶囊态尺寸 */
      .vibe-island-pill.state-collapsed {
        height: 34px;
        min-width: 200px;
        padding: 0 12px;
      }
      .vibe-island-pill.state-collapsed.has-active {
        min-width: 250px;
      }

      /* 展开 HUD 态尺寸 */
      .vibe-island-pill.state-expanded {
        height: 146px;
        width: 440px;
        border-radius: 24px !important;
        padding: 14px 18px;
        flex-direction: column;
        align-items: stretch;
        background: rgba(10, 10, 14, 0.96) !important;
        backdrop-filter: blur(32px) saturate(180%) !important;
        -webkit-backdrop-filter: blur(32px) saturate(180%) !important;
        border: 1px solid rgba(255, 255, 255, 0.18) !important;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08) !important;
      }

      /* 呼吸与流光光晕（Glow Aura） */
      .vibe-island-glow {
        position: absolute;
        inset: -2px;
        border-radius: inherit;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.4s ease;
        z-index: -1;
      }
      .vibe-island-pill.glow-active .vibe-island-glow {
        opacity: 1;
      }
      .vibe-island-glow.glow-thinking {
        box-shadow: 0 0 24px rgba(78, 124, 255, 0.65), inset 0 0 12px rgba(120, 80, 255, 0.4);
        animation: vibe-pulse 2.2s infinite ease-in-out;
      }
      .vibe-island-glow.glow-tool {
        box-shadow: 0 0 24px rgba(0, 210, 170, 0.6), inset 0 0 12px rgba(0, 210, 170, 0.3);
        animation: vibe-pulse 1.8s infinite ease-in-out;
      }
      .vibe-island-glow.glow-waiting {
        box-shadow: 0 0 28px rgba(255, 175, 40, 0.7), inset 0 0 14px rgba(255, 175, 40, 0.4);
        animation: vibe-pulse 1.4s infinite ease-in-out;
      }

      @keyframes vibe-pulse {
        0%, 100% { transform: scale(1); opacity: 0.7; }
        50% { transform: scale(1.02); opacity: 1; }
      }

      /* 折叠态内部元素 */
      .vibe-compact-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        height: 100%;
        gap: 10px;
      }
      .vibe-compact-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1;
      }
      .vibe-indicator-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: #8e8e93;
        transition: background-color 0.3s ease;
      }
      .vibe-indicator-dot.dot-thinking {
        background: #4e7cff;
        box-shadow: 0 0 8px #4e7cff;
        animation: vibe-dot-blink 1s infinite alternate;
      }
      .vibe-indicator-dot.dot-tool {
        background: #00d2aa;
        box-shadow: 0 0 8px #00d2aa;
        animation: vibe-dot-blink 0.8s infinite alternate;
      }
      .vibe-indicator-dot.dot-waiting {
        background: #ffaa00;
        box-shadow: 0 0 10px #ffaa00;
        animation: vibe-dot-blink 0.6s infinite alternate;
      }
      .vibe-indicator-dot.dot-idle {
        background: #50505a;
      }

      @keyframes vibe-dot-blink {
        from { opacity: 0.5; transform: scale(0.85); }
        to { opacity: 1; transform: scale(1.15); }
      }

      .vibe-compact-title {
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: #f0f0f5;
        letter-spacing: 0.2px;
      }
      .vibe-compact-right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .vibe-compact-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.14);
        color: #d0d0dc;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .vibe-subagent-badge {
        background: rgba(120, 200, 255, 0.18);
        border: 1px solid rgba(120, 200, 255, 0.35);
        color: #9ad8ff;
      }
      .vibe-compact-timer {
        font-size: 11px;
        color: #a0a0b0;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }

      /* 展开 HUD 面板布局 */
      .vibe-hud-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding-bottom: 8px;
        margin-bottom: 8px;
      }
      .vibe-hud-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .vibe-hud-badge-status {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 6px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .vibe-hud-badge-status.badge-thinking {
        background: rgba(78, 124, 255, 0.2);
        color: #7b9fff;
        border: 1px solid rgba(78, 124, 255, 0.35);
      }
      .vibe-hud-badge-status.badge-tool {
        background: rgba(0, 210, 170, 0.2);
        color: #38efc6;
        border: 1px solid rgba(0, 210, 170, 0.35);
      }
      .vibe-hud-badge-status.badge-waiting {
        background: rgba(255, 170, 0, 0.2);
        color: #ffc44d;
        border: 1px solid rgba(255, 170, 0, 0.35);
      }
      .vibe-hud-badge-status.badge-idle {
        background: rgba(255, 255, 255, 0.08);
        color: #a0a0b5;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      .vibe-hud-close-btn {
        background: none;
        border: none;
        color: #808090;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 13px;
        transition: all 0.2s;
      }
      .vibe-hud-close-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }

      .vibe-hud-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 6px;
        min-height: 0;
      }
      .vibe-hud-detail-line {
        font-size: 12px;
        color: #e2e2ec;
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .vibe-hud-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: rgba(0, 0, 0, 0.4);
        padding: 4px 8px;
        border-radius: 6px;
        color: #a5d6ff;
        font-size: 11px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 100%;
        box-sizing: border-box;
      }

      .vibe-hud-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #88889c;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        padding-top: 8px;
        margin-top: auto;
      }
      .vibe-hud-stats {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .vibe-hud-stat-item {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      /* 头部工具栏图标按钮 */
      .vibe-header-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #c0c0d0;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .vibe-header-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }
      .vibe-header-btn.is-active {
        background: rgba(78, 124, 255, 0.18);
        border-color: rgba(78, 124, 255, 0.4);
        color: #8cb0ff;
      }
    `;

    function ensureCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS_STYLES;
      document.head.appendChild(style);
    }

    // ---------------------------------------------------------------------------
    // 智能体状态解析引擎（按会话 id 增量扫描 session.events）
    //
    // 游标缓存的 key 必须是「稳定的会话标识」，不能是 events 数组本身。
    // 宿主每轮会给出新的数组实例，若以数组引用为 WeakMap key，缓存将 100% miss，
    // 每轮都退化成全量重扫（实测 16000 事件：命中 0.0001ms/轮 vs miss 1.8ms/轮）。
    // 因此这里用 sessionKey（会话 id）索引一个普通 Map，并显式做容量回收。
    // ---------------------------------------------------------------------------
    const cursorMap = new Map();
    const CURSOR_CACHE_LIMIT = 64;

    function createCursorState() {
      return {
        lastIdx: 0,
        lastLength: 0,
        turnKey: null,
        status: "idle",
        title: "DeepSeek 待命",
        detail: "等待指令输入",
        currentTool: null,
        toolCommand: "",
        toolCount: 0,
        pendingToolId: null,
        isWaitingApproval: false,
        turnStartTime: 0,
      };
    }

    function getCursor(sessionKey) {
      // 未提供会话 id 时退化为「一次性游标」：保证函数仍可独立调用（测试/降级路径）。
      const key = sessionKey || "__anonymous__";
      let cache = cursorMap.get(key);
      if (!cache) {
        cache = createCursorState();
        cursorMap.set(key, cache);
        // 容量回收：Map 是强引用，插入最旧的条目以免长会话无界增长。
        if (cursorMap.size > CURSOR_CACHE_LIMIT) {
          const oldest = cursorMap.keys().next();
          if (!oldest.done && oldest.value !== key) cursorMap.delete(oldest.value);
        }
      }
      return cache;
    }

    function formatDuration(seconds) {
      if (!seconds || seconds < 0) return "00:00";
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    /**
     * 增量解析会话事件流，产出灵动岛状态。
     * @param {any[]} events 会话事件数组（宿主每次可能给新实例）
     * @param {string} [sessionKey] 稳定会话标识，用于命中增量游标
     */
    function parseActivityFromEvents(events, sessionKey) {
      if (!Array.isArray(events) || events.length === 0) {
        return {
          status: "idle",
          title: "DeepSeek 待命",
          detail: "等待指令输入",
          currentTool: null,
          toolCommand: "",
          toolCount: 0,
          isWaitingApproval: false,
          turnStartTime: 0,
        };
      }

      const cache = getCursor(sessionKey);

      // 事件数组被截断/替换（如切换会话、宿主重放历史）时重置游标，避免状态错乱。
      if (events.length < cache.lastIdx || (cache.lastLength > 0 && events.length < cache.lastLength)) {
        const fresh = createCursorState();
        if (sessionKey) {
          cursorMap.set(sessionKey, fresh);
          return scanEvents(events, fresh);
        }
        return scanEvents(events, fresh);
      }

      return scanEvents(events, cache);
    }

    function scanEvents(events, cache) {

      // 仅扫描从 lastIdx 到当前的增量事件
      for (let i = cache.lastIdx; i < events.length; i++) {
        const ev = events[i];
        if (!ev) continue;

        const type = ev.type || ev.event || "";
        const data = ev.data || ev.payload || ev;

        // 判定回合开始
        if (type.includes("turn-start") || type === "user-message" || type === "turn/start") {
          cache.status = "thinking";
          cache.title = "正在分析与规划...";
          cache.detail = "解析任务上下文中";
          cache.currentTool = null;
          cache.toolCommand = "";
          // 工具计数按回合统计：新回合从 0 开始（HUD 显示的是本回合用量）。
          cache.toolCount = 0;
          cache.pendingToolId = null;
          cache.isWaitingApproval = false;
          cache.turnStartTime = Date.now();
        }

        // 思考中
        if (type.includes("thinking") || type === "model/thinking" || type === "model/delta") {
          cache.status = "thinking";
          cache.title = "深度思考中...";
          if (typeof data.text === "string" && data.text.trim()) {
            cache.detail = data.text.slice(-60).trim();
          }
        }

        // 工具调用触发 (tool/call)
        if (type === "tool/call" || type.includes("tool-call") || type === "call") {
          const toolName = data.name || data.tool || "工具";
          cache.status = "tool";
          cache.currentTool = toolName;
          cache.toolCount += 1;
          cache.pendingToolId = data.callId || data.id || `tool-${i}`;

          // 提取具体参数
          const args = data.args || data.arguments || {};
          let cmd = "";
          if (typeof args === "string") {
            cmd = args;
          } else if (args.command) {
            cmd = args.command;
          } else if (args.file_path || args.path) {
            cmd = `${args.file_path || args.path}`;
          } else if (args.pattern) {
            cmd = `搜索 "${args.pattern}"`;
          } else if (args.question) {
            cmd = `提问: ${args.question}`;
            cache.isWaitingApproval = true;
            cache.status = "waiting";
          } else {
            cmd = Object.keys(args).map(k => `${k}: ${JSON.stringify(args[k])}`).join(", ");
          }

          cache.toolCommand = cmd || toolName;
          cache.title = `执行 ${toolName}`;
          cache.detail = cache.toolCommand.slice(0, 100);
        }

        // 工具调用结束 (tool/result)
        if (type === "tool/result" || type.includes("tool-result") || type === "result") {
          cache.pendingToolId = null;
          cache.isWaitingApproval = false;
          // 工具结束进入思考或待结算
          if (cache.status === "tool" || cache.status === "waiting") {
            cache.status = "thinking";
            cache.title = "分析工具执行结果...";
          }
        }

        // 回合结束
        if (type.includes("turn-end") || type === "model/done" || type === "turn/end") {
          cache.status = "idle";
          cache.title = "任务已完成";
          cache.detail = `调用 ${cache.toolCount} 次工具`;
          cache.currentTool = null;
          cache.pendingToolId = null;
          cache.isWaitingApproval = false;
        }

        // 报错拦截
        if (type.includes("error") || (data && data.isError)) {
          cache.status = "idle";
          cache.title = "执行遇到注意项";
          cache.detail = String(data.error || data.message || "工具返回警告");
        }
      }

      cache.lastIdx = events.length;
      cache.lastLength = events.length;
      return { ...cache };
    }

    // ---------------------------------------------------------------------------
    // 子代理聚合（showSubagentCount 的真实实现）
    //
    // 数据面依据（逆向 dsh 0.1.x 客户端运行时，与 dsh-subagent-lens 同源结论）：
    // 内核把子代理实现为**独立会话**（origin === "subagent"、parentId 指向父会话），
    // 父会话的 tool/result 只带子代理最终输出，中间过程在子会话自己的事件流里。
    // 因此子代理数量只能从 sessions 快照的谱系目录读取：
    //   ctx.sessions.list.getSnapshot().subagentsByParent[parentId].entries[]
    // 条目字段：{ kind: "child", id, label, mode, activity: "running" | ... }
    // 本函数只读快照，不新增任何宿主数据通道；任何异常静默降级为 0。
    // ---------------------------------------------------------------------------
    function countActiveSubagents(sessionsFace, parentSessionId) {
      try {
        if (!sessionsFace || !sessionsFace.list || !parentSessionId) return 0;
        const snap = sessionsFace.list.getSnapshot();
        const byParent = snap && snap.subagentsByParent;
        if (!byParent) return 0;
        const catalog = byParent[parentSessionId];
        if (!catalog || !Array.isArray(catalog.entries)) return 0;
        let n = 0;
        for (const e of catalog.entries) {
          if (e && e.kind === "child" && e.activity === "running") n += 1;
        }
        return n;
      } catch {
        return 0;
      }
    }

    // ---------------------------------------------------------------------------
    // 灵动岛核心 UI 组件
    // ---------------------------------------------------------------------------
    function VibeIslandApp(props) {
      const { ctx, config } = props;

      // 读取当前会话
      const activeSessionId = useMemo(() => {
        try {
          if (ctx.sessions && ctx.sessions.list) {
            const snap = ctx.sessions.list.getSnapshot();
            return (snap && (snap.activeId || snap.currentId || (snap.items && snap.items[0] && snap.items[0].id))) || null;
          }
        } catch {}
        return null;
      }, [ctx]);

      // 实时事件获取
      const [events, setEvents] = useState([]);
      useEffect(() => {
        if (!ctx.sessions || !activeSessionId) return;
        const binding = ctx.sessions.binding(activeSessionId);
        if (!binding || !binding.session) return;

        const updateEvents = () => {
          try {
            const evs = binding.session.events;
            if (Array.isArray(evs)) {
              // 注意：这里刻意复制数组（宿主每次可能是新实例），
              // 增量游标按 activeSessionId 索引，不依赖数组引用。
              setEvents([...evs]);
            }
          } catch {}
        };

        updateEvents();
        // 订阅变动
        const timer = setInterval(updateEvents, 250);
        return () => clearInterval(timer);
      }, [ctx, activeSessionId]);

      // 解析活动状态（传入会话 id，使增量游标稳定命中）
      const activity = useMemo(
        () => parseActivityFromEvents(events, activeSessionId),
        [events, activeSessionId]
      );

      // 计时器
      const [elapsed, setElapsed] = useState(0);
      useEffect(() => {
        if (activity.status === "thinking" || activity.status === "tool" || activity.status === "waiting") {
          const start = activity.turnStartTime || Date.now();
          const timer = setInterval(() => {
            setElapsed(Math.floor((Date.now() - start) / 1000));
          }, 1000);
          return () => clearInterval(timer);
        } else {
          setElapsed(0);
        }
      }, [activity.status, activity.turnStartTime]);

      // 交互展开/折叠状态
      const [isExpanded, setIsExpanded] = useState(false);

      // 平台自适应
      const platformClass = useMemo(() => {
        if (config.platformMode === "macos") return "platform-macos";
        if (config.platformMode === "windows") return "platform-windows";
        // 自动判定
        const isMac = typeof navigator !== "undefined" && /(Macintosh|MacIntel|MacPPC|Mac68K)/i.test(navigator.userAgent);
        return isMac ? "platform-macos" : "platform-windows";
      }, [config.platformMode]);

      // 并行子代理数量（showSubagentCount 控制显隐）
      const [subagentCount, setSubagentCount] = useState(0);
      useEffect(() => {
        if (!config.showSubagentCount || !ctx.sessions || !activeSessionId) {
          setSubagentCount(0);
          return;
        }
        const read = () => setSubagentCount(countActiveSubagents(ctx.sessions, activeSessionId));
        read();
        const timer = setInterval(read, 250);
        return () => clearInterval(timer);
      }, [ctx, activeSessionId, config.showSubagentCount]);

      // 如果未开启则不渲染
      if (!config.enabled) return null;

      // 状态光晕样式
      const glowClass = activity.status === "thinking"
        ? "glow-thinking"
        : activity.status === "tool"
        ? "glow-tool"
        : activity.status === "waiting"
        ? "glow-waiting"
        : "";

      const dotClass = activity.status === "thinking"
        ? "dot-thinking"
        : activity.status === "tool"
        ? "dot-tool"
        : activity.status === "waiting"
        ? "dot-waiting"
        : "dot-idle";

      const handleMouseEnter = () => {
        if (config.expandOnHover) {
          setIsExpanded(true);
        }
      };

      const handleMouseLeave = () => {
        if (config.expandOnHover) {
          setIsExpanded(false);
        }
      };

      const toggleExpand = () => {
        setIsExpanded(prev => !prev);
      };

      return h("div", {
        className: `vibe-island-wrapper placement-${config.placement || 'notch'}`,
        style: {
          transform: config.scale && config.scale !== 1.0 ? `scale(${config.scale})` : undefined,
        },
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
      }, [
        h("div", {
          key: "pill",
          className: [
            "vibe-island-pill",
            platformClass,
            isExpanded ? "state-expanded" : "state-collapsed",
            activity.status !== "idle" ? "has-active" : "",
            config.glowEffect && glowClass ? "glow-active" : "",
          ].filter(Boolean).join(" "),
          onClick: toggleExpand,
        }, [
          // 呼吸光晕层
          config.glowEffect && glowClass && h("div", {
            key: "glow",
            className: `vibe-island-glow ${glowClass}`,
          }),

          // 折叠形态
          !isExpanded && h("div", {
            key: "compact-content",
            className: "vibe-compact-row",
          }, [
            h("div", { className: "vibe-compact-left", key: "left" }, [
              h("div", { className: `vibe-indicator-dot ${dotClass}`, key: "dot" }),
              h("div", { className: "vibe-compact-title", key: "title" }, activity.title),
            ]),
            h("div", { className: "vibe-compact-right", key: "right" }, [
              subagentCount > 0 && h("div", {
                className: "vibe-compact-badge vibe-subagent-badge",
                key: "subagent-badge",
                title: `${subagentCount} 个子代理并行执行中`,
              }, `👥 ${subagentCount}`),
              activity.status !== "idle" && elapsed > 0 && h("div", {
                className: "vibe-compact-timer",
                key: "timer",
              }, formatDuration(elapsed)),
              activity.currentTool && h("div", {
                className: "vibe-compact-badge",
                key: "tool-badge",
              }, activity.currentTool),
            ]),
          ]),

          // 展开 HUD 形态
          isExpanded && h("div", {
            key: "hud-content",
            style: { display: "flex", flexDirection: "column", height: "100%", width: "100%" },
            onClick: (e) => e.stopPropagation(),
          }, [
            // 头部
            h("div", { className: "vibe-hud-header", key: "hud-header" }, [
              h("div", { className: "vibe-hud-title-group", key: "title-group" }, [
                h("div", { className: `vibe-indicator-dot ${dotClass}`, key: "dot" }),
                h("div", {
                  className: `vibe-hud-badge-status badge-${activity.status}`,
                  key: "status-badge",
                }, activity.status === "thinking" ? "Thinking" : activity.status === "tool" ? "Executing Tool" : activity.status === "waiting" ? "Action Required" : "Ready"),
                h("span", {
                  style: { fontSize: "12px", color: "#a0a0b0", fontWeight: 500 },
                  key: "sub-title",
                }, activity.title),
              ]),
              h("button", {
                className: "vibe-hud-close-btn",
                key: "close-btn",
                title: "收起",
                onClick: () => setIsExpanded(false),
              }, "✕"),
            ]),

            // 中间详情
            h("div", { className: "vibe-hud-body", key: "hud-body" }, [
              activity.toolCommand ? h("div", {
                className: "vibe-hud-code",
                key: "cmd-box",
                title: activity.toolCommand,
              }, activity.toolCommand) : h("div", {
                className: "vibe-hud-detail-line",
                key: "detail-text",
              }, activity.detail || "当前无活动任务"),
            ]),

            // 底部统计信息
            h("div", { className: "vibe-hud-footer", key: "hud-footer" }, [
              h("div", { className: "vibe-hud-stats", key: "stats" }, [
                h("div", { className: "vibe-hud-stat-item", key: "stat-time" }, [
                  h("span", { style: { color: "#666" } }, "耗时:"),
                  h("span", { style: { fontFamily: "monospace", color: "#ddd" } }, formatDuration(elapsed)),
                ]),
                h("div", { className: "vibe-hud-stat-item", key: "stat-tools" }, [
                  h("span", { style: { color: "#666" } }, "工具调用:"),
                  h("span", { style: { fontFamily: "monospace", color: "#ddd" } }, `${activity.toolCount} 次`),
                ]),
                subagentCount > 0 && h("div", { className: "vibe-hud-stat-item", key: "stat-subagents" }, [
                  h("span", { style: { color: "#666" } }, "子代理:"),
                  h("span", { style: { fontFamily: "monospace", color: "#ddd" } }, `${subagentCount} 并行`),
                ]),
              ]),
              h("div", {
                style: { fontSize: "10px", color: "#606075" },
                key: "brand",
              }, "DeepSeek VibeIsland"),
            ]),
          ]),
        ]),
      ]);
    }

    // ---------------------------------------------------------------------------
    // 设置页面配置卡片组件 (Settings Section)
    // ---------------------------------------------------------------------------
    function VibeIslandSettingsCard(props) {
      const { scope } = props.inject ? props.inject() : {};

      // 统一从 scope 读快照（scope 已由 normalizeScope 统一成 getSnapshot/subscribe/update）
      const config = readScopeConfig(scope);

      const updateField = (key, val) => {
        if (scope && typeof scope.update === "function") {
          scope.update({ [key]: val });
        }
      };

      return h("div", {
        style: {
          padding: "16px",
          background: "rgba(255, 255, 255, 0.04)",
          borderRadius: "8px",
          marginBottom: "16px",
          border: "1px solid rgba(255, 255, 255, 0.08)",
        },
      }, [
        h("div", {
          style: { fontSize: "15px", fontWeight: "600", marginBottom: "8px", color: "#fff" },
          key: "title",
        }, "🏝️ 智能体刘海灵动岛 (VibeIsland)"),
        h("div", {
          style: { fontSize: "12px", color: "#999", marginBottom: "16px" },
          key: "desc",
        }, "实时在屏幕/窗口顶端显示 DeepSeek 智能体思考、工具调用与子代理并行进度，完美适配 macOS 硬件刘海与 Windows 11 Fluent 视觉。"),

        // 开关
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }, key: "opt-enabled" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "启用灵动岛状态栏"),
          h("input", {
            type: "checkbox",
            checked: config.enabled !== false,
            onChange: (e) => updateField("enabled", e.target.checked),
          }),
        ]),

        // 位置形态
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }, key: "opt-placement" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "显示位置与形态"),
          h("select", {
            value: config.placement || "notch",
            onChange: (e) => updateField("placement", e.target.value),
            style: { background: "#222", color: "#eee", border: "1px solid #444", borderRadius: "4px", padding: "4px 8px" },
          }, [
            h("option", { value: "notch" }, "Mac 物理刘海 / 窗口正顶吸附"),
            h("option", { value: "floating" }, "居中悬浮药丸 (向下偏移 12px)"),
            h("option", { value: "top-right" }, "右上角微型浮标"),
          ]),
        ]),

        // 平台拟态
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }, key: "opt-platform" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "平台视觉风格"),
          h("select", {
            value: config.platformMode || "auto",
            onChange: (e) => updateField("platformMode", e.target.value),
            style: { background: "#222", color: "#eee", border: "1px solid #444", borderRadius: "4px", padding: "4px 8px" },
          }, [
            h("option", { value: "auto" }, "自动识别 (Mac 刘海 / Win 亚克力)"),
            h("option", { value: "macos" }, "强制 macOS 黑晶倒角"),
            h("option", { value: "windows" }, "强制 Windows 11 Fluent 毛玻璃"),
          ]),
        ]),

        // 光晕开关
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, key: "opt-glow" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "动态呼吸光晕 (Thinking / Tool)"),
          h("input", {
            type: "checkbox",
            checked: config.glowEffect !== false,
            onChange: (e) => updateField("glowEffect", e.target.checked),
          }),
        ]),
      ]);
    }

    // ---------------------------------------------------------------------------
    // 插件生命周期入口 (Cordis apply)
    // ---------------------------------------------------------------------------
    function apply(ctx) {
      ensureCss();

      // 启动诊断：宿主把 console 输出收集进 ~/Library/Logs/DeepSeek Harness/，
      // 这里输出一条可检索的标记，便于确认插件是否真的被激活、在哪一步停下。
      try {
        console.log("[dsh-vibe-island] apply() 已调用 | services=" +
          Object.keys(ctx || {}).filter((k) => /^(slots|sessions|configForms|settingsScope|settings|locale|remote|commandUi)$/.test(k)).join(",") +
          " | hasDocument=" + (typeof document !== "undefined") +
          " | hasReactDomClient=" + !!(reactDomClient && typeof reactDomClient.createRoot === "function"));
      } catch (e) {
        console.log("[dsh-vibe-island] 诊断输出失败: " + ((e && e.message) || e));
      }

      // 热配置绑定：宿主客户端配置服务是 `configForms`（`configForms.get(NS, bootstrap?)`），
      // 不存在 `settingsScope` 服务 —— 注入不存在的服务会让插件永远停在 pending。
      const scope = bindConfigScope(ctx);
      console.log("[dsh-vibe-island] 配置源: " + (scope ? ("已绑定(" + scope.origin + ")") : "未绑定，使用默认值"));

      // 默认配置回退
      const initialConfig = {
        enabled: true,
        placement: "notch",
        platformMode: "auto",
        glowEffect: true,
        expandOnHover: true,
        showSubagentCount: true,
        scale: 1.0,
      };

      // 挂载全局 DOM 灵动岛容器
      if (typeof document !== "undefined") {
        let container = document.getElementById(CONTAINER_ID);
        if (!container) {
          container = document.createElement("div");
          container.id = CONTAINER_ID;
          document.body.appendChild(container);
        }

        // 配置订阅（无配置服务时退化为静态默认值）
        const useConfig = scope
          ? (bindSnapshotSelector ? bindSnapshotSelector(scope) : null)
          : null;
        if (!scope) {
          console.warn("[dsh-vibe-island] 未取得配置服务，使用默认配置（设置项不持久化）");
        }

        // 根组件包裹
        function RootWrapper() {
          let config = initialConfig;
          if (useConfig && scope) {
            try {
              config = useConfig(scope) || initialConfig;
            } catch (e) {
              config = initialConfig;
            }
          } else if (scope && typeof scope.getSnapshot === "function") {
            try {
              config = scope.getSnapshot() || initialConfig;
            } catch (e) {
              config = initialConfig;
            }
          }
          const mergedConfig = { ...initialConfig, ...config };
          return h(VibeIslandApp, { ctx, config: mergedConfig });
        }

        try {
          if (reactDomClient && typeof reactDomClient.createRoot === "function") {
            reactDomClient.createRoot(container).render(h(RootWrapper));
            console.log("[dsh-vibe-island] React 挂载完成 | container=" + CONTAINER_ID +
              " | placement=" + initialConfig.placement + " platform=" + initialConfig.platformMode);
          } else if (reactDomClient && typeof reactDomClient.render === "function") {
            reactDomClient.render(h(RootWrapper), container);
            console.log("[dsh-vibe-island] React 挂载完成(legacy render) | container=" + CONTAINER_ID);
          } else {
            console.log("[dsh-vibe-island] 未找到可用的 react-dom 客户端，DOM 未挂载");
          }
        } catch (err) {
          console.warn("[dsh-vibe-island] 挂载全局灵动岛容器告警:", err);
        }
      } else {
        console.log("[dsh-vibe-island] document 不可用（SSR/非浏览器上下文），跳过 DOM 挂载");
      }

      // 注册进入设置面板
      if (ctx.slots && typeof ctx.slots.inject === "function") {
        try {
          ctx.slots.inject("settings.section", () => ctx.slots.register({
            name: "settings.section",
            id: "dsh-vibe-island-settings",
            order: 85,
            label: () => "🏝️ 灵动岛",
            inject: () => ({ scope }),
          }, VibeIslandSettingsCard), "dsh-vibe-island: settings entry");
        } catch (err) {
          console.warn("[dsh-vibe-island] 注册设置项跳过:", err);
        }

        // 注册进会话头部快捷图标
        try {
          ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
            name: "conversation.session.header.utilities",
            id: "dsh-vibe-island-header-btn",
            order: 48,
          }, function HeaderBtn() {
            return h("button", {
              className: "vibe-header-btn",
              title: "智能体灵动岛状态栏",
              onClick: () => {
                if (scope && scope.update) {
                  const curr = scope.getSnapshot ? scope.getSnapshot() : {};
                  scope.update({ enabled: curr.enabled === false ? true : false });
                }
              },
            }, [
              h("span", { key: "icon" }, "🏝️"),
              h("span", { key: "txt" }, "灵动岛"),
            ]);
          }), "dsh-vibe-island: session header utility");
        } catch (err) {
          console.warn("[dsh-vibe-island] 注册头部快捷入口跳过:", err);
        }
      }
    }

    /** 从统一化后的 scope 安全读取配置快照。 */
    function readScopeConfig(scope) {
      if (!scope) return {};
      try {
        if (typeof scope.getSnapshot === "function") return scope.getSnapshot() || {};
        if ("value" in scope) {
          return (typeof scope.value === "function" ? scope.value() : scope.value) || {};
        }
      } catch (e) {
        console.warn("[dsh-vibe-island] 读取配置快照失败:", (e && e.message) || e);
      }
      return {};
    }

    /**
     * 绑定配置 scope —— 多级兼容回退。
     *
     * 宿主客户端（desktop 0.2.0-rc.2）真实提供的配置服务是 `configForms`：
     *   ctx.configForms.get(namespace, bootstrap?) → { value, set, watch, ... }
     * 历史上部分插件写的是 `ctx.settingsScope.bind({ namespace })`，但该服务在宿主
     * bundle 中并不存在（0 次出现），一旦注入它，插件会永远停在
     * "pending (waiting for service: settingsScope)" 而永不激活。
     * 因此这里按 configForms → settingsScope → 裸 settings 的顺序回退，
     * 并且**只注入实际存在的服务名**（见 exports.inject）。
     */
    function bindConfigScope(ctx) {
      // 首选：configForms
      try {
        if (ctx.configForms && typeof ctx.configForms.get === "function") {
          const s = ctx.configForms.get(NS);
          if (s) return normalizeScope(s, "configForms");
        }
      } catch (e) {
        console.warn("[dsh-vibe-island] configForms 绑定失败，回退:", (e && e.message) || e);
      }
      // 兼容：老式 settingsScope.bind
      try {
        if (ctx.settingsScope && typeof ctx.settingsScope.bind === "function") {
          const s = ctx.settingsScope.bind({ namespace: NS });
          if (s) return normalizeScope(s, "settingsScope");
        }
      } catch (e) {
        console.warn("[dsh-vibe-island] settingsScope 绑定失败，回退:", (e && e.message) || e);
      }
      // 兜底：无配置服务时用内存态，插件仍可工作（只是不持久化）
      return null;
    }

    /** 把不同形态的配置源统一成 { getSnapshot, subscribe, update }。 */
    function normalizeScope(raw, origin) {
      // 已是快照存储形态
      if (typeof raw.getSnapshot === "function" && typeof raw.subscribe === "function") {
        if (typeof raw.update !== "function" && typeof raw.set === "function") {
          return {
            getSnapshot: () => (typeof raw.value === "function" ? raw.value() : raw.value) || {},
            subscribe: (fn) => (typeof raw.watch === "function" ? raw.watch(fn) : raw.subscribe(fn)),
            update: (patch) => raw.set(patch),
            origin,
          };
        }
        return raw;
      }
      // configForms.get(ns) → { value, set, watch }
      if ("value" in raw || typeof raw.set === "function") {
        return {
          getSnapshot: () => (typeof raw.value === "function" ? raw.value() : raw.value) || {},
          subscribe: (fn) => (typeof raw.watch === "function" ? raw.watch(fn) : () => {}),
          update: (patch) => raw.set(patch),
          origin,
        };
      }
      return raw;
    }

    // 导出插件
    exports.apply = apply;
    // 只注入宿主真实存在的服务：configForms（配置）、slots（插槽）、sessions（会话）
    exports.inject = ["slots", "sessions", "configForms"];
    exports.parseActivityFromEvents = parseActivityFromEvents;
    exports.formatDuration = formatDuration;
    exports.countActiveSubagents = countActiveSubagents;
    exports.bindConfigScope = bindConfigScope;

    return module.exports;
  }
});
