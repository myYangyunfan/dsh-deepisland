import Foundation

/// 灵动岛展示的四种状态（与 DSH 插件端保持一致）。
enum ActivityStatus: String, Equatable {
    case idle
    case thinking
    case tool
    case waiting

    /// 折叠胶囊主标题（thinking/tool/waiting 时用 detail 覆盖）。
    var fallbackTitle: String {
        switch self {
        case .idle: return "DeepSeek 待命"
        case .thinking: return "深度思考中..."
        case .tool: return "执行中"
        case .waiting: return "等待人工确认"
        }
    }

    /// 展开 HUD 顶部英文角标。
    var badge: String {
        switch self {
        case .idle: return "Ready"
        case .thinking: return "Thinking"
        case .tool: return "Executing Tool"
        case .waiting: return "Action Required"
        }
    }

    /// 光晕颜色（RGB），与插件端 CSS 一致。
    var glowRGB: (r: Double, g: Double, b: Double) {
        switch self {
        case .idle: return (0.31, 0.31, 0.35)      // #50505A
        case .thinking: return (0.31, 0.49, 1.0)   // #4E7CFF
        case .tool: return (0.0, 0.82, 0.67)      // #00D2AA
        case .waiting: return (1.0, 0.67, 0.0)     // #FFAA00
        }
    }
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
    /// 是否处于活跃态（决定刘海是否显示）。
    var isActive: Bool { status != .idle }

    static let idle = Activity()

    var toolCountText: String { "\(toolCount) 次" }

    /// 毫秒 → mm:ss
    static func formatDuration(ms: Double) -> String {
        guard ms > 0, ms.isFinite else { return "00:00" }
        let total = Int(ms / 1000)
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}

/// 增量事件游标：按 `seq` 单调推进，只处理新事件。
///
/// 与 DSH 插件端同一套设计原则——游标不能依赖数组引用。这里 `seq` 来自事件
/// 自身，是稳定标识，因此即使每次重新解压整个文件也不会重复处理。
struct ActivityCursor {
    private(set) var lastSeq: Int = 0
    private var toolCount: Int = 0
    private var turnStart: Double?
    private var current: Activity = .idle
    /// 「本回合是否已结束」——结束后仍需保留 toolCount 供 HUD 展示。
    private var sawTurnEnd = false
    private var everSawEvent = false

    mutating func reset() {
        lastSeq = 0
        toolCount = 0
        turnStart = nil
        current = .idle
        sawTurnEnd = false
        everSawEvent = false
    }

    /// 推进游标并返回最新快照。
    mutating func apply(_ events: [SessionEvent], now: Double) -> Activity {
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
        return current
    }

    private mutating func handle(_ ev: SessionEvent, now: Double) {
        let t = ev.type
        let d = ev.data

        // 回合开始：重置本回合计数与状态
        if t == "turn/start" || t == "user/message" {
            toolCount = 0
            sawTurnEnd = false
            // 注意：时间戳在事件顶层（ev.time），不在 ev.data 里
            turnStart = ev.time ?? now
            current.status = .thinking
            current.title = "正在分析与规划..."
            current.detail = "解析任务上下文中"
            current.currentTool = nil
            current.isWaitingApproval = false
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

        // 回合结束 → 空闲（保留计数供 HUD 显示）
        if t == "turn/end" || t == "model/done" {
            current.status = .idle
            current.title = "任务已完成"
            current.detail = "调用 \(toolCount) 次工具"
            current.currentTool = nil
            current.isWaitingApproval = false
            sawTurnEnd = true
            return
        }

        // 报错
        if t.contains("error") || d?.isError == true {
            current.status = .idle
            current.title = "执行遇到注意项"
            current.detail = "工具返回警告"
            return
        }

        // 兜底：用 status 兜住「回合已结束但没有 turn/end」的异常序列
        if current.status == .idle && !sawTurnEnd && turnStart != nil {
            current.status = .thinking
        }
    }
}
