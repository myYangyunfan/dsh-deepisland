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

    static func render(to dir: String, metrics: NotchMetrics) {
        let dirURL = URL(fileURLWithPath: dir)
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)

        let cases: [(String, Activity, Bool)] = [
            ("preview-compact-tool.png",
             Activity(status: .tool, title: "执行 bash", detail: "ls -la ~/.dsh/sessions | head -20",
                      currentTool: "bash", toolCount: 7, isWaitingApproval: false,
                      turnStartTime: Date().timeIntervalSince1970 * 1000 - 34_000), false),
            ("preview-compact-waiting.png",
             Activity(status: .waiting, title: "等待人工确认", detail: "提问: 是否覆盖写回文件？",
                      currentTool: "ask", toolCount: 3, isWaitingApproval: true,
                      turnStartTime: Date().timeIntervalSince1970 * 1000 - 128_000), false),
            ("preview-expanded.png",
             Activity(status: .tool, title: "执行 edit", detail: "swift/Sources/DSHNotch/UI/NotchShape.swift",
                      currentTool: "edit", toolCount: 12, isWaitingApproval: false,
                      turnStartTime: Date().timeIntervalSince1970 * 1000 - 96_000), true),
        ]

        for (name, activity, expanded) in cases {
            let path = dirURL.appendingPathComponent(name).path
            guard let rep = renderOne(activity: activity, expanded: expanded, metrics: metrics, to: path) else {
                print("渲染失败 \(path)")
                continue
            }
            print("已输出 \(path)")

            // 再出一张 2 倍放大的中心裁切图 —— 形状细节在全屏图里看不清
            let zoomName = name.replacingOccurrences(of: ".png", with: "-zoom.png")
            let zoomPath = dirURL.appendingPathComponent(zoomName).path
            let cropWidth: CGFloat = expanded ? 700 : 460
            let region = NSRect(x: metrics.screenFrame.midX - metrics.screenFrame.minX - cropWidth / 2,
                                y: 0, width: cropWidth, height: 140)
            if crop(from: rep, region: region, zoom: 2, canvasWidth: metrics.screenFrame.width, to: zoomPath) {
                print("已输出 \(zoomPath)")
            }
        }
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
                                  expanded: Bool,
                                  metrics: NotchMetrics,
                                  to path: String) -> NSBitmapImageRep? {
        let state = NotchViewState()
        state.activity = activity
        state.isExpanded = expanded

        // 画布：整屏宽 × 顶部 200pt（够放下展开 HUD + 标注）
        let canvasW = metrics.screenFrame.width
        let canvasH = metrics.notchHeight + 200

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
                Text("\(state.isExpanded ? "展开态" : "折叠态")  |  刘海 \(Int(metrics.notchWidth))×\(Int(metrics.notchHeight))pt  |  白框内为物理挖孔（其上不可绘制）")
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
