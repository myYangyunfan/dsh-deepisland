import AppKit
import SwiftUI

/// 贴在物理刘海上的浮动面板。
///
/// 关键属性（缺一不可，否则会读作「悬浮黑盒子」而非系统的一部分）：
/// - `level = .statusBar`：浮在普通应用窗口之上
/// - `ignoresMouseEvents`：鼠标穿透，不抢用户正在做的事
/// - `collectionBehavior`：跨桌面 / 全屏都常驻
/// - `hidesOnDeactivate = false`：默认 NSPanel 在应用失焦时会隐藏，而灵动岛必须常驻
///
/// ## 定位：窗口顶端 = 屏幕顶端
///
/// 窗口尺寸按**展开态**取最大（这样展开时不需要改窗口大小，动画不会被裁），
/// 内容视图用 `bleed` 左右/底部留白包住，并**顶对齐**钉在窗口顶部。
/// 于是形状的顶边精确落在屏幕顶边，两个方角隐没在屏幕边界上。
///
/// ## 交互：穿透为常态，悬停时临时接管
///
/// `ignoresMouseEvents = true` 的代价是窗口**收不到任何鼠标事件**，
/// 所以悬停检测不能走 `mouseEntered`（永远不触发），只能由 App 层轮询
/// `NSEvent.mouseLocation` 判定，再调 `isInteractive` 临时打开交互。
final class NotchPanel: NSPanel {
    private let metrics: NotchMetrics
    /// 内容容器（窗口比内容大，用于容纳光晕外溢）
    private let container = NSView(frame: .zero)
    private let verbose = ProcessInfo.processInfo.environment["DSH_NOTCH_VERBOSE"] != nil

    init(metrics: NotchMetrics) {
        self.metrics = metrics
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        ignoresMouseEvents = true

        container.wantsLayer = true
        container.layer?.backgroundColor = .clear
        contentView = container
        setFrame(NSRect(origin: metrics.windowOrigin, size: metrics.windowSize),
                 display: false)
        container.frame = NSRect(origin: .zero, size: metrics.windowSize)
    }

    /// 屏幕是否有硬件刘海
    var screenHasNotch: Bool { metrics.hasNotch }

    /// 是否接收鼠标事件（默认穿透）。
    ///
    /// 只有鼠标悬停到岛上时才临时打开，让 HUD 里的按钮可以点；
    /// 一旦移开立刻恢复穿透 —— 否则窗口矩形（480×180，比岛体大一圈）
    /// 会长期吞掉其下方应用的点击。
    var isInteractive: Bool {
        get { !ignoresMouseEvents }
        set {
            guard ignoresMouseEvents == newValue else { return }
            ignoresMouseEvents = !newValue
            if verbose {
                NSLog("[dsh-notch] 鼠标交互: \(newValue ? "开（悬停中，可点击）" : "关（穿透）")")
            }
        }
    }

    /// **必须覆盖**：默认实现会把窗口约束在 `screen.visibleFrame` 内
    /// （即排除菜单栏/刘海那 28pt 带状区域），于是 `setFrame` 之后
    /// 窗口被往下挤、位置完全不对 —— 本机实测请求 (400, 652, 480, 180)
    /// 被约束成 (424, 41, 432, 163)（CGWindow 坐标），顶边离屏顶 41pt。
    /// 灵动岛要的正是压在菜单栏/刘海上，所以原样返回。
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    /// 安装内容视图（宿主尺寸 = 窗口尺寸，内容自己在内部顶端居中）。
    ///
    /// 只建立一次 —— 视图树由 `NotchViewState` 驱动刷新；
    /// 反复重建 NSHostingView 会打断 SwiftUI 的展开动画。
    func installContent<V: View>(_ content: V) {
        let hosting = NSHostingView(rootView: content)
        hosting.frame = NSRect(origin: .zero, size: metrics.windowSize)
        hosting.autoresizingMask = []
        container.subviews.forEach { $0.removeFromSuperview() }
        container.addSubview(hosting)
    }

    /// 显示面板（每次显示都重新校准位置：屏幕分辨率/排列可能变化）。
    func present() {
        let want = NSRect(origin: metrics.windowOrigin, size: metrics.windowSize)
        setFrame(want, display: false)
        if want != frame {
            NSLog("[dsh-notch] 窗口定位: 期望 \(want) 实际 \(frame)")
        }
        alphaValue = 1
        orderFront(nil)
    }

    /// 自证：把本进程自己的窗口几何打出来。
    ///
    /// 外部工具（无屏幕录制权限）看到的其他应用窗口信息可能被系统裁掉/改写，
    /// 只有自报数据可信。注意必须**延迟**调用：`orderFront` 之后窗口注册到
    /// 窗口服务器是异步的，立刻查询会一条都查不到。
    func dumpSelf() {
        let pid = Int(ProcessInfo.processInfo.processIdentifier)
        NSLog("[dsh-notch] NSWindow.frame(AppKit 左下原点) = \(frame) | screen.frame = \(String(describing: screen?.frame))")
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                    kCGNullWindowID) as? [[String: Any]] else { return }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? Int) == pid else { continue }
            let b = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            NSLog(String(format: "[dsh-notch] 自身窗口 layer=%@ bounds(CG, 左上原点) x=%.1f y=%.1f w=%.1f h=%.1f",
                         "\(w[kCGWindowLayer as String] ?? "?")",
                         b["X"] ?? -1, b["Y"] ?? -1, b["Width"] ?? -1, b["Height"] ?? -1))
        }
    }

    /// 收起（淡出后 orderOut）。
    func hideNotch() {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.22
            animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.orderOut(nil)
            self?.alphaValue = 1
        }
    }

    /// 立即隐藏（无动画），供降级场景使用。
    func hideImmediately() {
        orderOut(nil)
    }

    /// 诊断：确认点击真的落到了本窗口上。
    ///
    /// 面板平时 `ignoresMouseEvents = true`（穿透），只有指针在岛上时
    /// `isInteractive` 打开，此时点击才会到这里。事件先给 NSHostingView，
    /// SwiftUI 没处理才会沿响应链冒到这里来。
    override func mouseDown(with event: NSEvent) {
        if verbose {
            NSLog("[dsh-notch] 面板收到点击: \(event.locationInWindow)")
        }
        super.mouseDown(with: event)
    }
}
