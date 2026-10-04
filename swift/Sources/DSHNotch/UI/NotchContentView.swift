import SwiftUI

/// 灵动岛的可观察状态：展开与否由 App 层持有，视图只读。
final class NotchViewState: ObservableObject {
    @Published var isExpanded = false
    @Published var hovering = false
}

/// 灵动岛内容视图：折叠胶囊 ⇄ 展开 HUD。
///
/// 折叠态贴着刘海（34px 高），展开态向下生长成 HUD（440×146）。
/// 两种形态共用同一个 `NotchShape`，宽度用 spring 过渡。
struct NotchContentView: View {
    let activity: Activity
    @ObservedObject var state: NotchViewState

    private var status: ActivityStatus { activity.status }
    private var isExpanded: Bool { state.isExpanded }

    /// 折叠宽度：空闲窄一点，活跃时留足放徽章。
    private var compactWidth: CGFloat {
        activity.isActive ? 250 : 200
    }
    private var expandedWidth: CGFloat { 440 }
    private var compactHeight: CGFloat { 34 }
    private var expandedHeight: CGFloat { 146 }

    var body: some View {
        ZStack(alignment: .top) {
            // 背景形状：整个刘海区域纯黑，形成视觉延伸
            NotchShape(
                topEar: 11,
                bottomRadius: isExpanded ? 22 : 16
            )
            .fill(Color.black)

            // 光晕层（仅活跃时）
            if activity.isActive {
                NotchShape(topEar: 11, bottomRadius: isExpanded ? 22 : 16)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b).opacity(0.55),
                                .clear,
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .blur(radius: 8)
                    .opacity(0.7)
            }

            content
        }
        .frame(width: isExpanded ? expandedWidth : compactWidth,
               height: isExpanded ? expandedHeight : compactHeight)
        .animation(.spring(response: 0.34, dampingFraction: 0.78), value: isExpanded)
        .onHover { state.hovering = $0 }
    }

    @ViewBuilder
    private var content: some View {
        if isExpanded {
            expandedHUD
        } else {
            compactRow
        }
    }

    // MARK: - 折叠胶囊

    private var compactRow: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b))
                .frame(width: 7, height: 7)
                .shadow(color: Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b).opacity(0.9), radius: 4)

            Text(activity.title)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color(white: 0.94))
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            if let tool = activity.currentTool {
                Text(tool)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Color(white: 0.78))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.14)))
            }

            if activity.isActive, let t0 = activity.turnStartTime {
                Text(Activity.formatDuration(ms: Date().timeIntervalSince1970 * 1000 - t0))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Color(white: 0.6))
            }
        }
        .padding(.horizontal, 13)
        .frame(height: 34)
        .contentShape(Rectangle())
        .onTapGesture { state.isExpanded = true }
    }

    // MARK: - 展开 HUD

    private var expandedHUD: some View {
        VStack(spacing: 8) {
            // 头部
            HStack(spacing: 8) {
                Circle()
                    .fill(Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b))
                    .frame(width: 7, height: 7)

                Text(status.badge.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4)
                        .fill(Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b).opacity(0.18)))

                Text(activity.title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color(white: 0.65))
                    .lineLimit(1)

                Spacer()

                Button {
                    state.isExpanded = false
                } label: {
                    Text("✕")
                        .font(.system(size: 11))
                        .foregroundColor(Color(white: 0.5))
                }
                .buttonStyle(.plain)
            }
            .padding(.bottom, 7)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5)
            }

            // 详情
            Text(activity.detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Color(red: 0.65, green: 0.84, blue: 1.0))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 7)
                .padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.black.opacity(0.45)))

            Spacer(minLength: 0)

            // 底部统计
            HStack {
                statItem("耗时", elapsedText)
                statItem("工具调用", activity.toolCountText)
                if activity.isWaitingApproval {
                    statItem("待确认", "是")
                }
                Spacer()
                Text("DSH Notch")
                    .font(.system(size: 9))
                    .foregroundColor(Color(white: 0.36))
            }
            .padding(.top, 7)
            .overlay(alignment: .top) {
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: expandedWidth, height: expandedHeight, alignment: .top)
    }

    private var elapsedText: String {
        guard let t0 = activity.turnStartTime else { return "00:00" }
        return Activity.formatDuration(ms: Date().timeIntervalSince1970 * 1000 - t0)
    }

    private func statItem(_ label: String, _ value: String) -> some View {
        HStack(spacing: 3) {
            Text(label + ":")
                .font(.system(size: 10))
                .foregroundColor(Color(white: 0.4))
            Text(value)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Color(white: 0.85))
        }
    }
}
