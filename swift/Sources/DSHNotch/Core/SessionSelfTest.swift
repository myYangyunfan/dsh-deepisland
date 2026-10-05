import AppKit
import Foundation

/// 多会话路径的自检：排序规则 / 尺寸推导 / 真实多会话发现。
///
/// 为什么单独一个：`--self-test-projections` 验的是**单个会话**的解析正确性，
/// 而这次改动的核心恰恰是「同时监控多个对话」——那条路径原先一行测试都没有。
/// 本机实测存在同一分钟更新的两个会话（office 目录下），所以「候选多于一个」
/// 是真实场景，不是假设出来的。
final class SessionSelfTest {
    private var passed = 0
    private var failed = 0

    func run() -> Bool {
        let metrics = NotchMetrics.current()
        print("· 多会话排序规则")
        testOrder()
        print("· 展开尺寸随会话数变化")
        testSizes(metrics)
        print("· 无刘海屏尺寸（不得塌成 0）")
        testNoNotch()
        print("· 停摆会话降级（避免历史会话显示成「正在执行」）")
        testStaleDemotion()
        print("· 真实多会话发现与轮询")
        testRealSessions(metrics)
        print("· 点击热区（单会话整块可跳 / 多会话行可点）")
        testClickTargets()
        print("")
        print("[dsh-notch] 多会话自检结束：通过 \(passed)，失败 \(failed)")
        return failed == 0
    }

    /// 点击热区的结构断言。
    ///
    /// 背景：原先**只有单会话中间那块详情文字能点**，标题、待办、统计、模型行
    /// 点下去毫无反应 —— 但单会话时整个面板就是那一个对话，
    /// 用户的直觉是「这整块都是它」。改成整块可点后，
    /// 「点非对话区 = 钉住/取消」这个手势在单会话下就没有落点了，
    /// 所以顺手把折叠态那条路径留着（那里本来就是独立手势）。
    ///
    /// SwiftUI 没法在运行时遍历视图树，所以只能对源码做结构断言 ——
    /// 至少能守住「别把 contentShape/onTapGesture 弄丢」这种回归。
    private func testClickTargets() {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../UI/NotchContentView.swift")
        guard let src = try? String(contentsOf: url, encoding: .utf8) else {
            check(false, "能读到 NotchContentView.swift 源码")
            return
        }
        check(true, "能读到 NotchContentView.swift 源码")

        // singleSessionHUD 的函数体
        guard let start = src.range(of: "private var singleSessionHUD: some View") else {
            check(false, "能在源码里定位到 singleSessionHUD")
            return
        }
        let body = Self.braceBody(from: start.lowerBound, in: src)

        // 🔴 下面两条是踩过坑才加的：曾把整个面板做成可点，结果抢掉了外层
        // 「点一下 = 钉住/取消」的手势，展开态再也钉不住
        // （--self-test 当场报「展开态下点击 → 仍应钉住」失败）。
        // SwiftUI 里子视图手势优先于父视图，整块可点 = 吞掉钉住。
        let singleTaps = Self.tapScan(body)
        check(singleTaps.wrapsPanel == false,
              "singleSessionHUD 没有做成整块可点（否则抢掉钉住手势）",
              singleTaps.describe)
        check(singleTaps.all.count == 1,
              "singleSessionHUD 只有一个跳转热区（详情块）",
              "实际 \(singleTaps.all.count) 处")

        check(body.contains(".onTapGesture { openPrimarySession() }"),
              "详情块点它就跳到该对话",
              body.contains(".onTapGesture") ? "有手势但不是 openPrimarySession" : "函数体内没有任何 onTapGesture")
        // contentShape 必须在，否则 padding 出来的空白收不到点击
        check(body.contains(".contentShape(Rectangle())"),
              "热区配了 contentShape（否则 padding 出的空白点不到）")
        check(body.contains("点它即跳转"),
              "详情块注释说明了「点它即跳转」",
              "注释被改动过，意图丢了")

        // 多会话：每行可点 + 底部统计行跳主会话
        check(src.contains("state.onOpenSession?(s)"),
              "多会话的行可点（每行跳各自的对话）")

        // 整块可点同样会抢掉钉住手势；唯一例外是底部统计行 ——
        // 它显示的就是主会话指标，点它跳主会话不歧义。
        let multiBody = Self.bodyOf("private var multiSessionHUD: some View", in: src)
        let multiTaps = Self.tapScan(multiBody)
        check(multiTaps.wrapsPanel == false,
              "multiSessionHUD 没有做成整块可点（会抢掉钉住手势）",
              multiTaps.describe)
        check(multiTaps.all.count == 1,
              "多会话只有底部统计行这一个跳转热区",
              "实际 \(multiTaps.all.count) 处")

        // 折叠态的「点一下 = 钉住」必须还在
        check(src.contains(".onTapGesture { state.pinned.toggle() }"),
              "折叠态「点一下钉住」的手势仍在（别被整块可点吃掉）")
    }

    /// 扫一段视图代码里的 onTapGesture，判断它是不是「整块可点」。
    ///
    /// 「整块可点」的特征：onTapGesture 挂在 VStack 的**收尾链**上
    /// （那行 maxWidth/maxHeight 的 frame 之后），也就是整个面板都被它接管；
    /// 挂在某个子元素上则是正常热区。
    private struct TapScan {
        let all: [Int]        // 所有 onTapGesture 的行号（相对片段起点）
        let wrapsPanel: Bool  // 是否有任意一个落在 VStack 收尾之后
        let closingLine: Int

        var describe: String {
            let list = all.isEmpty ? "无" : all.map(String.init).joined(separator: ",")
            let tail = all.filter { $0 > closingLine }
            let tailText = tail.isEmpty ? "无" : tail.map(String.init).joined(separator: ",")
            return "onTapGesture 在第 \(list) 行，VStack 收尾在第 \(closingLine) 行，落在收尾之后的有第 \(tailText) 行"
        }
    }

    private static func tapScan(_ fragment: String) -> TapScan {
        let lines = fragment.components(separatedBy: "\n")
        var closing = -1
        var taps: [Int] = []
        for (i, line) in lines.enumerated() {
            if line.contains(".frame(maxWidth: .infinity, maxHeight: .infinity") {
                closing = i
            }
            if line.contains(".onTapGesture") {
                taps.append(i)
            }
        }
        let wrapped = taps.contains { $0 > closing }
        return TapScan(all: taps, wrapsPanel: wrapped, closingLine: closing)
    }

    /// 截出某个声明的**函数体**（大括号配平）。
    ///
    /// 坑：SwiftUI 的计算属性长这样
    /// ```swift
    /// private var singleSessionHUD: some View {
    ///     VStack { ... }
    ///         .frame(...)
    /// }
    /// ```
    /// 签名里那个 `some View` **后面**的 `{` 才是函数体的开始 ——
    /// 如果从签名的 `{` 之前开始数配平，会被 `VStack {` 的闭合提前打断，
    /// 截出来的东西支离破碎（实测截到了文件别处的方法）。
    /// 所以先跳过签名、找到第一个 `{`，从它之后开始数。
    private static func braceBody(from start: String.Index, in src: String) -> String {
        let rest = String(src[start...])
        guard let open = rest.firstIndex(of: "{") else { return "" }
        let afterOpen = rest.index(after: open)
        var depth = 1
        var i = 0
        let tail = String(rest[afterOpen...])
        for ch in tail {
            defer { i += 1 }
            if ch == "{" { depth += 1 }
            else if ch == "}" {
                depth -= 1
                if depth == 0 {
                    let cut = tail.index(tail.startIndex, offsetBy: i)
                    return String(tail[..<cut]) + "}"
                }
            }
        }
        return tail
    }

    private static func bodyOf(_ signature: String, in src: String) -> String {
        guard let r = src.range(of: signature) else { return "" }
        return braceBody(from: r.lowerBound, in: src)
    }

    // MARK: - 排序

    private func testOrder() {
        let base = Date()

        func entry(_ name: String, _ status: ActivityStatus, ageSec: Double) -> SessionEntry {
            var a = Activity()
            a.status = status
            a.title = name
            // 给个回合起点，展开列表里的耗时才不是空的
            a.turnStartTime = base.addingTimeInterval(-ageSec).timeIntervalSince1970 * 1000
            return SessionEntry(id: name,
                                file: URL(fileURLWithPath: "/tmp/\(name)"),
                                project: "proj",
                                mtime: base.addingTimeInterval(-ageSec),
                                label: name,
                                activity: a)
        }

        // 注意 mtime 与优先级**故意相反**：证明排序先看状态而不是谁更新得晚
        let list = [
            entry("idle", .idle, ageSec: 1),
            entry("done", .done, ageSec: 2),
            entry("thinking", .thinking, ageSec: 3),
            entry("tool", .tool, ageSec: 4),
            entry("waiting", .waiting, ageSec: 5),
        ]
        check(SessionMonitor.order(list).map(\.label) == ["waiting", "tool", "thinking", "done", "idle"],
              "状态优先级：待确认 > 执行 > 思考 > 完成 > 待命")

        // 同状态 → mtime 新的在前
        let same = [entry("old", .tool, ageSec: 100), entry("new", .tool, ageSec: 1)]
        check(SessionMonitor.order(same).map(\.label) == ["new", "old"],
              "同状态时 mtime 新的排在前面")

        check(SessionMonitor.order([]).isEmpty, "空列表排序不崩")
        check(SessionMonitor.order([entry("only", .idle, ageSec: 0)]).first?.label == "only",
              "单个会话时它就是主会话")

        // 主会话 = 第一个
        check(SessionMonitor.order(list).first?.label == "waiting", "主会话取排序第一个")

        // isLive：idle 不算在干活，done 算（结果回执期）
        check(entry("a", .idle, ageSec: 1).isLive == false, "待命不算「在干活」")
        check(entry("b", .done, ageSec: 1).isLive, "已完成算「在干活」（结果还在回执期）")

        // shortTag 兜底：没有 currentTool 时给状态短语
        check(entry("c", .waiting, ageSec: 1).shortTag == "待确认", "短标签兜底为状态短语")
        var withTool = entry("d", .tool, ageSec: 1)
        withTool.activity.currentTool = "bash"
        check(withTool.shortTag == "bash", "有工具名时短标签用工具名")
    }

    // MARK: - 无刘海屏（M1 Air / iMac / 合盖只接外接屏）

    /// 无刘海时曾经 `compactSize.height == 0`（notchHeight 0 + infoBandHeight 0），
    /// 折叠态面板整个不可见、只剩一条 16pt 悬停热区碰运气。这条断言把它钉死。
    ///
    /// 尺寸是构造出来的假屏幕，不依赖真机 —— 本机是带刘海的 Air，没有无刘海环境可用。
    private func testNoNotch() {
        let plain = NotchMetrics(screenFrame: NSRect(x: 0, y: 0, width: 1440, height: 900),
                                 notchRect: NSRect(x: 620, y: 900, width: 200, height: 0),
                                 hasNotch: false)

        check(plain.notchHeight == 0, "无刘海时 notchHeight 为 0")
        check(plain.compactSize.height > 0,
              "无刘海时折叠态高度不得为 0（实得 \(plain.compactSize.height)pt）")
        check(plain.compactSize.height >= 24, "无刘海折叠态高度够放一行文字（≥24pt）")
        check(plain.compactSize.width > 0, "无刘海折叠态有宽度")
        check(plain.expandedSize(sessionRows: 1).height > plain.compactSize.height,
              "无刘海时展开高于折叠")
        check(plain.expandedSize(sessionRows: 6).height > plain.expandedSize(sessionRows: 1).height,
              "无刘海时 6 会话高于 1 会话")
        check(plain.islandRect(expanded: false).height > 0, "无刘海时折叠命中的高度非 0")
        check(plain.islandRect(expanded: false).maxY == plain.screenFrame.maxY,
              "无刘海时岛体仍严格贴屏幕顶端")
        check(plain.windowSize.height >= plain.expandedSize(sessionRows: 6).height,
              "窗口按最大展开态开（无刘海时不裁）")
    }

    // MARK: - 尺寸

    private func testSizes(_ m: NotchMetrics) {
        let single = m.expandedSize(sessionRows: 1)
        check(single.height == m.notchHeight + 148, "单会话沿用原高度（刘海 + 148）")
        check(m.expandedSize(sessionRows: 2).height == single.height,
              "2 个会话不低于单会话高度（避免展开时突然塌一截）")
        check(m.expandedSize(sessionRows: 3).height == single.height, "3 个会话仍在下限之内")
        check(m.expandedSize(sessionRows: 4).height > single.height, "4 个会话开始变高")
        check(m.expandedSize(sessionRows: 6).height > m.expandedSize(sessionRows: 4).height,
              "6 个会话比 4 个高（高度由行数驱动）")
        check(m.expandedSize(sessionRows: 99).height == m.expandedSize(sessionRows: 6).height,
              "超过上限的行数被夹到 6（不会无限长高）")
        check(m.maxExpandedSize.height == m.expandedSize(sessionRows: 6).height,
              "窗口按最大展开尺寸（6 行）开")
        check(m.windowSize.height == m.maxExpandedSize.height + NotchMetrics.bleed,
              "窗口高度 = 最大展开高度 + 光晕留白")
        check(m.windowSize.width == m.maxExpandedSize.width + NotchMetrics.bleed * 2,
              "窗口宽度 = 最大展开宽度 + 两侧留白")

        // 内容带必须真的装得下 6 行
        let rowBlock = CGFloat(NotchMetrics.maxSessionRows) * NotchMetrics.sessionRowHeight
            + CGFloat(NotchMetrics.maxSessionRows - 1) * NotchMetrics.sessionRowGap
        check(m.maxExpandedSize.height - m.notchHeight >= rowBlock,
              "内容带装得下 \(NotchMetrics.maxSessionRows) 行（需要 \(rowBlock)pt，"
              + "有 \(m.maxExpandedSize.height - m.notchHeight)pt）")

        // 热区跟随形状尺寸
        let compactHot = m.islandRect(size: m.compactSize)
        let bigHot = m.islandRect(size: m.maxExpandedSize)
        check(bigHot.height > compactHot.height, "展开态热区比折叠态高（跟随形状）")
        check(bigHot.maxY == m.screenFrame.maxY, "热区顶端贴屏幕顶端")
        check(bigHot.midX == m.screenFrame.midX, "热区水平居中")
        check(m.islandSize(expanded: false, sessionRows: 6) == m.compactSize,
              "折叠态尺寸与会话数无关")

        // describe 是走 String(format:) 拼的，参数错位不会报错、只会静默输出垃圾
        //（实测过一次：展开宽度打成了高度、行数打成 0）。这里按内容断言。
        let desc = m.describe
        check(desc.contains(String(format: "展开 %.0f×%.0f", m.expandedSize(sessionRows: 1).width,
                                  m.expandedSize(sessionRows: 1).height)),
              "describe 里展开尺寸正确（宽×高）")
        check(desc.contains(String(format: "最高 %.0f", m.maxExpandedSize.height)),
              "describe 里最大展开高度正确")
        check(desc.contains("\(NotchMetrics.maxSessionRows) 会话"),
              "describe 里会话数上限正确")
        check(desc.contains(String(format: "折叠 %.0f×%.0f", m.compactSize.width, m.compactSize.height)),
              "describe 里折叠尺寸正确")
    }

    // MARK: - 停摆降级

    /// 会话被关掉 / DSH 退出时，最后一条事件可能停在 `tool/call`（结果永远不来）。
    /// 重放时游标会把那个中间状态当成现状 —— 必须按事件时间把它降级。
    private func testStaleDemotion() {
        let now = Date().timeIntervalSince1970 * 1000

        var running = Activity()
        running.status = .tool
        running.title = "执行 bash"
        running.currentTool = "bash"
        running.pendingTools = 1
        running.pendingAgents = 1

        let fresh = SessionMonitor.demoteIfStale(running, lastEventTime: now - 1000, now: now)
        check(fresh.status == .tool, "刚有事件推进的会话保持原状态")

        let stale = SessionMonitor.demoteIfStale(running, lastEventTime: now - 600_000, now: now)
        check(stale.status == .idle, "停摆 10 分钟的会话降级为待命")
        check(stale.currentTool == nil, "降级后不再显示残留的工具名")
        check(stale.pendingTools == 0 && stale.pendingAgents == 0, "降级后清掉在飞计数")
        check(stale.status == .idle && !stale.isActive, "降级后不算活跃（不再撑起刘海）")

        let under = SessionMonitor.demoteIfStale(
            running, lastEventTime: now - (SessionMonitor.staleAfterMs - 1), now: now)
        check(under.status == .tool, "未到阈值不降级")
        let over = SessionMonitor.demoteIfStale(
            running, lastEventTime: now - (SessionMonitor.staleAfterMs + 1), now: now)
        check(over.status == .idle, "刚过阈值即降级")

        var done = Activity()
        done.status = .done
        let doneStale = SessionMonitor.demoteIfStale(done, lastEventTime: now - 999_999, now: now)
        check(doneStale.status == .done, "已完成态不参与停摆降级（回执期自己超时）")

        let noTime = SessionMonitor.demoteIfStale(running, lastEventTime: nil, now: now)
        check(noTime.status == .tool, "不知道事件时间时不做降级（避免误杀）")
    }

    // MARK: - 真实数据

    private func testRealSessions(_ m: NotchMetrics) {
        let source = SessionSource()
        let proj = ProjectionCache()
        let wide: TimeInterval = 30 * 24 * 3600   // 放大窗口以覆盖全部历史会话

        let files = source.sessionFiles(maxCount: SessionSource.maxSessions, activeWithin: wide)
        check(!files.isEmpty, "能发现会话文件（找到 \(files.count) 个）")
        check(files.count <= SessionSource.maxSessions,
              "候选数不超过上限 \(SessionSource.maxSessions)（找到 \(files.count) 个）")

        var descending = true
        if files.count > 1 {
            for i in 1..<files.count where files[i].mtime > files[i - 1].mtime { descending = false }
        }
        check(descending, "候选按 mtime 倒序")

        check(SessionSource.prettyProject("--Users-delinger-Desktop-deepisland--") == "deepisland",
              "项目目录名可还原（--Users-delinger-Desktop-deepisland-- → deepisland）")
        check(SessionSource.prettyProject("--") == nil, "畸形项目名返回 nil 而不是空串")

        // 走完整 poll 路径（发现 → 解压 → 游标 → 投影 → 排序）
        let monitor = SessionMonitor(source: source, projections: proj, activeWindow: wide)
        let now = Date().timeIntervalSince1970 * 1000
        let entries = monitor.poll(now: now, tickIndex: 1)
        check(entries.count == files.count, "轮询覆盖全部候选（\(entries.count)/\(files.count)）")
        check(entries.allSatisfy { !$0.label.isEmpty }, "每个会话都有展示名")
        check(entries.allSatisfy { $0.label.count <= 40 }, "展示名长度合理")
        check(files.count <= 1 || entries.count > 1,
              "多会话场景确实被覆盖（本机 \(entries.count) 个候选）")

        let live = entries.filter(\.isLive)
        print("    候选 \(entries.count) 个，其中在干活 \(live.count) 个；主会话 = "
              + "「\(entries.first?.label ?? "-")」\(entries.first?.activity.status.rawValue ?? "-")")

        // 真实数据上的停摆降级：很久没更新的会话不该以活跃状态出现在岛上
        let staleLeaks = entries.filter { e in
            Date().timeIntervalSince(e.mtime) > SessionMonitor.staleAfterMs / 1000 && e.isLive
        }
        check(staleLeaks.isEmpty,
              staleLeaks.isEmpty
                ? "停摆会话没有以活跃状态出现"
                : "停摆会话仍显示为活跃：\(staleLeaks.map(\.label).joined(separator: ", "))")

        // 降频轮：非刷新 tick 不应崩、不应丢会话
        let again = monitor.poll(now: now + 250, tickIndex: 2)
        check(again.count == entries.count, "降频轮仍返回全部会话（\(again.count) 个）")
        check(again.first?.id == entries.first?.id, "降频轮主会话保持一致")

        // 窗口收窄到 0 秒 → 活跃窗口内应无候选，此时**退化为全量最新的 1 个**
        // 而不是变空（岛任何时候都得有东西可显示）
        let narrow = source.sessionFiles(maxCount: SessionSource.maxSessions, activeWithin: 0)
        check(narrow.count >= 1, "活跃窗口内无会话时不会变空（得到 \(narrow.count) 个）")
        check(narrow.count <= SessionSource.maxSessions, "退化结果同样受上限约束")

        // 重置后仍能正常工作
        monitor.reset()
        let afterReset = monitor.poll(now: now, tickIndex: 1)
        check(afterReset.count == entries.count, "reset 后能重建全部会话（\(afterReset.count) 个）")
        _ = m
    }

    // MARK: - 断言

    private func check(_ ok: Bool, _ msg: String, _ detail: String = "") {
        if ok {
            passed += 1
            print("  ✓ \(msg)")
        } else {
            failed += 1
            print("  ✗ \(msg)" + (detail.isEmpty ? "" : "  → " + detail))
        }
    }
}
