import Foundation

/// 会话数据源：定位 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 中最新的活跃会话，
/// 解压并解码为 `[SessionEvent]`。
///
/// 设计要点：
/// - **增量**：以文件 `mtime` + 大小做缓存，未变化则直接返回上次结果，避免重复解压。
/// - **活跃判定**：优先选 mtime 最近的会话；且要求 DSH 进程在跑（否则退化为 idle）。
/// - **容错**：任何单次读取失败都降级为空数组，App 不会崩。
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
    /// 「最新会话文件」的短时缓存：`tick()` 里要问两次（事件流 + 投影），
    /// 而每次枚举整个 sessions 目录不便宜。1 秒内复用同一次结果。
    private var latestCache: (url: URL?, at: Date)?

    init(dshRoot: URL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh", isDirectory: true)) {
        self.dshRoot = dshRoot
    }

    // MARK: - 会话发现

    /// 最新的会话文件（按 mtime 排序取第一）。
    func latestSessionFile() -> URL? {
        if let c = latestCache, Date().timeIntervalSince(c.at) < 1.0 { return c.url }
        let found = scanLatestSessionFile()
        latestCache = (found, Date())
        return found
    }

    private func scanLatestSessionFile() -> URL? {
        let sessionsDir = dshRoot.appendingPathComponent("sessions", isDirectory: true)
        guard let walker = fm.enumerator(
            at: sessionsDir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }

        var best: (url: URL, date: Date)?
        for case let url as URL in walker where url.lastPathComponent == "session.v4.jsonl.zstd" {
            guard let vals = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                  let d = vals.contentModificationDate else { continue }
            if best == nil || d > best!.date { best = (url, d) }
        }
        return best?.url
    }

    /// DSH 是否在运行。用于「只在 DSH 有活动时显示」的常驻策略。
    func isDSHRunning() -> Bool {
        // 端口 19387 是 DSH 的 web 服务；监听即视为在运行
        return portOpen(port: 19387)
    }

    private func portOpen(port: UInt16) -> Bool {
        // 避免引入 Network 框架依赖，用 /dev/tcp 不可移植 → 走 sysctl 判进程更稳。
        // 这里退化为「最近有会话文件被写过」作为近似信号。
        guard let f = latestSessionFile(),
              let vals = try? f.resourceValues(forKeys: [.contentModificationDateKey]),
              let d = vals.contentModificationDate else { return false }
        return Date().timeIntervalSince(d) < 60 * 30 // 30 分钟内有写入视为活跃
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
