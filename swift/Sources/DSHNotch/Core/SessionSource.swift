import Foundation

/// 一个候选会话文件及其元信息。
///
/// DSH 的目录布局：
/// ```
/// ~/.dsh/sessions/<项目目录名>/<会话目录名>/session.v4.jsonl.zstd
///     --Users-delinger-Desktop-office--   session-a59ae858-…
/// ```
struct SessionFileInfo: Equatable {
    /// 会话 id（= 会话目录名，如 `session-a59ae858-…`）。同时是投影缓存的查找键。
    let id: String
    /// 项目目录名（如 `--Users-delinger-Desktop-office--`）
    let project: String
    let url: URL
    let mtime: Date
}

/// 会话数据源：发现 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，解压并解码为 `[SessionEvent]`。
///
/// 设计要点：
/// - **多会话**：DSH 可以同时开多个对话（本机实测同一分钟内有两个会话在写）。
///   这里提供 `sessionFiles()` 一次性给出全部候选，由 `SessionMonitor` 逐会话维护游标。
/// - **增量**：以文件 `mtime` + 大小做缓存，未变化则直接返回上次结果，避免重复解压。
/// - **容错**：任何单次读取失败都降级为空数组/空字典，App 不会崩。
final class SessionSource {
    private struct Cached {
        let events: [SessionEvent]
        let mtime: Date
        let size: Int
    }

    private let dshRoot: URL
    private let fm = FileManager.default
    /// 打开详细日志（诊断数据通路时用 DSH_NOTCH_VERBOSE=1）
    let verbose = ProcessInfo.processInfo.environment["DSH_NOTCH_VERBOSE"] != nil
    /// 按路径缓存多份（自检要连读多个会话文件；App 平时只用最新那个）
    private var caches: [String: Cached] = [:]
    private let decoder = JSONDecoder()
    /// 候选会话列表的短时缓存：`tick()` 里要问两次（事件流 + 投影），
    /// 而每次枚举整个 sessions 目录（+ stat 每个文件）不便宜。1 秒内复用同一次结果。
    /// 键包含**窗口长度** —— 自检会用更大的窗口重问一次，不区分就会拿到错的缓存。
    private var filesCache: (files: [SessionFileInfo], at: Date, limit: Int, window: TimeInterval)?

    init(dshRoot: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh", isDirectory: true)) {
        self.dshRoot = dshRoot
    }

    // MARK: - 会话发现

    /// 同时监控的会话数上限。超过就只取 mtime 最新的几个。
    static let maxSessions = 6

    /// 「活跃」窗口：最近这个时间内有写入的会话才进候选。
    ///
    /// 窗口存在的意义：DSH 会把历史会话长期留在磁盘上（本机有 9 个，最早的
    /// 是几天前），全量纳入会让岛变成「一堆早就结束的对话」的列表。
    /// 30 分钟足够覆盖「同时开着的几个对话」——在跑的那个会不断写文件，
    /// 暂停的也不会立刻掉出窗口。
    static let activeWindow: TimeInterval = 30 * 60

    /// 候选会话文件（按 mtime 倒序，最多 `maxCount` 个）。
    ///
    /// 若活跃窗口内一个都没有（刚开机、DSH 还没开始干活），退化为**全量最新的
    /// 1 个** —— 岛仍然有东西可显示，而不是空白。
    func sessionFiles(maxCount: Int = SessionSource.maxSessions,
                      activeWithin: TimeInterval = SessionSource.activeWindow) -> [SessionFileInfo] {
        if let c = filesCache, c.limit == maxCount, c.window == activeWithin,
           Date().timeIntervalSince(c.at) < 1.0 {
            return c.files
        }
        let all = scanAllSessionFiles()
        let cutoff = Date().addingTimeInterval(-activeWithin)
        var recent = all.filter { $0.mtime >= cutoff }.sorted { $0.mtime > $1.mtime }
        if recent.isEmpty { recent = Array(all.sorted { $0.mtime > $1.mtime }.prefix(1)) }
        let out = Array(recent.prefix(maxCount))
        filesCache = (out, Date(), maxCount, activeWithin)
        return out
    }

    /// 最新的单个会话文件（投影查找、菜单「在 Finder 中显示」等单目标场景用）。
    func latestSessionFile() -> URL? {
        sessionFiles(maxCount: 1).first?.url
    }

    private func scanAllSessionFiles() -> [SessionFileInfo] {
        let sessionsDir = dshRoot.appendingPathComponent("sessions", isDirectory: true)
        guard let walker = fm.enumerator(
            at: sessionsDir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var out: [SessionFileInfo] = []
        for case let url as URL in walker where url.lastPathComponent == "session.v4.jsonl.zstd" {
            guard let vals = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                  let d = vals.contentModificationDate else { continue }
            let sessionDir = url.deletingLastPathComponent()
            out.append(SessionFileInfo(id: sessionDir.lastPathComponent,
                                       project: sessionDir.deletingLastPathComponent().lastPathComponent,
                                       url: url,
                                       mtime: d))
        }
        return out
    }

    /// 把 DSH 的项目目录名还原成人看得懂的名字（**兜底**用）。
    ///
    /// `--Users-delinger-Desktop-deepisland--` → `deepisland`
    /// 规则：去掉首尾的连字符（DSH 用 `--` 包裹路径），再把 `-` 当分隔符取最后一段。
    /// 首选仍然是投影缓存里 DSH 自己总结的会话标题（`Projections.title`）。
    static func prettyProject(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        guard !trimmed.isEmpty else { return nil }
        let parts = trimmed.split(separator: "-")
        guard let last = parts.last, last.count >= 2 else { return nil }
        return String(last)
    }

    // MARK: - 读取

    /// 读取并解码事件流（带 mtime/size 缓存）。
    func loadEvents() -> [SessionEvent] {
        guard let file = latestSessionFile() else {
            if verbose { NSLog("[dsh-notch] loadEvents: 找不到会话文件") }
            return []
        }
        return loadEvents(from: file) ?? []
    }

    /// 读取**指定**会话文件的事件流（同样带缓存）。
    ///
    /// 与 `loadEvents()` 分开是为了自检能一次连读多个会话。
    func loadEvents(from file: URL) -> [SessionEvent]? {
        guard let vals = try? file.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey]),
              let mtime = vals.contentModificationDate, let size = vals.fileSize else {
            if verbose { NSLog("[dsh-notch] loadEvents: 读不到文件属性 \(file.lastPathComponent)") }
            return nil
        }

        if let c = caches[file.path], c.mtime == mtime, c.size == size { return c.events }

        guard let raw = decompress(url: file) else {
            if verbose { NSLog("[dsh-notch] loadEvents: 解压失败 \(file.path) (zstd=\(Self.zstdToolPath ?? "nil"))") }
            return nil
        }
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: true)
        let events = lines.compactMap { line -> SessionEvent? in
            try? decoder.decode(SessionEvent.self, from: Data(line.utf8))
        }
        if verbose {
            NSLog("[dsh-notch] loadEvents: \(file.lastPathComponent) 解压 \(raw.count) 字节 / \(lines.count) 行 → 解码成功 \(events.count) 条")
            if let first = events.first {
                NSLog("[dsh-notch]   首条: type=\(first.type) seq=\(first.seq ?? -1) name=\(first.data?.name ?? "-")")
            }
        }
        caches[file.path] = Cached(events: events, mtime: mtime, size: size)
        return events
    }

    // MARK: - zstd 解压

    /// 通过外部 zstd 工具解压。系统与 DSH 运行时都不提供 libzstd，
    /// 进程调用是最稳的路径（App 体积也小）。
    private func decompress(url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else {
            if verbose { NSLog("[dsh-notch] decompress: 读不到文件 \(url.lastPathComponent)") }
            return nil
        }
        // 极小文件直接判空（仅 zstd 帧头）
        guard data.count > 32 else { return "" }
        guard let tool = Self.zstdToolPath else {
            if verbose { NSLog("[dsh-notch] decompress: 未找到 zstd 工具") }
            return nil
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: tool)
        // zstdlite 只实现解压，用 -d（官方 zstd 用 -dc；两者都兼容）
        proc.arguments = ["-d", url.path]

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        do {
            try proc.run()
        } catch {
            if verbose { NSLog("[dsh-notch] decompress: run() 失败 \(error.localizedDescription)") }
            return nil
        }

        // 必须先读完 stdout 再 wait，否则管道写满会死锁
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        let err = errPipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()

        guard proc.terminationStatus == 0 else {
            if verbose {
                let msg = String(data: err, encoding: .utf8) ?? ""
                NSLog("[dsh-notch] decompress: 退出码 \(proc.terminationStatus) stderr=\(msg.prefix(200))")
            }
            return nil
        }
        return String(data: out, encoding: .utf8)
    }

    /// 查找可用的 zstd 解压工具。
    ///
    /// 优先用本仓库自带的 `zstdlite`（`tools/zstdlite`，只实现解压、无第三方依赖），
    /// 其次退回系统 `zstd`。可用 `DSH_NOTCH_ZSTD` 环境变量覆盖。
    static let zstdToolPath: String? = {
        var candidates: [String] = []
        if let o = ProcessInfo.processInfo.environment["DSH_NOTCH_ZSTD"],
           FileManager.default.isExecutableFile(atPath: o) { candidates.append(o) }

        // 随 App 打包的资源（Bundle.resources / 可执行文件同目录）
        let exeDir = URL(fileURLWithPath: CommandLine.arguments.first ?? "")
            .resolvingSymlinksInPath()
            .deletingLastPathComponent()
        candidates.append(exeDir.appendingPathComponent("zstdlite").path)
        candidates.append(exeDir.appendingPathComponent("zstd").path)

        // 常见安装位置
        candidates += [
            NSHomeDirectory() + "/.local/bin/zstdlite",
            NSHomeDirectory() + "/.local/bin/zstd",
            "/opt/homebrew/bin/zstd",
            "/usr/local/bin/zstd",
        ]
        // PATH 兜底
        if let p = ProcessInfo.processInfo.environment["PATH"] {
            for dir in p.split(separator: ":") {
                candidates.append("\(dir)/zstdlite")
                candidates.append("\(dir)/zstd")
            }
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }()
}
