import SwiftUI

/// 灵动岛的可观察状态。
///
/// 视图树**只创建一次**，之后靠这里的 @Published 驱动刷新——
/// 早期实现每 250ms 重建一次 NSHostingView，展开动画刚起步就被打断，
/// 而且每次重建都会丢掉 SwiftUI 的过渡状态。
final class NotchViewState: ObservableObject {
    /// 当前活动快照
    @Published var activity: Activity = .idle
    /// 当前是否渲染为展开 HUD（= 用户钉住 或 正在等待确认）
    @Published var isExpanded = false
    /// 用户手动钉住展开态
    @Published var pinned = false
    /// 当前时间（毫秒），每 tick 更新，让耗时分秒能自己走字
    @Published var now: Double = Date().timeIntervalSince1970 * 1000
}

/// 灵动岛内容视图。
///
/// 布局约束（关键）：
/// - 宿主尺寸恒为**展开态**尺寸，顶端对齐 → 展开/折叠只是内部内容在变，窗口不动，动画不会被裁。
/// - 形状顶端与屏幕顶端重合（由 `NotchPanel` 定位保证），因此顶边方角不可见。
/// - 所有文字都从 `contentTopInset`（= 刘海高 28pt）之下开始 ——
///   刘海区域是**物理挖孔**，画在那里的像素永远不会被看到。
struct NotchContentView: View {
    let metrics: NotchMetrics
    @ObservedObject var state: NotchViewState

    private var activity: Activity { state.activity }
    private var status: ActivityStatus { activity.status }
    private var glow: Color {
        Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b)
    }

    /// 刘海下方信息带的高度（折叠 22，展开 132）
    private var contentHeight: CGFloat {
        let h = state.isExpanded ? metrics.expandedSize.height : metrics.compactSize.height
        return h - metrics.contentTopInset
    }

    private var islandWidth: CGFloat {
        (state.isExpanded ? metrics.expandedSize : metrics.compactSize).width
    }

    private var cornerRadius: CGFloat { state.isExpanded ? 20 : 12 }

    var body: some View {
        // 外层宿主：铺满整个窗口（= 展开态 + 四周留白），内容顶端居中对齐。
        //
        // 留白不是装饰：外发光（.shadow）要往外扩散，如果宿主刚好等于岛体尺寸，
        // 光晕会被 NSHostingView 的边界裁掉，展开态就只剩一个硬边黑块。
        ZStack(alignment: .top) {
            island
                .frame(width: islandWidth, height: contentHeight + metrics.contentTopInset)
                .animation(.spring(response: 0.34, dampingFraction: 0.8), value: state.isExpanded)
        }
        .frame(width: metrics.windowSize.width,
               height: metrics.windowSize.height,
               alignment: .top)
        // 点一下 = 钉住/取消钉住。
        //
        // 只能用「整块可点」而不是小按钮：面板平时是鼠标穿透的，只有指针在岛上时
        // 才临时打开交互（见 NotchPanel.isInteractive），小按钮的命中区太小、
        // 判定时机也难对齐。点击也不会漏给下层应用 —— 交互打开时窗口会吃掉这次点击。
        .onTapGesture { state.pinned.toggle() }
    }

    // MARK: - 岛体（形状 + 光晕 + 内容）

    /// 内层光晕带的**绝对高度**。
    ///
    /// 早期实现让渐变铺满整个形状（相对高度），展开态 160pt 里上半部分全被
    /// 青光淹没，文字对比度崩掉、剪影也糊了。改成固定 44pt：
    /// 顶端那 28pt 本来就被物理挖孔吃掉，露在信息带里的只剩渐变的尾巴 —— 一抹极淡的色。
    private var glowBandHeight: CGFloat { state.isExpanded ? 48 : 34 }

    private var island: some View {
        ZStack(alignment: .top) {
            // 底色 + 内层光晕：整体按形状裁剪，绝不外溢（外溢会让剪影边缘发虚）
            ZStack(alignment: .top) {
                Color.black
                if activity.isActive {
                    LinearGradient(colors: [glow.opacity(0.34), glow.opacity(0)],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: glowBandHeight)
                }
            }
            .clipShape(NotchShape(bottomRadius: cornerRadius))
            // 外层光晕：跟着形状剪影走的一圈柔光，这才是「光效」的来源
            .shadow(color: activity.isActive ? glow.opacity(0.55) : .clear, radius: 9, x: 0, y: 3)
            .animation(.spring(response: 0.34, dampingFraction: 0.8), value: state.isExpanded)

            // 内容整体下移一个刘海高 —— 物理挖孔内的像素看不见
            Group {
                if state.isExpanded { expandedHUD } else { compactRow }
            }
            .frame(height: contentHeight)
            .padding(.top, metrics.contentTopInset)
        }
        .animation(.spring(response: 0.34, dampingFraction: 0.8), value: activity.status)
    }

    // MARK: - 折叠态（刘海下方一条信息带）

    private var compactRow: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(glow)
                .frame(width: 6, height: 6)
                .shadow(color: glow.opacity(0.9), radius: 4)

            Text(activity.title)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundColor(Color(white: 0.94))
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)

            Spacer(minLength: 2)

            if let tool = activity.currentTool {
                Text(tool)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Color(white: 0.8))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(Color.white.opacity(0.14)))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }

            if activity.isActive, let t0 = activity.turnStartTime {
                Text(Activity.formatDuration(ms: state.now - t0))
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Color(white: 0.62))
                    .fixedSize()
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .contentShape(Rectangle())
    }

    // MARK: - 展开 HUD（刘海下方 132pt 面板）

    private var expandedHUD: some View {
        VStack(spacing: 7) {
            HStack(spacing: 7) {
                Circle().fill(glow).frame(width: 6, height: 6)

                Text(status.badge.uppercased())
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundColor(glow)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(glow.opacity(0.18)))

                Text(activity.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color(white: 0.66))
                    .lineLimit(1)

                Spacer()

                // 交互提示（点击整块岛体 = 钉住/取消钉住）
                if state.pinned {
                    Label("已钉住 · 点一下取消", systemImage: "pin.fill")
                        .font(.system(size: 9.5))
                        .foregroundColor(glow.opacity(0.9))
                } else {
                    Text("移开鼠标收起 · 点一下钉住")
                        .font(.system(size: 9.5))
                        .foregroundColor(Color(white: 0.34))
                }
            }
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).offset(y: 4)
            }

            Text(activity.detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Color(red: 0.65, green: 0.84, blue: 1.0))
                .lineLimit(3)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.07)))

            Spacer(minLength: 0)

            HStack(spacing: 12) {
                statItem("耗时", elapsedText)
                statItem("工具调用", activity.toolCountText)
                if activity.isWaitingApproval { statItem("待确认", "是") }
                Spacer()
                Text("DSH Notch")
                    .font(.system(size: 9))
                    .foregroundColor(Color(white: 0.36))
            }
            .overlay(alignment: .top) {
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).offset(y: -4)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var elapsedText: String {
        guard let t0 = activity.turnStartTime else { return "00:00" }
        return Activity.formatDuration(ms: state.now - t0)
    }

    private func statItem(_ label: String, _ value: String) -> some View {
        HStack(spacing: 3) {
            Text(label + ":").font(.system(size: 10)).foregroundColor(Color(white: 0.4))
            Text(value).font(.system(size: 10, design: .monospaced)).foregroundColor(Color(white: 0.85))
        }
    }
}
