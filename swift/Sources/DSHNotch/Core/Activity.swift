import Foundation

/// 灵动岛展示的状态（与 DSH 插件端保持一致，另加 `.done`）。
enum ActivityStatus: String, Equatable {
    case idle
    case thinking
    case tool
    case waiting
    /// 回合已结束，但结果仍留在岛上显示一小段时间（避免"任务跑完什么都没看见"）
    case done

    /// 折叠胶囊主标题（thinking/tool/waiting 时用 detail 覆盖）。
    var fallbackTitle: String {
        switch self {
        case .idle: return "DeepSeek 待命"
        case .thinking: return "深度思考中..."
        case .tool: return "执行中"
        case .waiting: return "等待人工确认"
        case .done: return "任务已完成"
        }
    }

    /// 展开 HUD 顶部英文角标。
    var badge: String {
        switch self {
        case .idle: return "Ready"
        case .thinking: return "Thinking"
        case .tool: return "Executing Tool"
        case .waiting: return "Action Required"
        case .done: return "Done"
        }
    }

    /// 光晕颜色（RGB），与插件端 CSS 一致。
    var glowRGB: (r: Double, g: Double, b: Double) {
        switch self {
        case .idle: return (0.31, 0.31, 0.35)      // #50505A
        case .thinking: return (0.31, 0.49, 1.0)   // #4E7CFF
        case .tool: return (0.0, 0.82, 0.67)      // #00D2AA
        case .waiting: return (1.0, 0.67, 0.0)     // #FFAA00
        case .done: return (0.29, 0.87, 0.50)      // #4ADE80
        }
    }

    /// 是否算「DSH 正在干活」。`.done` 不算 —— 它只是结果回执。
    var isBusy: Bool { self == .thinking || self == .tool || self == .waiting }
}

/// 一次采样得到的完整活动快照。
struct Activity: Equatable {
    var status: ActivityStatus = .idle
    var title: String = "DeepSeek 待命"
    var detail: String = "等待指令输入"
    var currentTool: String?
    var toolCount: Int = 0
    var isWaitingApproval: Bool = false
    /// 本回合起始时间（毫秒），用于算耗时。
    var turnStartTime: Double?
    /// 当前轮次 / 步骤
    var turn: Int?
    var step: Int?
    /// 正在运行的子代理数（由「在飞调用」∩「agent 类工具」推出）
    var pendingAgents: Int = 0
    /// 在飞的工具调用总数
    var pendingTools: Int = 0
    /// 投影缓存带来的结构化指标（token / 上下文 / 待办 / 模型 …）
    var proj = Projections()

    /// 是否处于活跃态（决定刘海是否显示）。`.done` 也算 —— 要让用户看见结果。
    var isActive: Bool { status != .idle }

    static let idle = Activity()

    var toolCountText: String { "\(toolCount) 次" }

    /// 轮次徽标，如 `T2·S14`
    var turnStepText: String? {
        guard let t = turn else { return nil }
        if let s = step { return "T\(t)·S\(s)" }
        return "T\(t)"
    }

    /// 上下文占用百分比文本，如 `28%`
    var contextText: String? {
        guard let f = proj.contextFraction else { return nil }
        return "\(Int((f * 100).rounded()))%"
    }

    /// 上下文占用分档：0 常规（<50%）、1 提醒（50–80%）、2 警告（>80%）
    var contextLevel: Int {
        guard let f = proj.contextFraction else { return 0 }
        if f > 0.8 { return 2 }
        if f > 0.5 { return 1 }
        return 0
    }

    /// 待办进度文本，如 `2/3`
    var todoText: String? {
        guard proj.hasTodo else { return nil }
        return "\(proj.todoDone)/\(proj.todoTotal)"
    }

    /// 毫秒 → mm:ss（超过一小时给 h:mm:ss）
    static func formatDuration(ms: Double) -> String {
        guard ms > 0, ms.isFinite else { return "00:00" }
        let total = Int(ms / 1000)
        if total >= 3600 {
            return String(format: "%d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
        }
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}

/// 增量事件游标：按 `seq` 单调推进，只处理新事件。
///
/// 与 DSH 插件端同一套设计原则——游标不能依赖数组引用。这里 `seq` 来自事件
/// 自身，是稳定标识，因此即使每次重新解压整个文件也不会重复处理。
struct ActivityCursor {
    /// 回合结束后，结果在岛上停留多久（毫秒）
    static let doneHoldMs: Double = 5000

    /// 被派发子代理的工具名。命中即在「在飞调用」里计入子代理数。
    ///
    /// 来源：`app.asar` 里 `tool.call.toolview` 注册的 slot key
    /// （`subagent` / `list_agents` / `send_message` / `interrupt_agent` / `job_*`）。
    /// 只取真正会拉起 / 驱动一个子代理的两个，避免把"查询列表"也算成并发。
    static let agentTools: Set<String> = ["subagent", "send_message"]

    private(set) var lastSeq: Int = 0
    private var toolCount: Int = 0
    private var turnStart: Double?
    private var current: Activity = .idle
    /// 「本回合是否已结束」——结束后仍需保留 toolCount 供 HUD 展示。
    private var sawTurnEnd = false
    private var everSawEvent = false
    /// 进入 `.done` 的时刻，用于超时后转回 `.idle`
    private var doneAt: Double?
    /// callId → 工具名（事件流给映射，投影只给在飞的 callId）
    private var callNames: [String: String] = [:]

    mutating func reset() {
        lastSeq = 0
        toolCount = 0
        turnStart = nil
        current = .idle
        sawTurnEnd = false
        everSawEvent = false
        doneAt = nil
        callNames.removeAll()
    }

    /// 推进游标并返回最新快照。
    ///
    /// - Parameters:
    ///   - events: 事件流（每次可给全量，游标按 seq 去重）
    ///   - now: 当前毫秒时间戳
    ///   - projections: 投影缓存快照。为 nil 时退化为纯事件流展示。
    mutating func apply(_ events: [SessionEvent],
                        now: Double,
                        projections: Projections? = nil) -> Activity {
        let seqs = events.compactMap(\.seq)
        // 文件被截断/替换 → 游标失效，重来
        if let maxSeq = seqs.max(), maxSeq < lastSeq { reset() }

        for ev in events {
            guard let seq = ev.seq, seq > lastSeq else { continue }
            lastSeq = seq
            everSawEvent = true
            handle(ev, now: now)
        }
        if !everSawEvent { return .idle }

        // 快照同步：toolCount 是游标的私有累计量，必须显式写进快照
        // （早期漏了这一步，导致 HUD 里「工具调用」永远显示 0 次）
        current.toolCount = toolCount

        // 回合结束后的静默期：到点自动转回待命（岛收起）
        if current.status == .done, let t = doneAt, now - t > Self.doneHoldMs {
            current.status = .idle
            current.title = "DeepSeek 待命"
            current.detail = "等待指令输入"
            current.currentTool = nil
            doneAt = nil
        }

        merge(projections)
        return current
    }

    /// 把投影指标并进快照。
    private mutating func merge(_ p: Projections?) {
        guard let p else {
            current.proj = Projections()
            current.pendingAgents = 0
            current.pendingTools = 0
            return
        }
        current.proj = p
        // 轮次/步骤：事件流没给就用投影兜底
        if current.turn == nil { current.turn = p.turns }
        if current.step == nil { current.step = p.steps }

        // 在飞调用：投影给 callId，事件流给 callId→工具名
        let names = p.pendingCallIds.compactMap { callNames[$0] }
        current.pendingTools = p.pendingCallIds.count
        current.pendingAgents = names.filter { Self.agentTools.contains($0) }.count
    }

    private mutating func handle(_ ev: SessionEvent, now: Double) {
        let t = ev.type
        let d = ev.data

        // 带 turn/step 的事件一律同步（step/start、tool/call、tool/result 都带）
        if let turn = d?.turn { current.turn = turn }
        if let step = d?.step { current.step = step }

        // 工具调用登记 callId → 名字（用于把投影的在飞 callId 翻成工具名）
        if t == "tool/call", let id = d?.callId, let name = d?.name {
            callNames[id] = name
            if callNames.count > 512 { callNames.removeAll(keepingCapacity: true) }
        }

        // 回合开始：重置本回合计数与状态
        if t == "turn/start" || t == "user/message" {
            toolCount = 0
            sawTurnEnd = false
            doneAt = nil
            // 注意：时间戳在事件顶层（ev.time），不在 ev.data 里
            turnStart = ev.time ?? now
            current.status = .thinking
            current.title = "正在分析与规划..."
            current.detail = "解析任务上下文中"
            current.currentTool = nil
            current.isWaitingApproval = false
            if let turn = d?.turn { current.turn = turn }
            current.step = nil
            return
        }

        // 思考增量
        if t == "assistant/message" || t.hasPrefix("model/") {
            if current.status != .tool {
                current.status = .thinking
                if current.title != "正在分析与规划..." {
                    current.title = "深度思考中..."
                }
            }
            if let text = d?.text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                current.detail = String(text.suffix(60))
            }
            if let s = d?.step { current.step = s }
            return
        }

        // 工具调用
        if t == "tool/call" {
            let name = d?.name ?? "工具"
            toolCount += 1
            current.status = .tool
            current.currentTool = name
            let arg = d?.arguments?.displayText ?? name
            current.title = "执行 \(name)"
            current.detail = String(arg.prefix(100))
            // 带 question 的调用表示在等人工确认
            if arg.hasPrefix("提问:") {
                current.status = .waiting
                current.isWaitingApproval = true
            }
            return
        }

        // 工具结束 → 回到思考
        if t == "tool/result" {
            current.isWaitingApproval = false
            if current.status == .tool || current.status == .waiting {
                current.status = .thinking
                current.title = "分析工具执行结果..."
            }
            return
        }

        // 回合结束 → done（结果在岛上留一会儿，而非立刻归位）
        if t == "turn/end" || t == "model/done" {
            current.status = .done
            current.title = "任务已完成"
            current.detail = "调用 \(toolCount) 次工具"
            current.currentTool = nil
            current.isWaitingApproval = false
            sawTurnEnd = true
            doneAt = now
            return
        }

        // 报错
        if t.contains("error") || d?.isError == true {
            current.status = .done
            current.title = "执行遇到注意项"
            current.detail = "工具返回警告"
            doneAt = now
            return
        }

        // 兜底：用 status 兜住「回合已结束但没有 turn/end」的异常序列
        if current.status == .idle && !sawTurnEnd && turnStart != nil {
            current.status = .thinking
        }
    }
}
