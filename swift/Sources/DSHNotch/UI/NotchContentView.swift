import SwiftUI

/// 灵动岛的可观察状态。
///
/// 视图树**只创建一次**，之后靠这里的 @Published 驱动刷新——
/// 早期实现每 250ms 重建一次 NSHostingView，展开动画刚起步就被打断，
/// 而且每次重建都会丢掉 SwiftUI 的过渡状态。
final class NotchViewState: ObservableObject {
    /// 当前活动快照（= 主会话，折叠态与单会话展开态直接用这个）
    @Published var activity: Activity = .idle

    /// 全部被监控的会话（按关注度排序，第一个是主会话）。
    ///
    /// DSH 可以同时开多个对话，只显示一个等于丢信息。视图按 `count > 1`
    /// 在「单会话丰富布局」与「多会话列表布局」之间切换。
    @Published var sessions: [SessionEntry] = []

    /// 当前是否渲染为展开 HUD（= 用户钉住 或 正在等待确认）
    @Published var isExpanded = false
    /// 用户手动钉住展开态
    @Published var pinned = false
    /// 当前时间（毫秒），每 tick 更新，让耗时分秒能自己走字
    @Published var now: Double = Date().timeIntervalSince1970 * 1000

    /// 跳转后留在岛上的一行反馈（如「已复制标题 · ⌘K 粘贴」），由 App 层定时清空
    @Published var jumpFeedback: String?

    /// 点击某个对话时的回调 —— App 层负责置前 DSH 与写剪贴板。
    ///
    /// 视图只报「点到了哪个会话」，不做跳转本身：置前别的应用、覆盖剪贴板
    /// 都是有副作用的动作，得留在 App 层统一记账。
    var onOpenSession: ((SessionEntry) -> Void)?

    /// 主会话 id（列表排序第一个的那个；无会话时为 nil）
    var primaryId: String? { sessions.first?.id }
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

    /// 当前应渲染的形状尺寸。展开态高度**随会话数变化**（多会话要列出来）。
    private var islandSize: CGSize {
        metrics.islandSize(expanded: state.isExpanded, sessionRows: state.sessions.count)
    }

    /// 刘海下方信息带的高度
    private var contentHeight: CGFloat { islandSize.height - metrics.contentTopInset }

    private var islandWidth: CGFloat { islandSize.width }

    /// 是否渲染为多会话列表布局
    private var isMultiSession: Bool { state.sessions.count > 1 }

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
    /// 青光淹没，文字对比度崩掉、剪影也糊了。改成固定高度：
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

    /// 折叠态空间只有 208pt，必须精打细算：只放「在干什么」+ 耗时，
    /// 外加**最多一个仪表**（上下文告警优先，其次待办进度）。
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
                .minimumScaleFactor(0.85)
                .layoutPriority(1)

            Spacer(minLength: 2)

            // 多会话时这个位置让给「会话数」徽标 —— 208pt 宽放不下「工具名 + 会话数」
            // 两样，而「还有几个对话在跑」是折叠态里别处看不到的信息
            //（当前在干什么已经由左边的主会话标题表达了）。
            if isMultiSession {
                badge(icon: "rectangle.stack.fill",
                      text: liveCountText,
                      tint: hasWaitingSession
                          ? Color(red: 1.0, green: 0.67, blue: 0.0)
                          : Color(white: 0.72))
            } else if activity.pendingAgents > 0 {
                badge(icon: "person.2.fill",
                      text: "\(activity.pendingAgents)",
                      tint: Color(red: 0.65, green: 0.78, blue: 1.0))
            } else if let tool = activity.currentTool {
                Text(tool)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(Color(white: 0.8))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(Color.white.opacity(0.14)))
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }

            // 仪表位（上下文告警 / 待办进度）：**只在单会话时**出现。
            // 多会话时这个位置已经给了会话数徽标，208pt 装不下四样东西，
            // 硬塞会把标题挤到只剩「等待人工…」这种读不出信息的程度。
            if !isMultiSession {
                if activity.contextLevel > 0, let ctx = activity.contextText {
                    Text(ctx)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundColor(contextColor)
                        .fixedSize()
                } else if let todo = activity.todoText {
                    badge(icon: "checklist",
                          text: todo,
                          tint: Color(white: 0.62))
                }
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

    /// 折叠态会话数徽标：`2/3`（2 个在跑 / 共 3 个监控）；都没在跑就只给总数
    private var liveCountText: String {
        let live = state.sessions.filter { $0.isLive }.count
        let total = state.sessions.count
        return live > 0 ? "\(live)/\(total)" : "\(total)"
    }

    /// 是否任一会话在等人工确认（折叠态徽标转橙，且 App 层会强制展开）
    private var hasWaitingSession: Bool {
        state.sessions.contains { $0.activity.isWaitingApproval }
    }

    /// 状态 → 颜色。每个会话行用**自己**状态的颜色，而不是主会话的。
    private func color(for status: ActivityStatus) -> Color {
        Color(red: status.glowRGB.r, green: status.glowRGB.g, blue: status.glowRGB.b)
    }

    private func badge(icon: String, text: String, tint: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 8.5))
            Text(text).font(.system(size: 9.5, design: .monospaced))
        }
        .foregroundColor(tint)
        .padding(.horizontal, 5)
        .padding(.vertical, 1.5)
        .background(Capsule().fill(Color.white.opacity(0.10)))
        .fixedSize(horizontal: true, vertical: false)
    }

    /// 上下文占用色：常规灰白，过半转琥珀，超 80% 转红
    private var contextColor: Color {
        switch activity.contextLevel {
        case 2: return Color(red: 0.89, green: 0.29, blue: 0.29)
        case 1: return Color(red: 0.94, green: 0.62, blue: 0.15)
        default: return Color(white: 0.7)
        }
    }

    // MARK: - 展开 HUD

    private var expandedHUD: some View {
        Group {
            if isMultiSession { multiSessionHUD } else { singleSessionHUD }
        }
    }

    /// 单会话：保留原来的丰富布局（详情正文块 + 待办行 + 统计 + 模型行）
    private var singleSessionHUD: some View {
        VStack(spacing: 6) {
            headerRow

            Text(activity.detail)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Color(red: 0.65, green: 0.84, blue: 1.0))
                .lineLimit(activity.proj.hasTodo ? 2 : 3)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.07)))
                // 单会话时，这块正文就是「这个对话」的代表 —— 点它即跳转
                .contentShape(Rectangle())
                .onTapGesture { openPrimarySession() }

            todoRow

            Spacer(minLength: 0)

            statsRow
            metaRow
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - 多会话展开布局

    /// 多会话：一屏列出**每个对话**的状态，一行一个。
    ///
    /// 取舍：多会话时砍掉单会话那套「工具参数正文块 + 待办行」——
    /// 详情只属于某一个会话，铺在全局位置会让人误以为是共同的；
    /// 而「每行一个对话，各自什么状态」才是多会话时真正要看的东西。
    /// 主会话（排序第一）那行加底色高亮，统计行也显示它的指标。
    private var multiSessionHUD: some View {
        VStack(spacing: 6) {
            multiHeader

            VStack(spacing: NotchMetrics.sessionRowGap) {
                ForEach(state.sessions.prefix(NotchMetrics.maxSessionRows)) { s in
                    sessionRow(s)
                }
            }

            Spacer(minLength: 0)

            statsRow
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// 多会话首行：主会话状态角标 + 会话数 + 交互提示
    private var multiHeader: some View {
        HStack(spacing: 7) {
            Circle().fill(glow).frame(width: 6, height: 6)

            Text(status.badge.uppercased())
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundColor(glow)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).fill(glow.opacity(0.18)))
                .fixedSize()

            Text("\(state.sessions.count) 个会话")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color(white: 0.66))
                .lineLimit(1)

            Spacer(minLength: 4)

            hintArea
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).offset(y: 3)
        }
    }

    /// header 右侧的提示 / 反馈区。
    ///
    /// 优先级：**跳转反馈 > 钉住状态 > 默认用法提示**。
    /// 用户刚点完一个对话，最想知道的是「跳没跳成、下一步做什么」，
    /// 这时候再显示「已钉住」属于答非所问。
    @ViewBuilder
    private var hintArea: some View {
        if let fb = state.jumpFeedback {
            Label(fb, systemImage: "arrow.up.forward.app")
                .font(.system(size: 9.5))
                .foregroundColor(Color(red: 0.55, green: 0.92, blue: 0.72))
                .fixedSize()
        } else if state.pinned {
            Label("已钉住 · 点状态行取消", systemImage: "pin.fill")
                .font(.system(size: 9.5))
                .foregroundColor(glow.opacity(0.9))
                .fixedSize()
        } else {
            Text("点对话跳转 · 点状态行钉住")
                .font(.system(size: 9.5))
                .foregroundColor(Color(white: 0.34))
                .fixedSize()
        }
    }

    /// 列表里的一行会话：状态点 / 名字 / 当前动作 / 短标签 / 耗时
    private func sessionRow(_ s: SessionEntry) -> some View {
        let c = color(for: s.activity.status)
        let isPrimary = s.id == state.primaryId
        return HStack(spacing: 7) {
            Circle()
                .fill(c)
                .frame(width: 6, height: 6)
                .shadow(color: s.isLive ? c.opacity(0.9) : .clear, radius: 4)

            // 定宽，让右侧的标签/耗时在多个会话行之间对齐
            Text(s.label)
                .font(.system(size: 10.5, weight: isPrimary ? .semibold : .regular))
                .foregroundColor(Color(white: s.isLive ? 0.93 : 0.5))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 96, alignment: .leading)

            Text(s.activity.title)
                .font(.system(size: 10))
                .foregroundColor(Color(white: s.isLive ? 0.7 : 0.42))
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            Text(s.shortTag)
                .font(.system(size: 9, design: .monospaced))
                .foregroundColor(Color(white: s.isLive ? 0.85 : 0.5))
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(Capsule().fill(Color.white.opacity(s.isLive ? 0.12 : 0.06)))
                .fixedSize()

            Text(rowElapsed(s))
                .font(.system(size: 9.5, design: .monospaced))
                .foregroundColor(Color(white: 0.55))
                .fixedSize()
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(RoundedRectangle(cornerRadius: 5)
            .fill(Color.white.opacity(isPrimary ? 0.09 : 0.0)))
        // 点这一行 = 跳到那个对话（置前 DSH + 标题进剪贴板）
        .contentShape(Rectangle())
        .onTapGesture { state.onOpenSession?(s) }
    }

    /// 行内耗时。只在会话**活跃**时显示 —— 待命会话的 `turnStartTime` 是上一回合的
    /// 起点，照着算会得出「已经跑了 3 小时」这种莫名的数字，比留空更容易误读。
    private func rowElapsed(_ s: SessionEntry) -> String {
        guard s.isLive, let t0 = s.activity.turnStartTime else { return "--:--" }
        return Activity.formatDuration(ms: state.now - t0)
    }

    /// 单会话布局没有「行」可以点，跳转目标就是唯一的那个会话（排序第一 = 主会话）
    private func openPrimarySession() {
        guard let s = state.sessions.first else { return }
        state.onOpenSession?(s)
    }

    /// 首行：状态角标 + 标题 + 轮次 + 交互提示
    private var headerRow: some View {
        HStack(spacing: 7) {
            Circle().fill(glow).frame(width: 6, height: 6)

            Text(status.badge.uppercased())
                .font(.system(size: 9.5, weight: .semibold))
                .foregroundColor(glow)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).fill(glow.opacity(0.18)))
                .fixedSize()

            Text(activity.title)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color(white: 0.66))
                .lineLimit(1)

            Spacer(minLength: 4)

            if let ts = activity.turnStepText {
                Text(ts)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundColor(Color(white: 0.52))
                    .fixedSize()
            }

            hintArea
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).offset(y: 3)
        }
    }

    /// 待办行：只在有 todo 时出现，显示当前项 + 进度
    @ViewBuilder
    private var todoRow: some View {
        if activity.proj.hasTodo {
            HStack(spacing: 6) {
                Image(systemName: "checklist")
                    .font(.system(size: 9))
                    .foregroundColor(Color(white: 0.45))
                if let cur = activity.proj.todoCurrent {
                    Text(cur)
                        .font(.system(size: 10.5))
                        .foregroundColor(Color(white: 0.7))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                Text(activity.todoText ?? "")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Color(white: 0.85))
                    .fixedSize()
            }
        }
    }

    /// 统计行：耗时 / 工具调用 / 输出 token / 上下文占用 / 在飞调用
    private var statsRow: some View {
        HStack(spacing: 10) {
            statItem("耗时", elapsedText)
            statItem("工具", activity.toolCountText)

            if let out = activity.proj.outputTokens {
                statItem("输出", Projections.shortTokens(out) + " tok")
            }
            if let ctx = activity.contextText {
                HStack(spacing: 3) {
                    Text("上下文:").font(.system(size: 10)).foregroundColor(Color(white: 0.4))
                    Text(ctx)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(contextColor)
                }
                .fixedSize()
            }
            if activity.pendingAgents > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "person.2.fill").font(.system(size: 8.5))
                    Text("\(activity.pendingAgents)")
                        .font(.system(size: 10, design: .monospaced))
                }
                .foregroundColor(Color(red: 0.65, green: 0.78, blue: 1.0))
                .fixedSize()
            } else if activity.pendingTools > 0 {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 8.5))
                    Text("\(activity.pendingTools)")
                        .font(.system(size: 10, design: .monospaced))
                }
                .foregroundColor(Color(white: 0.6))
                .fixedSize()
            }

            Spacer(minLength: 2)
        }
        .overlay(alignment: .top) {
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5).offset(y: -3)
        }
    }

    /// 末行：模型 / 权限，右侧署名
    private var metaRow: some View {
        HStack(spacing: 6) {
            if let model = activity.proj.modelName {
                Text(model)
                    .font(.system(size: 9))
                    .foregroundColor(Color(white: 0.42))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let perm = activity.proj.permissionPreset {
                Text(perm)
                    .font(.system(size: 9))
                    .foregroundColor(Color(white: 0.30))
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 4)
            Text("DSH Notch")
                .font(.system(size: 9))
                .foregroundColor(Color(white: 0.28))
                .fixedSize()
        }
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
        .fixedSize()
    }
}
