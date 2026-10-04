import AppKit
import SwiftUI

/// 离屏渲染预览：把灵动岛画在「模拟屏幕顶端 + 模拟菜单栏 + 模拟物理挖孔」上，
/// 输出 PNG 供肉眼校验形状。
///
/// 为什么需要它：本机 Electron 宿主不开 CDP、也没有可从外部断言屏幕渲染的手段，
/// 而「形状读起来像不像刘海延伸」恰恰只能靠看。于是把渲染搬到离屏画布上——
/// 关键是**把物理挖孔涂黑遮住**：真实刘海区域没有像素，画在那里的内容永远不可见，
/// 预览里用纯黑矩形复刻这一约束，才能暴露「文字被挖孔吃掉」这类问题。
///
/// 用法：`DSHNotch --render-preview <输出目录>`
enum PreviewRenderer {

    /// 一个预览用例：`sessions` 非空即渲染**多会话列表布局**（activity 取主会话）。
    private struct PreviewCase {
        let name: String
        let activity: Activity
        var sessions: [SessionEntry] = []
        let expanded: Bool
    }

    static func render(to dir: String, metrics: NotchMetrics) {
        let dirURL = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)

        let now = Date().timeIntervalSince1970 * 1000
        let cases: [PreviewCase] = [
            PreviewCase(name: "preview-compact-tool.png",
                        activity: sample(status: .tool, title: "执行 bash",
                                         detail: "ls -la ~/.dsh/sessions | head -20",
                                         tool: "bash", toolCount: 7, elapsedMs: 34_000, now: now,
                                         proj: richProjections(contextUsed: 77_628)),
                        expanded: false),
            PreviewCase(name: "preview-compact-waiting.png",
                        activity: sample(status: .waiting, title: "等待人工确认",
                                         detail: "提问: 是否覆盖写回文件？",
                                         tool: "ask", toolCount: 3, elapsedMs: 128_000, now: now,
                                         proj: richProjections(contextUsed: 168_000), waiting: true),
                        expanded: false),
            PreviewCase(name: "preview-compact-done.png",
                        activity: sample(status: .done, title: "任务已完成", detail: "调用 7 次工具",
                                         tool: nil, toolCount: 7, elapsedMs: 96_000, now: now,
                                         proj: richProjections(contextUsed: 77_628,
                                                               todos: [("调研开源项目", "completed"),
                                                                       ("设计技术蓝图", "in_progress"),
                                                                       ("写文档", "pending")],
                                                               pending: [])),
                        expanded: false),
            PreviewCase(name: "preview-expanded.png",
                        activity: sample(status: .tool, title: "执行 edit",
                                         detail: "swift/Sources/DSHNotch/UI/NotchShape.swift",
                                         tool: "edit", toolCount: 12, elapsedMs: 96_000, now: now,
                                         proj: richProjections(contextUsed: 77_628,
                                                               todos: [("调研开源项目", "completed"),
                                                                       ("设计技术蓝图", "in_progress"),
                                                                       ("写文档", "pending")],
                                                               pending: ["call_a", "call_b"]),
                                         agents: 1),
                        expanded: true),
            PreviewCase(name: "preview-expanded-alert.png",
                        activity: sample(status: .tool, title: "执行 bash",
                                         detail: "npm run build --production && npm test",
                                         tool: "bash", toolCount: 23, elapsedMs: 372_000, now: now,
                                         proj: richProjections(contextUsed: 228_000,
                                                               pending: ["call_a", "call_b",
                                                                         "call_c", "call_d"]),
                                         agents: 2),
                        expanded: true),

            // 多会话：折叠态显示主会话 + 会话数徽标（工具名让位给计数）
            PreviewCase(name: "preview-compact-multi.png",
                        activity: multiSessions(now: now, count: 3)[0].activity,
                        sessions: multiSessions(now: now, count: 3),
                        expanded: false),
            // 多会话：展开态一屏列出全部对话（3 个，含一个等人确认的在最上面）
            PreviewCase(name: "preview-multi-3.png",
                        activity: multiSessions(now: now, count: 3)[0].activity,
                        sessions: multiSessions(now: now, count: 3),
                        expanded: true),
            // 多会话：拉到上限 6 个，验证高度确实按行数长、内容没被裁
            PreviewCase(name: "preview-multi-6.png",
                        activity: multiSessions(now: now, count: 6)[0].activity,
                        sessions: multiSessions(now: now, count: 6),
                        expanded: true),
        ]

        for c in cases {
            let path = dirURL.appendingPathComponent(c.name).path
            guard let rep = renderOne(activity: c.activity, sessions: c.sessions,
                                      expanded: c.expanded, metrics: metrics, to: path) else {
                print("渲染失败 \(path)")
                continue
            }
            print("已输出 \(path)")

            // 再出一张 2 倍放大的中心裁切图 —— 形状细节在全屏图里看不清。
            // 裁切高度跟着**实际形状高度**走：多会话列表比单会话高，写死会切掉底部。
            let islandH = metrics.islandSize(expanded: c.expanded, sessionRows: c.sessions.count).height
            let zoomName = c.name.replacingOccurrences(of: ".png", with: "-zoom.png")
            let zoomPath = dirURL.appendingPathComponent(zoomName).path
            let cropWidth: CGFloat = c.expanded ? 700 : 460
            let cropHeight: CGFloat = max(islandH + 44, c.expanded ? 216 : 110)
            let region = NSRect(x: metrics.screenFrame.midX - metrics.screenFrame.minX - cropWidth / 2,
                                y: 0, width: cropWidth, height: cropHeight)
            if crop(from: rep, region: region, zoom: 2, canvasWidth: metrics.screenFrame.width, to: zoomPath) {
                print("已输出 \(zoomPath)")
            }
        }
    }

    // MARK: - 多会话预览数据

    /// 造一组多会话样本（已按 `SessionMonitor.order` 排好序，与真实运行一致）。
    ///
    /// 会话名用中文标题而非路径名 —— DSH 会把会话标题写进投影缓存
    /// （本机实测如「高难度数学试卷出题」），那才是列表里真正显示的文本。
    private static func multiSessions(now: Double, count: Int) -> [SessionEntry] {
        let waiting = entry("sodasystem 软著",
                            sample(status: .waiting, title: "等待人工确认",
                                   detail: "提问: 是否覆盖写回 软著申请材料.docx？",
                                   tool: "ask", toolCount: 3, elapsedMs: 128_000, now: now,
                                   proj: richProjections(contextUsed: 168_000), waiting: true),
                            ageSec: 9, project: "--Users-delinger-Desktop-~7EFC~6D4B--")
        let tool = entry("深岛刘海插件",
                         sample(status: .tool, title: "执行 edit",
                                detail: "swift/Sources/DSHNotch/UI/NotchContentView.swift",
                                tool: "edit", toolCount: 12, elapsedMs: 96_000, now: now,
                                proj: richProjections(contextUsed: 77_628),
                                agents: 2),
                         ageSec: 1, project: "--Users-delinger-Desktop-deepisland--")
        let thinking = entry("高难度数学试卷出题",
                             sample(status: .thinking, title: "深度思考中...",
                                    detail: "正在为第 12 题构造干扰项",
                                    tool: nil, toolCount: 4, elapsedMs: 62_000, now: now,
                                    proj: richProjections(contextUsed: 96_000)),
                             ageSec: 3, project: "--Users-delinger-Desktop-office--")
        let done = entry("itti.top 巡检",
                         sample(status: .done, title: "任务已完成", detail: "调用 9 次工具",
                                tool: nil, toolCount: 9, elapsedMs: 214_000, now: now,
                                proj: richProjections(contextUsed: 64_000)),
                         ageSec: 40, project: "--Users-delinger-Desktop-office--")
        let idle1 = entry("GOFS 部署脚本",
                          sample(status: .idle, title: "DeepSeek 待命", detail: "等待指令输入",
                                 tool: nil, toolCount: 0, elapsedMs: 0, now: now,
                                 proj: richProjections(contextUsed: 31_000)),
                          ageSec: 600, project: "--Users-delinger-Desktop-gofs--")
        let idle2 = entry("概率论 20 课时",
                          sample(status: .idle, title: "DeepSeek 待命", detail: "等待指令输入",
                                 tool: nil, toolCount: 0, elapsedMs: 0, now: now,
                                 proj: richProjections(contextUsed: 52_000)),
                          ageSec: 1200, project: "--Users-delinger-Desktop-office--")

        let all = [idle2, idle1, done, thinking, tool, waiting]
        return Array(SessionMonitor.order(all).prefix(count))
    }

    private static func entry(_ label: String,
                              _ activity: Activity,
                              ageSec: Double,
                              project: String) -> SessionEntry {
        SessionEntry(id: label,
                     file: URL(fileURLWithPath: "/tmp/preview/\(label)"),
                     project: project,
                     mtime: Date().addingTimeInterval(-ageSec),
                     label: label,
                     activity: activity)
    }

    // MARK: - 预览数据

    /// 组装一个带投影指标的示例 Activity。
    private static func sample(status: ActivityStatus,
                               title: String,
                               detail: String,
                               tool: String?,
                               toolCount: Int,
                               elapsedMs: Double,
                               now: Double,
                               proj: Projections,
                               agents: Int = 0,
                               waiting: Bool = false) -> Activity {
        var a = Activity(status: status, title: title, detail: detail,
                         currentTool: tool, toolCount: toolCount,
                         isWaitingApproval: waiting, turnStartTime: now - elapsedMs)
        a.turn = proj.turns
        a.step = proj.steps
        a.proj = proj
        a.pendingTools = proj.pendingCallIds.count
        a.pendingAgents = agents
        return a
    }

    /// 造一份接近真实（见 `ProjectionSelfTest` 里的 fixture）的投影快照。
    private static func richProjections(contextUsed: Int = 77_628,
                                        todos: [(String, String)] = [],
                                        pending: [String] = []) -> Projections {
        var p = Projections()
        p.seq = 544
        p.outputTokens = 39_369
        p.uncachedInputTokens = 2_106_768
        p.cacheReadTokens = 1_704_232
        p.contextUsed = contextUsed
        p.contextWindow = 262_144
        p.turns = 3
        p.steps = 98
        p.pendingCallIds = pending
        p.provider = "itti"
        p.modelName = "gemini-3.8-flash-high"
        p.permissionPreset = "workspace-write"
        p.title = "刘海屏智能体插件调研"
        if !todos.isEmpty {
            p.todoTotal = todos.count
            p.todoDone = todos.filter { $0.1 == "completed" }.count
            p.todoCurrent = (todos.first { $0.1 == "in_progress" } ?? todos.first { $0.1 == "pending" })?.0
        }
        return p
    }

    /// 从整屏渲染结果里裁一块并放大，便于肉眼核对圆角/对齐。
    private static func crop(from rep: NSBitmapImageRep,
                             region: NSRect,
                             zoom: CGFloat,
                             canvasWidth: CGFloat,
                             to path: String) -> Bool {
        guard let cg = rep.cgImage else { return false }
        let factor = CGFloat(cg.width) / canvasWidth
        let px = CGRect(x: region.minX * factor,
                        y: region.minY * factor,
                        width: region.width * factor,
                        height: region.height * factor)
        guard let cropped = cg.cropping(to: px) else { return false }

        let outW = Int(CGFloat(cropped.width) * zoom)
        let outH = Int(CGFloat(cropped.height) * zoom)
        guard let ctx = CGContext(data: nil, width: outW, height: outH,
                                  bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return false }
        ctx.interpolationQuality = .high
        ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: outW, height: outH))
        guard let out = ctx.makeImage() else { return false }
        guard let data = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: URL(fileURLWithPath: path))) != nil
    }

    @discardableResult
    private static func renderOne(activity: Activity,
                                  sessions: [SessionEntry],
                                  expanded: Bool,
                                  metrics: NotchMetrics,
                                  to path: String) -> NSBitmapImageRep? {
        let state = NotchViewState()
        state.activity = activity
        state.sessions = sessions
        state.isExpanded = expanded

        // 画布：整屏宽 × 够放下**最大**展开 HUD + 底部标注。
        // 多会话列表能长到 6 行（235pt），写死高度会把它截掉。
        let canvasW = metrics.screenFrame.width
        let canvasH = metrics.maxExpandedSize.height + 80

        let root = PreviewCanvas(metrics: metrics,
                                 state: state,
                                 canvasSize: CGSize(width: canvasW, height: canvasH))

        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(x: 0, y: 0, width: canvasW, height: canvasH)
        hosting.layoutSubtreeIfNeeded()
        // 给 SwiftUI 一帧时间完成首次布局/字体解析
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))

        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return nil }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
        guard (try? data.write(to: URL(fileURLWithPath: path))) != nil else { return nil }
        return rep
    }
}

/// 模拟画布：壁纸 → 菜单栏文字 → 岛 → 物理挖孔遮罩。
private struct PreviewCanvas: View {
    let metrics: NotchMetrics
    @ObservedObject var state: NotchViewState
    let canvasSize: CGSize

    /// 挖孔在画布中的水平偏移（刘海中心 == 屏幕中心，理论上是 0，仍按实测计算）
    private var cutoutOffsetX: CGFloat {
        metrics.notchRect.midX - metrics.screenFrame.minX - canvasSize.width / 2
    }

    var body: some View {
        ZStack(alignment: .top) {
            // 模拟壁纸（深色调，便于衬托黑色岛体轮廓）
            LinearGradient(colors: [Color(red: 0.13, green: 0.15, blue: 0.22),
                                    Color(red: 0.24, green: 0.28, blue: 0.38),
                                    Color(red: 0.16, green: 0.18, blue: 0.26)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)

            menuBar

            // 岛：水平居中、顶端贴屏（NotchContentView 自带窗口尺寸的外框）
            NotchContentView(metrics: metrics, state: state)

            // 物理挖孔：真实刘海处没有像素，涂黑即等价
            Rectangle()
                .fill(Color.black)
                .frame(width: metrics.notchWidth, height: metrics.notchHeight)
                .overlay(Rectangle().strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5))
                .offset(x: cutoutOffsetX)

            // 标注
            VStack {
                Spacer()
                Text("\(state.isExpanded ? "展开态" : "折叠态")  |  "
                     + "\(state.sessions.count > 1 ? "\(state.sessions.count) 个会话" : "单会话")  |  "
                     + "刘海 \(Int(metrics.notchWidth))×\(Int(metrics.notchHeight))pt  |  "
                     + "白框内为物理挖孔（其上不可绘制）")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.white.opacity(0.75))
                    .padding(.bottom, 18)
            }
            .frame(width: canvasSize.width, height: canvasSize.height)
        }
        .frame(width: canvasSize.width, height: canvasSize.height)
    }

    /// 模拟菜单栏：左侧应用菜单、右侧状态项（用来检查岛体是否盖住菜单文字）
    private var menuBar: some View {
        HStack(spacing: 0) {
            HStack(spacing: 18) {
                Text("").font(.system(size: 13))
                Text("访达").font(.system(size: 13, weight: .semibold))
                Text("文件").font(.system(size: 13))
                Text("编辑").font(.system(size: 13))
                Text("显示").font(.system(size: 13))
            }
            .foregroundColor(.white.opacity(0.92))
            .padding(.leading, 12)

            Spacer()

            HStack(spacing: 16) {
                Text("􀙇").font(.system(size: 12))
                Text("100%").font(.system(size: 12))
                Text("􀊨").font(.system(size: 12))
                Text("10月4日 周日 19:15").font(.system(size: 12))
            }
            .foregroundColor(.white.opacity(0.92))
            .padding(.trailing, 12)
        }
        .frame(height: metrics.notchHeight)
    }
}
