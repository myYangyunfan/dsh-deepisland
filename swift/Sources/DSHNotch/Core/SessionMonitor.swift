import Foundation

/// 一个被监控会话的完整快照（视图直接渲染这个）。
struct SessionEntry: Identifiable, Equatable {
    let id: String
    let file: URL
    var project: String?
    var mtime: Date
    /// 展示名：投影里的会话标题 > 项目名 > id 短码
    var label: String
    var activity: Activity

    /// 排序权重：越小越该被关注。
    ///
    /// 「等人工确认」排最前 —— 那是唯一需要用户动手的状态，压在列表底部等于埋掉。
    var priority: Int {
        switch activity.status {
        case .waiting: return 0
        case .tool: return 1
        case .thinking: return 2
        case .done: return 3
        case .idle: return 4
        }
    }

    /// 是否在干活（`.done` 也算：结果还在回执期，属于「看得见的状态」）
    var isLive: Bool { activity.isActive }

    /// 列表右侧的短标签
    var shortTag: String {
        if let t = activity.currentTool, !t.isEmpty { return t }
        switch activity.status {
        case .thinking: return "思考中"
        case .waiting: return "待确认"
        case .done: return "已完成"
        case .idle: return "待命"
        case .tool: return "执行中"
        }
    }
}

/// 多会话监控器：为**每个会话维护独立游标**，一次轮询给出全部会话的状态。
///
/// 为什么需要它：`SessionSource` 单目标读取只跟 mtime 最新的那一个文件，而
/// DSH 可以同时开多个对话（本机实测 21:31 同一分钟有两个会话在写）。并行时
/// 只显示一个等于丢信息。
///
/// 性能设计：
/// - 每个会话一个 `ActivityCursor`，按 `seq` 增量推进，只处理新事件。
/// - **非主会话降频**：每 `secondaryRefreshEvery` 个 tick 才重新读一次文件。
///   否则 6 个会话同时跑时，每个 tick（250ms）都要起 6 个 zstd 解压进程。
///   主会话（上一轮排序第一的那个）每 tick 都刷，保证当前关注的那个最跟手。
/// - 掉出候选窗口的会话连同游标一起回收，内存不随历史会话增长。
final class SessionMonitor {
    /// 非主会话每多少个 tick 刷新一次（主会话每 tick 都刷）
    static let secondaryRefreshEvery = 4

    private struct State {
        var cursor = ActivityCursor()
        var entry: SessionEntry
    }

    /// 事件流停摆多久后，把「正在干活」降级为待命（毫秒）。
    ///
    /// 存在的意义：会话被关掉 / DSH 退出时，最后一条事件可能停在 `tool/call`
    /// （结果永远不来）。重放时游标会把那个中间状态当成现状，而文件不再更新，
    /// 于是岛上永远挂着一个假的「执行 bash」。
    ///
    /// 90 秒足够宽松 —— DSH 在跑的时候不可能 90 秒不写任何事件（模型增量、
    /// 工具事件、心跳都会写）。
    static let staleAfterMs: Double = 90_000

    private let source: SessionSource
    private let projections: ProjectionCache
    /// 「活跃」窗口（可注入：自检会放大到覆盖全部历史会话，以便验证多会话路径）
    private let activeWindow: TimeInterval
    private var states: [String: State] = [:]
    /// 上一轮排在最前的会话 id —— 它是「每 tick 刷新」的那一个
    private var primaryId: String?
    let verbose = ProcessInfo.processInfo.environment["DSH_NOTCH_VERBOSE"] != nil

    init(source: SessionSource,
         projections: ProjectionCache,
         activeWindow: TimeInterval = SessionSource.activeWindow) {
        self.source = source
        self.projections = projections
        self.activeWindow = activeWindow
    }

    /// 轮询一次，返回**按关注度排序**的会话列表（第一个即主会话）。
    ///
    /// - Parameters:
    ///   - now: 当前毫秒时间戳
    ///   - tickIndex: 轮询序号（用于非主会话降频）
    func poll(now: Double, tickIndex: Int) -> [SessionEntry] {
        let files = source.sessionFiles(activeWithin: activeWindow)
        var alive = Set<String>()
        var result: [SessionEntry] = []

        for (i, f) in files.enumerated() {
            alive.insert(f.id)
            // 首轮 / 上一轮的主会话 / 降频到点 → 重新读文件
            let isPrimary = (f.id == primaryId) || (primaryId == nil && i == 0)
            let due = isPrimary || states[f.id] == nil
                || tickIndex % Self.secondaryRefreshEvery == 0

            if due {
                let events = source.loadEvents(from: f.url) ?? []
                let proj = projections.load(for: f.url)
                var st = states[f.id] ?? State(entry: SessionEntry(id: f.id,
                                                                   file: f.url,
                                                                   project: f.project,
                                                                   mtime: f.mtime,
                                                                   label: Self.shortId(f.id),
                                                                   activity: .idle))
                let activity = Self.demoteIfStale(st.cursor.apply(events, now: now, projections: proj),
                                                  lastEventTime: st.cursor.lastEventTime,
                                                  now: now)
                st.entry.activity = activity
                st.entry.label = activity.proj.title.flatMap { $0.isEmpty ? nil : $0 }
                    ?? SessionSource.prettyProject(f.project)
                    ?? Self.shortId(f.id)
                states[f.id] = st
            }
            // mtime 每次都取最新的（纯目录项属性，不读文件内容）
            states[f.id]?.entry.mtime = f.mtime
            if let e = states[f.id]?.entry { result.append(e) }
        }

        // 回收：不再候选的会话丢弃游标
        if states.count > alive.count {
            for k in states.keys where !alive.contains(k) { states.removeValue(forKey: k) }
        }

        // 排序：状态优先级 → mtime 新在前（抽成静态方法便于自检直接断言）
        result = Self.order(result)
        primaryId = result.first?.id

        if verbose, tickIndex % Self.secondaryRefreshEvery == 0 {
            let brief = result
                .map { "\($0.label.prefix(12))(\($0.activity.status.rawValue),\($0.shortTag))" }
                .joined(separator: " | ")
            NSLog("[dsh-notch] 会话 \(result.count) 个: \(brief)")
        }
        return result
    }

    /// 停摆降级：事件流很久没推进 → 把「正在干活」改成待命。
    ///
    /// 只改快照、不动游标 —— 该会话真收到新事件时会自然恢复。
    /// 抽成静态方法是为了让自检能直接断言（App 跑起来时很难稳定复现一个停摆会话）。
    ///
    /// 三种情况不降级：
    /// - 状态本来就是待命（没什么可降的）
    /// - `.done`：回执期由它自己的 `doneAt` 超时管理，这里不该插手
    /// - 不知道最后事件时间（一个事件都没读到，宁可不动也不误杀）
    static func demoteIfStale(_ activity: Activity,
                              lastEventTime: Double?,
                              now: Double) -> Activity {
        guard activity.isActive, activity.status != .done,
              let t = lastEventTime, now - t > staleAfterMs else { return activity }
        var a = activity
        a.status = .idle
        a.title = ActivityStatus.idle.fallbackTitle
        a.detail = "等待指令输入"
        a.currentTool = nil
        a.isWaitingApproval = false
        a.pendingAgents = 0
        a.pendingTools = 0
        return a
    }

    /// 重置所有游标（下次 poll 全量重放）。
    func reset() {
        states.removeAll()
        primaryId = nil
    }

    /// 排序规则：状态优先级 → mtime 新在前。**第 0 个即主会话**。
    ///
    /// 优先级在 `SessionEntry.priority` 里定义：等人工确认 > 执行工具 > 思考 >
    /// 已完成 > 待命。「等人工确认」压在最前是因为它是唯一需要用户动手的状态，
    /// 排在列表底部等于把它埋掉。
    static func order(_ entries: [SessionEntry]) -> [SessionEntry] {
        entries.sorted { a, b in
            if a.priority != b.priority { return a.priority < b.priority }
            return a.mtime > b.mtime
        }
    }

    private static func shortId(_ id: String) -> String {
        let s = id.hasPrefix("session-") ? String(id.dropFirst("session-".count)) : id
        return String(s.prefix(8))
    }
}
