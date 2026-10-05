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

    // 注：原先这里还 require 了 react-dom/client（为了把岛挂到 DOM 上）。
    // 岛已移除，所以不再需要 react-dom —— 设置面板由宿主自己渲染，
    // 我们只提供组件函数，不需要自己的渲染器。

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
    // 常量
    // ---------------------------------------------------------------------------
    // 注：原先这里还有 CONTAINER_ID / STYLE_ID / CSS_STYLES / ensureCss ——
    // 那是窗口内 DOM 岛用的。岛已移除（理由见 apply() 里的说明），它们一并删掉了。
    const NS = "dsh-vibe-island";


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

    // ---------------------------------------------------------------------------
    // 设置页面配置卡片组件 (Settings Section)
    // ---------------------------------------------------------------------------
    function VibeIslandSettingsCard(props) {
      const { scope } = props.inject ? props.inject() : {};

      // 统一从 scope 读快照（scope 已由 normalizeScope 统一成 getSnapshot/subscribe/update）。
      // readScopeConfig 内部已把本地配置作为基线合并进来，所以
      // 「宿主配置服务缺席」时也能读到用户上次的选择。
      const config = readScopeConfig(scope);
      const [saveNote, setSaveNote] = useState(null);

      // 改一个配置项。
      //
      // 🔴 这里曾经是「点了没反应」的根源：原来只有
      //     if (scope && scope.update) scope.update(…)
      // 一条路，而 scope 在 configForms 被 profile 关掉时是 null，
      // 于是点击**静默失败** —— 受控 checkbox 状态不变，
      // 勾号不弹、岛不消失，用户完全无从判断。
      //
      // 现在三路并行，任何一路通都能生效：
      //   1) 宿主配置服务（权威，能用就用）
      //   2) 桥上的兜底副本（服务端落盘，跨重启有效）
      //   3) localStorage（至少本次窗口有效）
      // 并且**无论成败都在界面上给出可见反馈** —— 不再装哑巴。
      const updateField = (key, val) => {
        const patch = { [key]: val };

        // 先落本地：这一步同步、必定成功，界面因此立刻响应
        const merged = { ...config, ...patch };
        writeLocalConfig(merged);

        // 1) 宿主配置服务
        if (scope && typeof scope.update === "function") {
          try {
            scope.update(patch);
          } catch (e) {
            console.warn("[dsh-vibe-island] 配置服务写入失败，改用本地存储:", (e && e.message) || e);
          }
        }

        // 2) 后台持久化到服务端，完成后给可见反馈
        saveConfig(patch, merged).then((res) => {
          setSaveNote(res.ok
            ? { seq: ++saveNoteSeq, text: res.via === "bridge" ? "已保存" : "已保存（本次会话有效）" }
            : { seq: ++saveNoteSeq, text: "保存失败：" + (res.error || "未知原因") });
          console.log("[dsh-vibe-island] 设置写入", res.ok ? "成功(" + res.via + ")" : "失败", JSON.stringify(patch));
        }).catch((e) => {
          setSaveNote({ seq: ++saveNoteSeq, text: "保存异常：" + ((e && e.message) || e) });
        });
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

        // 保存反馈：让每次改动都有可见回执。
        // 没有它时点击是**完全静默**的 —— 用户只能靠"岛有没有消失"去猜，
        // 失败与成功长得一模一样。
        saveNote
          ? h("div", {
              style: {
                fontSize: "12px",
                marginBottom: "12px",
                color: /^保存失败|^保存异常/.test(saveNote.text) ? "#ff8a80" : "#7ee787",
              },
              key: "save-note-" + saveNote.seq,
            }, saveNote.text)
          : null,

        // 主开关：控制**物理刘海**上那个岛（macOS 屏幕顶端那个）。
        //
        // 为什么不是控制窗口内的 DOM 岛：那个岛已被弃用（两处状态栏视觉冗余，
        // 而且它受限于 DSH 窗口、不能置顶、点了会切走焦点）。
        // 用户明确要求「把应用内的岛全删掉，只留物理刘海」。
        // `notchEnabled` 落在 client-config.json 里，由 DSHNotch.app 读取
        // （见 swift/Sources/DSHNotch/Core/IslandConfig.swift）。
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }, key: "opt-notch" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "启用刘海灵动岛"),
          h("input", {
            type: "checkbox",
            checked: config.notchEnabled !== false,
            onChange: (e) => updateField("notchEnabled", e.target.checked),
          }),
        ]),
        h("div", {
          style: { fontSize: "11px", color: "#777", marginBottom: "12px" },
          key: "opt-notch-hint",
        }, "控制 macOS 屏幕顶端那个刘海岛。需要先安装 DSHNotch.app（装好插件后会自动安装）。"),

        // 点岛上的对话是否直接跳会话
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }, key: "opt-jump" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "点对话直接跳转到该会话"),
          h("input", {
            type: "checkbox",
            checked: config.jumpEnabled !== false,
            onChange: (e) => updateField("jumpEnabled", e.target.checked),
          }),
        ]),

        // 空闲时自动收起
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }, key: "opt-idle" }, [
          h("span", { style: { fontSize: "13px", color: "#eee" } }, "空闲时自动收起"),
          h("input", {
            type: "checkbox",
            checked: config.hideWhenIdle === true,
            onChange: (e) => updateField("hideWhenIdle", e.target.checked),
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
    // 跳转桥客户端
    // ---------------------------------------------------------------------------
    //
    // 职责：把 macOS 灵动岛 app 投递过来的「打开这个会话」请求，落地成
    // 渲染进程里真实的 `uiWorkspace.openSession(sessionId)`。
    //
    // 为什么要桥：DSH 对外只有 `dsh://open` 一条深链（只能置前窗口），
    // app 进不去 DSH 内部；但**插件的渲染进程可以** —— 宿主 asar 里
    // `ctx.uiWorkspace.openSession(target)` 有 9 处真实调用，官方注释写着
    // 「target 可以是已知的 Session id」。于是让服务端插件在 127.0.0.1 上
    // 起一个小 HTTP 服务（见 lib/index.js），两端各接一半，通道就成了。
    //
    // 🔴 最重要的一条纪律：`uiWorkspace` **不能**写进 `exports.inject`。
    // Cordis 会为缺失的服务无限等待，插件永久停在
    // "pending (waiting for service: uiWorkspace)"，整个灵动岛直接消失 ——
    // 本项目早前就因为把不存在的 `settingsScope` 写进 inject 踩过这个坑
    // （见 ~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log）。
    // 所以一律用 `ctx.get("uiWorkspace")` 在运行时探测，拿不到就安静跳过。

    /** 桥候选端口：与 lib/index.js 的 BRIDGE_PORT / BRIDGE_PORT_TRIES 对齐。 */
    const BRIDGE_PORT_BASE = 47311;
    const BRIDGE_PORT_TRIES = 12;
    /** 轮询间隔。500ms 是「点了岛几乎立刻切过去」与「不空转」之间的折中。 */
    const BRIDGE_POLL_MS = 500;
    /** 连续失败多少次后重新探测端口（服务端换端口、或 DSH 重启过）。 */
    const BRIDGE_REPROBE_AFTER = 6;

    function bridgeLog(msg) {
      try { console.log("[dsh-vibe-island] " + msg); } catch (e) { /* ignore */ }
    }

    /**
     * 运行时取 uiWorkspace。**永远不要把它写进 exports.inject**（见上）。
     * @returns {null | { openSession: (target: any) => any }}
     */
    function resolveWorkspace(ctx) {
      // ctx.get 是 Cordis 官方的按需取法：宿主自己的插件也这么用
      // （`const workspaceNavigation = ctx.get("uiWorkspace")`）。
      // 缺失时行为各版本不一（返回 undefined 或抛），两种都吃掉。
      try {
        if (ctx && typeof ctx.get === "function") {
          const ws = ctx.get("uiWorkspace");
          if (ws && typeof ws.openSession === "function") return ws;
        }
      } catch (e) { /* 未注册 */ }
      // 兜底：某些宿主把它直接挂在 ctx 上
      try {
        if (ctx && ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === "function") {
          return ctx.uiWorkspace;
        }
      } catch (e) { /* ignore */ }
      return null;
    }

    // ======================================================================
    // 本地配置存储 —— 设置面板能不能真的写下去，全看这一段
    // ======================================================================
    //
    // 🔴 为什么需要它（这是「开关点不动」的真实原因）
    //
    // 设置面板的写入原本只有一条路：`scope.update(...)`，而 `scope` 来自
    // `bindConfigScope(ctx)`。那条路在很多 profile 上**根本不存在** ——
    // `configForms` 由 `@deepseek-ai/dsh-client-ui-settings` 提供，
    // 而用户可以在自己 profile 的 `cordis.patch.yml` 里写：
    //
    //     - id: ui-settings
    //       name: "@deepseek-ai/dsh-client-ui-settings"
    //       config:
    //         enabled: false
    //
    // （这很常见，因为那个 bundle 带首次引导流程。本机 desktop profile
    //   就是这样 —— 所以这里的开关点了等于没点。）
    //
    // 拿不到 scope 时 `bindConfigScope` 返回 null，而 `updateField` 写的是
    //     if (scope && typeof scope.update === "function") scope.update(…)
    // 于是**静默什么都不做**。checkbox 是受控组件（`checked: config.enabled`），
    // 状态没变 → 勾号不弹、岛也不消失，用户完全无从判断发生了什么。
    //
    // 所以这里自带一条**不依赖任何宿主服务**的通道：
    //   1) 桥在 → POST /config 交给服务端半边落盘（跨重启有效，DSH 升级也不丢）
    //   2) 桥不在 → localStorage（本次窗口有效，至少不再"点了没反应"）
    // 两条都失败时也要**在界面上说清楚**，不能继续装哑巴。

    /** 设置保存反馈的自增序号（模块级；这个文件只解构了三个 hook，不额外引入）。 */
    let saveNoteSeq = 0;

    const LOCAL_CONFIG_KEY = "dsh-vibe-island.config";

    /**
     * 当前跳转桥实例的引用。
     *
     * 必须存在：配置存储要靠它知道桥的基址（渲染进程读不到 bridge.json，
     * 而桥的 `start()` 会把 base 记在这里）。写 null 表示桥还没起来。
     */
    let jumpBridgeRef = null;

    /** localStorage 可能被隐私模式或宿主策略禁用，任何一步都要容错。 */
    function readLocalConfig() {
      try {
        if (typeof localStorage === "undefined") return {};
        const v = JSON.parse(localStorage.getItem(LOCAL_CONFIG_KEY) || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch (e) { return {}; }
    }

    function writeLocalConfig(obj) {
      try {
        if (typeof localStorage === "undefined") return false;
        localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(obj));
        return true;
      } catch (e) { return false; }
    }

    /**
     * 找桥的基址（复用跳转桥的探测结果，避免重复扫端口）。
     * @returns {string|null} 如 "http://127.0.0.1:47311"
     */
    function bridgeBase() {
      try {
        const st = jumpBridgeRef && jumpBridgeRef.state ? jumpBridgeRef.state() : null;
        return st && st.base ? st.base : null;
      } catch (e) { return null; }
    }

    /**
     * 读取配置。优先级：宿主配置服务 > 桥上的兜底副本 > localStorage。
     * 三者都没有就返回空对象，由调用方用默认值兜。
     */
    async function loadConfig(scope) {
      // 1) 宿主配置服务（权威）
      if (scope && typeof scope.getSnapshot === "function") {
        try {
          const snap = scope.getSnapshot();
          if (snap && typeof snap === "object" && Object.keys(snap).length > 0) return snap;
        } catch (e) { /* 落到下一级 */ }
      }
      // 2) 服务端半边的兜底副本
      const base = bridgeBase();
      if (base && typeof fetch === "function") {
        try {
          const res = await fetch(base + "/config", { cache: "no-store", signal: AbortSignal.timeout(1500) });
          if (res.ok) {
            const body = await res.json();
            if (body && body.config && typeof body.config === "object") {
              const merged = { ...readLocalConfig(), ...body.config };
              writeLocalConfig(merged);
              return merged;
            }
          }
        } catch (e) { /* 落到下一级 */ }
      }
      // 3) 浏览器本地
      const local = readLocalConfig();
      return Object.keys(local).length > 0 ? local : {};
    }

    /**
     * 写配置。**先本地生效、再持久化**：
     * 界面必须立刻响应（哪怕持久化最终失败），否则又变成"点不动"。
     *
     * @param {object} patch  要改的键值
     * @param {object} current 当前完整配置（用于合并后回传）
     * @returns {Promise<{ ok: boolean, via: string, error?: string }>}
     */
    async function saveConfig(patch, current) {
      const merged = { ...(current || {}), ...patch };
      writeLocalConfig(merged);          // 同步、必定先做

      const base = bridgeBase();
      if (base && typeof fetch === "function") {
        try {
          const res = await fetch(base + "/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
            signal: AbortSignal.timeout(2500),
          });
          const body = await res.json().catch(() => ({}));
          if (res.ok && body && body.ok) return { ok: true, via: "bridge" };
          return { ok: false, via: "bridge", error: (body && body.error) || ("HTTP " + res.status) };
        } catch (e) {
          return { ok: false, via: "bridge", error: (e && e.message) || String(e) };
        }
      }
      // 没有桥：localStorage 已经写成功了，只是跨重启不保留
      return { ok: true, via: "localStorage", error: "本次会话有效；重启 DSH 后会恢复默认（跳转桥未运行）" };
    }

    /** 找出桥在哪：渲染进程读不到文件，所以按候选端口逐个探 /health。 */
    async function probeBridge(basePort = BRIDGE_PORT_BASE, tries = BRIDGE_PORT_TRIES) {
      for (let i = 0; i < tries; i++) {
        const port = basePort + i;
        try {
          const res = await fetch("http://127.0.0.1:" + port + "/health", {
            cache: "no-store",
            signal: AbortSignal.timeout(1200),
          });
          if (!res.ok) continue;
          const body = await res.json();
          // 必须核对插件名：端口附近可能有别的服务在监听，
          // 认错人会导致把别人的 /next 当成会话队列
          if (body && body.ok === true && String(body.plugin || "").indexOf("dsh-vibe-island") >= 0) {
            return { port, base: "http://127.0.0.1:" + port, version: body.version };
          }
        } catch (e) { /* 该端口没人或不通，继续试下一个 */ }
      }
      return null;
    }

    /**
     * 启动桥轮询。
     *
     * 设计上的三条自我约束：
     * 1. **绝不影响灵动岛本体**。所有异常都在内部吞掉，最坏情况是点击退回
     *    「置前 + 复制标题 + ⌘K 粘贴」，岛照常显示。
     * 2. **失败要退避**。DSH 没开时别每 500ms 刷一次日志、别把 CPU 烧了。
     * 3. **可停止**。返回 stop()，设置项关掉或插件卸载时能干净收手。
     *
     * @param {object} opts
     * @param {number} [opts.basePort] 探测起始端口（自检用来指向空端口段）
     * @returns {{ stop: () => void, state: () => object }}
     */
    function startJumpBridge(ctx, { pollMs = BRIDGE_POLL_MS, onJump = null, basePort = BRIDGE_PORT_BASE } = {}) {
      const state = { base: null, version: null, stopped: false, polls: 0, jumps: 0, lastError: null };
      let timer = null;
      let fails = 0;
      let inFlight = false;

      async function tick() {
        if (state.stopped || inFlight) return;
        inFlight = true;
        try {
          if (!state.base) {
            const found = await probeBridge(basePort);
            if (state.stopped) return;
            if (!found) { state.lastError = "未找到跳转桥"; return; }
            state.base = found.base;
            state.version = found.version;
            bridgeLog("跳转桥已连上 " + found.base + "（插件 v" + found.version + "）");
          }

          // 停用后就不再发请求：stop() 只清定时器，管不到已经飞出去的那一轮，
          // 不在这里拦一道会把停用后的队列也吃掉。
          if (state.stopped) return;

          const res = await fetch(state.base + "/next", {
            cache: "no-store",
            signal: AbortSignal.timeout(2500),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const body = await res.json();
          fails = 0;
          state.polls += 1;

          // 请求可能已经回来了，这期间用户关掉了开关/插件被卸载：
          // 这时**不要执行**跳转。已经取走的请求会留在桥的队列外，
          // 那是一次无害的丢失，比停用后还擅自把用户切走要好。
          if (state.stopped) return;

          const items = (body && Array.isArray(body.items)) ? body.items : [];
          for (const it of items) {
            const sid = it && typeof it.sessionId === "string" ? it.sessionId.trim() : "";
            if (!sid) continue;
            state.jumps += 1;
            const ws = resolveWorkspace(ctx);
            if (!ws) {
              // 不抛：uiWorkspace 万一没就绪，下一轮用户再点一次即可
              bridgeLog("收到跳转请求但取不到 uiWorkspace 服务，跳过 " + sid);
              continue;
            }
            try {
              ws.openSession(sid);
              bridgeLog("已打开会话 " + sid + (it.title ? "（" + it.title + "）" : ""));
              if (typeof onJump === "function") { try { onJump(sid, it); } catch (e) { /* ignore */ } }
            } catch (e) {
              bridgeLog("openSession 抛错（会话可能已不存在）: " + ((e && e.message) || e));
            }
          }
        } catch (e) {
          fails += 1;
          state.lastError = (e && e.message) || String(e);
          // 桥不在了（DSH 重启 / 换了端口）：丢掉缓存的 base，重新探测
          if (state.base && fails >= BRIDGE_REPROBE_AFTER) {
            bridgeLog("跳转桥失联，重新探测端口");
            state.base = null;
          }
          if (fails === 1 || fails % 20 === 0) {
            bridgeLog("跳转桥暂不可用（第 " + fails + " 次）: " + state.lastError);
          }
        } finally {
          inFlight = false;
        }
      }

      // 立即探一次，别让用户等第一个周期
      setTimeout(tick, 0);
      timer = setInterval(tick, pollMs);

      return {
        stop() {
          state.stopped = true;
          if (timer) { clearInterval(timer); timer = null; }
        },
        state: () => ({ ...state }),
      };
    }

    // ---------------------------------------------------------------------------
    // 插件生命周期入口 (Cordis apply)
    // ---------------------------------------------------------------------------
    function apply(ctx) {
      // 启动诊断：宿主把 console 输出收集进 ~/Library/Logs/DeepSeek Harness/，
      // 这里输出一条可检索的标记，便于确认插件是否真的被激活、在哪一步停下。
      try {
        console.log("[dsh-vibe-island] apply() 已调用 | services=" +
          Object.keys(ctx || {}).filter((k) => /^(slots|sessions|configForms|settingsScope|settings|locale|remote|commandUi|uiWorkspace)$/.test(k)).join(",") +
          " | uiWorkspace=" + (resolveWorkspace(ctx) ? "可跳转" : "取不到(点击走⌘K)"));
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
        bridgeEnabled: true,
      };

      // ---- 跳转桥客户端 -------------------------------------------------
      // 读一次配置决定要不要起。桥只负责「点岛跳会话」，不参与渲染，
      // 所以即便它彻底失效（DSH 版本变了、端口被占），灵动岛照常显示。
      let bridge = null;
      let bridgeWanted = true;
      try {
        const snap = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
        if (snap && typeof snap === "object" && snap.bridgeEnabled === false) bridgeWanted = false;
      } catch (e) { /* 读不到就默认开 */ }

      if (bridgeWanted && typeof fetch === "function") {
        try {
          bridge = startJumpBridge(ctx, {
            onJump: (sid) => bridgeLog("跳转完成: " + sid),
          });
          // 记下实例：设置面板要靠它找到桥，才能把配置持久化到磁盘
          jumpBridgeRef = bridge;
          console.log("[dsh-vibe-island] 跳转桥客户端已启动（点岛上的对话将直接打开对应会话）");
        } catch (e) {
          console.warn("[dsh-vibe-island] 跳转桥客户端启动失败，点击将退回 ⌘K 方案:", (e && e.message) || e);
        }
      } else if (!bridgeWanted) {
        console.log("[dsh-vibe-island] 跳转桥客户端被配置关闭");
      } else {
        console.warn("[dsh-vibe-island] 当前环境没有 fetch，跳转桥不可用（点击退回 ⌘K 方案）");
      }

      // 把服务端存的配置拉回本地。
      //
      // 为什么必须做：宿主配置服务（configForms）被 profile 关掉时，
      // 用户上次在设置里改的值只存在服务端的 client-config.json 里。
      // 不拉回来，岛就会用硬编码默认值启动 —— 表现为「我明明关了，重启又回来了」。
      //
      // 放在 React 挂载**之前**发起，但不等它完成：即使慢一点也只是
      // 首帧用默认值，下一帧就对了。不能 await —— 桥探测要 1.2s 一次，
      // 卡住启动会拖慢整个插件。
      loadConfig(scope).then((cfg) => {
        if (cfg && Object.keys(cfg).length > 0) {
          console.log("[dsh-vibe-island] 已载入保存的配置:", JSON.stringify(cfg));
        }
      }).catch((e) => {
        console.warn("[dsh-vibe-island] 载入已保存配置失败（用默认值）:", (e && e.message) || e);
      });

      // ────────────────────────────────────────────────────────────────────
      // 窗口内的 DOM 灵动岛已移除
      // ────────────────────────────────────────────────────────────────────
      //
      // 曾经这里往 document.body 塞一个 fixed 定位的 div 画岛。现在不画了，
      // 原因都是它自己的：
      //
      // 1. **视觉冗余**：物理刘海上已经有一个真岛，窗口里再来一个，
      //    两个状态栏含义相同、位置不同，用户不知道该看哪个。
      // 2. **出不了 DSH 窗口**：渲染进程只能往 document.body 塞 DOM，
      //    所以窗口最小化、被别的窗口遮挡时它跟着消失 ——
      //    而"随时能看到智能体在干什么"恰恰是它的唯一价值。
      // 3. **抢焦点**：点它会切走 DSH 窗口的焦点，打断正在输入的用户。
      // 4. **点不到**：刘海被系统独占，鼠标要移到屏幕顶端才能碰到真岛；
      //    窗口里那个反而更显眼，于是用户点了没反应的真岛。
      //
      // 现在这个插件只剩三件事：
      //   · 在 DSH 设置面板里提供开关（控制物理刘海）
      //   · 维护本机回环桥，让「点岛上的对话 → 打开对应会话」成立
      //   · 缺 app 时自动把 DSHNotch.app 装好
      //
      // 物理刘海的显示由 DSHNotch.app 读同一份配置决定
      // （见 swift/Sources/DSHNotch/Core/IslandConfig.swift）。

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

        // 会话头部快捷入口：点一下开/关物理刘海。
        // 走 saveConfig 而不是只 scope.update —— 后者在 configForms
        // 被 profile 关掉时是静默失效的（见 updateField 的注释）。
        try {
          ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
            name: "conversation.session.header.utilities",
            id: "dsh-vibe-island-header-btn",
            order: 48,
          }, function HeaderBtn() {
            const cfg = readScopeConfig(scope);
            const on = cfg.notchEnabled !== false;
            return h("button", {
              className: "vibe-header-btn",
              title: on ? "关闭刘海灵动岛" : "开启刘海灵动岛",
              onClick: () => {
                const next = !(readScopeConfig(scope).notchEnabled !== false);
                writeLocalConfig({ ...readScopeConfig(scope), notchEnabled: next });
                saveConfig({ notchEnabled: next }, readScopeConfig(scope))
                  .then((r) => console.log("[dsh-vibe-island] 头部入口：刘海灵动岛已" + (next ? "开启" : "关闭")
                    + "（" + r.via + "）"))
                  .catch((e) => console.warn("[dsh-vibe-island] 头部入口写入失败:", (e && e.message) || e));
              },
            }, [
              h("span", { key: "icon" }, on ? "🏝️" : "⛔"),
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
      // 本地配置（localStorage / 桥上的兜底副本）作为基线。
      //
      // 为什么放在最底层：宿主配置服务（`configForms`）由
      // `@deepseek-ai/dsh-client-ui-settings` 提供，用户可以在自己 profile 的
      // cordis.patch.yml 里 `enabled: false` 关掉它（本机 desktop profile 就是）。
      // 那种情况下 scope 为 null，若这里不读本地值，
      // 岛与设置卡片都会退回硬编码默认值 —— 用户改过的设置看起来"没生效"，
      // 而且没有任何提示。
      const base = readLocalConfig();

      let host = {};
      if (scope) {
        try {
          if (typeof scope.getSnapshot === "function") host = scope.getSnapshot() || {};
          else if ("value" in scope) host = (typeof scope.value === "function" ? scope.value() : scope.value) || {};
        } catch (e) {
          console.warn("[dsh-vibe-island] 读取配置快照失败:", (e && e.message) || e);
        }
      }
      // ── 合并顺序：本地值覆盖宿主值 ──
      //
      // ⚠️ 反过来写（宿主覆盖本地）会有一个很难查的 bug：
      // 用户在面板上点了开关 → 值先写进本地 → 但 scope.getSnapshot()
      // 此刻还是旧值（宿主配置服务的更新是异步/或压根没这个键）
      // → 合并后又被冲回去 → **界面弹回原样，像没点上**。
      //
      // 哪个更"权威"取决于场景：宿主配置服务是 profile 级持久化，
      // 本地值是"用户刚点的"。后者时间上更近，理应赢。
      // 而且宿主缺这个键时（`notchEnabled` 是我们新增的）也只有本地有值。
      return { ...host, ...base };
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
    // 只注入「必定存在」的服务。
    //
    // 教训：任何**可能缺失**的服务都不能进 inject —— Cordis 会为缺失的服务
    // 无限等待，插件永久 pending（症状是启动日志一句
    // "pending (waiting for service: X)"，界面毫无表现）。
    //
    // configForms 由 `@deepseek-ai/dsh-client-ui-settings` 提供，而用户可以在
    // profile 的 cordis.patch.yml 里把它 `enabled: false` 关掉（本机 desktop
    // profile 正是如此）。因此这里**不注入** configForms，改为在 apply() 内
    // 运行时探测 `ctx.configForms`——拿不到就用默认配置，功能不降级。
    //
    // 同理 `uiWorkspace` 也不能进 inject：跳转桥靠 `ctx.get("uiWorkspace")`
    // 运行时取它，取不到就跳过这一跳，而不是让整个灵动岛消失。
    exports.inject = ["slots", "sessions"];
    exports.parseActivityFromEvents = parseActivityFromEvents;
    exports.formatDuration = formatDuration;
    exports.countActiveSubagents = countActiveSubagents;
    exports.bindConfigScope = bindConfigScope;
    // 导出的本地配置三件套：供自检在无 DOM 环境下验证读写与合并语义。
    exports.readLocalConfig = readLocalConfig;
    exports.writeLocalConfig = writeLocalConfig;
    exports.saveConfig = saveConfig;
    exports.loadConfig = loadConfig;
    exports.readScopeConfig = readScopeConfig;
    // 导出桥相关件供 test/test-bridge-client.mjs 离线自检
    exports.startJumpBridge = startJumpBridge;
    exports.resolveWorkspace = resolveWorkspace;
    exports.probeBridge = probeBridge;
    exports.BRIDGE_PORT_BASE = BRIDGE_PORT_BASE;

    return module.exports;
  }
});
