import Foundation

/// DSH 会话投影缓存里的结构化运行指标。
///
/// 事件流（`session.v4.jsonl.zstd`）只记录「发生了什么」；而
/// `~/.dsh/storages/session_projcache/sessions/<id>.json` 是 DSH 自己对事件流
/// 做折叠（fold）之后的**状态快照**，含 token 用量、上下文压力、会话统计、
/// 待办、模型选择等。这些要么在事件流里得自己重算，要么事件本身不带。
///
/// 文件形如：
/// ```json
/// { "version": 7,
///   "record": { "rows": {
///     "tokenUsage":      { "ver": 1, "seq": 544, "val": { "totals": {…}, "last": {…} } },
///     "contextPressure": { "ver": 1, "seq": 544, "val": { "surfaceTokens": 77628, … } },
///     "sessionStats":    { "ver": 1, "seq": 544, "val": { "turns": 3, "steps": 98, … } },
///     "todos":           { "ver": 2, "seq": 544, "val": null },
///     …
///   } } }
/// ```
///
/// 每个 row 带 `seq` —— 该值**最后一次变化**的序号，与事件流同一坐标系。
/// 因此 row.seq 通常小于事件流最大 seq（值没变就不推进），**不能**拿它判滞后。
///
/// 注意：磁盘存的是完整 fold state，UI 用的是它的子集（wire view），
/// 所以这里能拿到比界面更多的字段（如 `sessionStats.openStep` / `pendingCalls`）。
struct Projections: Equatable {
    /// 所有 row 里最大的 seq（= 投影推进到哪一步）
    var seq: Int = 0

    // token 用量（累计）
    var outputTokens: Int?
    var uncachedInputTokens: Int?
    var cacheReadTokens: Int?

    // 上下文占用
    var contextUsed: Int?
    var contextWindow: Int?

    // 会话统计
    var turns: Int?
    var steps: Int?
    var llmMs: Double?
    var toolMs: Double?
    /// 有未闭合的 step（= 正在跑）
    var hasOpenStep: Bool = false
    /// 在飞的工具调用 callId（工具派发后、结果回来前）
    var pendingCallIds: [String] = []
    /// 正在运行的子代理数（由「在飞调用」∩「agent 类工具」推出，见 ActivityCursor）
    var pendingAgents: Int = 0

    // 待办
    var todoTotal: Int = 0
    var todoDone: Int = 0
    var todoCurrent: String?

    // 模型 / 模式
    var provider: String?
    var modelName: String?
    var planActive: Bool = false
    /// 权限预设（workspace-write / danger-full-access …）
    var permissionPreset: String?
    /// 会话标题（DSH 自己总结的，比第一句 prompt 干净）
    var title: String?

    /// 上下文占用比例（0…1）。宿主 UI 里这颗"上下文环"就是这个算法。
    var contextFraction: Double? {
        guard let used = contextUsed, let win = contextWindow, win > 0 else { return nil }
        return min(1.0, Double(used) / Double(win))
    }

    /// 累计输入（未命中缓存 + 缓存命中）
    var totalInputTokens: Int? {
        guard uncachedInputTokens != nil || cacheReadTokens != nil else { return nil }
        return (uncachedInputTokens ?? 0) + (cacheReadTokens ?? 0)
    }

    var hasTodo: Bool { todoTotal > 0 }

    /// 是否至少有一个字段可用（全空时 App 会退化为纯事件流展示）
    var isEmpty: Bool {
        outputTokens == nil && contextUsed == nil && turns == nil
            && todoTotal == 0 && modelName == nil && title == nil && permissionPreset == nil
    }

    /// token 数的紧凑写法：1234 → "1.2k"，39369 → "39.4k"，2106768 → "2.1M"
    static func shortTokens(_ n: Int) -> String {
        if n < 1000 { return "\(n)" }
        if n < 999_500 {
            let k = Double(n) / 1000
            return k < 100 ? String(format: "%.1fk", k) : String(format: "%.0fk", k)
        }
        let m = Double(n) / 1_000_000
        return m < 100 ? String(format: "%.1fM", m) : String(format: "%.0fM", m)
    }
}

/// 投影缓存读取器（带 mtime/size 缓存，避免每 250ms 重新解析）。
final class ProjectionCache {
    private struct Cached {
        let value: Projections
        let mtime: Date
        let size: Int
    }

    private let dshRoot: URL
    private let fm = FileManager.default
    let verbose = ProcessInfo.processInfo.environment["DSH_NOTCH_VERBOSE"] != nil
    private var cache: [String: Cached] = [:]

    init(dshRoot: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh", isDirectory: true)) {
        self.dshRoot = dshRoot
    }

    /// 会话 id → 投影文件。命名有两种历史形态：`session-<id>.json` 与 `<id>.json`。
    func projectionURL(for sessionFile: URL) -> URL? {
        let dirName = sessionFile.deletingLastPathComponent().lastPathComponent
        let id = dirName.hasPrefix("session-") ? String(dirName.dropFirst(8)) : dirName
        let base = dshRoot.appendingPathComponent("storages/session_projcache/sessions",
                                                  isDirectory: true)

        for name in ["session-\(id).json", "\(id).json"] {
            let u = base.appendingPathComponent(name)
            if fm.fileExists(atPath: u.path) { return u }
        }
        // 兜底：命名规则再变也能命中（按 id 子串匹配）
        guard let listing = try? fm.contentsOfDirectory(atPath: base.path) else { return nil }
        if let hit = listing.first(where: { $0.contains(id) && $0.hasSuffix(".json") }) {
            return base.appendingPathComponent(hit)
        }
        return nil
    }

    /// 读取并解析投影。会话文件没变（且投影文件也没变）时直接返回缓存。
    func load(for sessionFile: URL) -> Projections? {
        guard let url = projectionURL(for: sessionFile) else {
            if verbose { NSLog("[dsh-notch] projections: 找不到投影缓存（会话 \(sessionFile.lastPathComponent)）") }
            return nil
        }
        guard let vals = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
              let mtime = vals.contentModificationDate, let size = vals.fileSize else { return nil }

        if let c = cache[url.path], c.mtime == mtime, c.size == size { return c.value }

        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let p = Self.parse(data) else {
            if verbose { NSLog("[dsh-notch] projections: 解析失败 \(url.lastPathComponent)") }
            return nil
        }
        cache[url.path] = Cached(value: p, mtime: mtime, size: size)
        if verbose {
            NSLog("[dsh-notch] projections: \(url.lastPathComponent) seq=\(p.seq) turns=\(p.turns ?? -1) steps=\(p.steps ?? -1) out=\(p.outputTokens ?? -1) ctx=\(p.contextUsed ?? -1)/\(p.contextWindow ?? -1) pending=\(p.pendingCallIds.count) todo=\(p.todoDone)/\(p.todoTotal)")
        }
        return p
    }

    // MARK: - 解析

    /// 宽松解析：字段缺失/类型变化都不抛错，能拿多少拿多少。
    static func parse(_ data: Data) -> Projections? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let record = root["record"] as? [String: Any],
              let rows = record["rows"] as? [String: Any] else { return nil }

        var p = Projections()

        /// 取一个 row 的 val，并顺带把 seq 推高
        func row(_ key: String) -> [String: Any]? {
            guard let r = rows[key] as? [String: Any] else { return nil }
            if let s = int(r["seq"]) { p.seq = max(p.seq, s) }
            return r["val"] as? [String: Any]
        }

        func str(_ v: Any?) -> String? {
            guard let s = v as? String, !s.isEmpty else { return nil }
            return s
        }
        func int(_ v: Any?) -> Int? {
            if let n = v as? Int { return n }
            if let d = v as? Double, d.isFinite { return Int(d) }
            if let n = v as? NSNumber { return n.intValue }
            return nil
        }
        func dbl(_ v: Any?) -> Double? {
            if let d = v as? Double, d.isFinite { return d }
            if let n = v as? NSNumber { return n.doubleValue }
            return nil
        }

        // tokenUsage → totals
        if let v = row("tokenUsage"), let totals = v["totals"] as? [String: Any] {
            p.outputTokens = int(totals["outputTokens"])
            p.uncachedInputTokens = int(totals["uncachedInputTokens"])
            p.cacheReadTokens = int(totals["cacheReadTokens"])
        }

        // contextPressure
        if let v = row("contextPressure") {
            p.contextUsed = int(v["surfaceTokens"]) ?? int(v["pressureTokens"])
            p.contextWindow = int(v["contextWindow"])
        }

        // sessionStats（磁盘上有 openStep / pendingCalls，UI 不显示但我们要用）
        if let v = row("sessionStats") {
            p.turns = int(v["turns"])
            p.steps = int(v["steps"])
            p.llmMs = dbl(v["llmMs"])
            p.toolMs = dbl(v["toolMs"])
            p.hasOpenStep = !(v["openStep"] is NSNull) && v["openStep"] != nil
            if let pending = v["pendingCalls"] as? [String: Any] {
                p.pendingCallIds = pending.keys.sorted()
            }
        }

        // todos
        if let v = row("todos"), let list = v["todos"] as? [[String: Any]] {
            p.todoTotal = list.count
            p.todoDone = list.filter { str($0["status"]) == "completed" }.count
            p.todoCurrent = list.first { str($0["status"]) == "in_progress" }
                .flatMap { str($0["content"]) } ?? list.first { str($0["status"]) == "pending" }
                .flatMap { str($0["content"]) }
        }

        // modelSelection / plan / permissions
        if let v = row("modelSelection"), let last = v["lastUsed"] as? [String: Any] {
            p.provider = str(last["provider"])
            p.modelName = str(last["model"])
        }
        if let v = row("plan") { p.planActive = (v["active"] as? Bool) ?? false }
        if let v = row("permissions") { p.permissionPreset = str(v["preset"]) }

        // title 是个裸字符串 row
        if let r = rows["title"] as? [String: Any] {
            if let s = int(r["seq"]) { p.seq = max(p.seq, s) }
            p.title = str(r["val"])
        }

        return p
    }
}
