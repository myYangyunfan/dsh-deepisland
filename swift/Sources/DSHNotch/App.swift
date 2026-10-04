import AppKit
import SwiftUI

/// 应用入口。
///
/// 用 `NSApplicationMain` 风格手动驱动而非 `App` 协议：`App` 的 Settings-only
/// 场景在没有主窗口时无法保持常驻，而菜单栏 App 恰恰不需要任何窗口。
///
/// 常驻策略（对应「只在 DSH 有活动时显示」）：
/// - App 本身常驻菜单栏（Info.plist 里 LSUIElement = true，无 Dock 图标）
/// - 轮询会话文件；**仅当 DSH 处于活跃态时**才在刘海显示胶囊
/// - DSH 关闭 / 无活动 → 刘海收起，菜单栏图标变灰
///
/// 额外命令：`DSHNotch --render-preview <目录>` 离屏渲染形状预览后退出（自检用）。
@main
enum DSHNotchMain {
    static func main() {
        // 自检模式：离屏渲染 → 出图 → 退出，不启动 UI
        if let idx = CommandLine.arguments.firstIndex(of: "--render-preview"),
           idx + 1 < CommandLine.arguments.count {
            _ = NSApplication.shared
            let dir = CommandLine.arguments[idx + 1]
            let metrics = NotchMetrics.current()
            print("[dsh-notch] \(metrics.describe)")
            PreviewRenderer.render(to: dir, metrics: metrics)
            return
        }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // .accessory：不进 Dock、不抢焦点，但可正常接收事件
        app.setActivationPolicy(.accessory)
        app.run()
        // 保活 delegate
        withExtendedLifetime(delegate) {}
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NotchPanel?
    private var timer: Timer?
    private let source = SessionSource()
    private var cursor = ActivityCursor()
    private let state = NotchViewState()
    private let metrics = NotchMetrics.current()
    private var isVisible = false
    private var pinItem: NSMenuItem?
    private var idleItem: NSMenuItem?

    /// 轮询间隔（秒）。与插件端的 250ms 一致。
    private let pollInterval: TimeInterval = 0.25
    /// 空闲多久后收起刘海（秒）
    private let idleHideDelay: TimeInterval = 3.0
    private var lastActiveAt: Date?
    private var didLogFirstTick = false

    /// DSH 是否在运行 —— 常驻策略的唯一依据
    private var dshRunning = false
    /// 空闲时自动收起（默认关：要的就是「DSH 开着就常驻」）
    private var hideWhenIdle: Bool {
        get { UserDefaults.standard.bool(forKey: "hideWhenIdle") }
        set { UserDefaults.standard.set(newValue, forKey: "hideWhenIdle") }
    }
    private static let dshBundleID = "com.deepseek.dsh"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("[dsh-notch] 屏幕度量: \(metrics.describe)")
        NSLog("[dsh-notch] 硬件刘海: \(metrics.hasNotch ? "有" : "无（退化为悬浮模式）")")
        dshRunning = Self.isDSHRunning()
        lastActiveAt = Date()   // 启动给一段宽限期，避免「空闲收起」立刻生效
        let panel = NotchPanel(metrics: metrics)
        panel.installContent(NotchContentView(metrics: metrics, state: state))
        self.panel = panel
        NSLog("[dsh-notch] zstd 工具: \(SessionSource.zstdToolPath ?? "未找到（将无法读取会话）")")
        NSLog("[dsh-notch] 最新会话: \(source.latestSessionFile()?.lastPathComponent ?? "无")")
        NSLog("[dsh-notch] DSH 运行中: \(dshRunning)")

        let wc = NSWorkspace.shared.notificationCenter
        wc.addObserver(self, selector: #selector(dshAppChanged),
                       name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        wc.addObserver(self, selector: #selector(dshAppChanged),
                       name: NSWorkspace.didTerminateApplicationNotification, object: nil)

        installStatusItem()
        startPolling()
        // accessory 策略下需显式激活，NSPanel 才会显示
        NSApp.activate(ignoringOtherApps: false)

        // 诊断：延迟自查窗口几何（窗口注册是异步的，立刻查查不到）
        if ProcessInfo.processInfo.environment["DSH_NOTCH_VERBOSE"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                self?.panel?.dumpSelf()
            }
        }
    }

    static func isDSHRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == dshBundleID }
    }

    @objc private func dshAppChanged() {
        let now = Self.isDSHRunning()
        if now != dshRunning {
            dshRunning = now
            NSLog("[dsh-notch] DSH \(now ? "已启动" : "已退出") → 灵动岛\(now ? "常驻" : "收起")")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    // MARK: - 菜单栏

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
            btn.image = NSImage(systemSymbolName: "waveform.path.ecg", accessibilityDescription: "DSH Notch")
            btn.image?.isTemplate = true
        }
        let menu = NSMenu()
        let info = NSMenuItem(title: String(format: "刘海 %.0f×%.0f pt · 屏幕 %.0f×%.0f",
                                            metrics.notchWidth, metrics.notchHeight,
                                            metrics.screenFrame.width, metrics.screenFrame.height),
                              action: nil, keyEquivalent: "")
        info.isEnabled = false
        menu.addItem(info)
        menu.addItem(.separator())

        let toggle = NSMenuItem(title: state.pinned ? "取消钉住展开 HUD" : "钉住展开 HUD",
                                action: #selector(toggleExpanded), keyEquivalent: "")
        toggle.target = self
        pinItem = toggle
        menu.addItem(toggle)

        let idleItem = NSMenuItem(title: "空闲时自动收起",
                                  action: #selector(toggleHideWhenIdle), keyEquivalent: "")
        idleItem.target = self
        idleItem.state = hideWhenIdle ? .on : .off
        self.idleItem = idleItem
        menu.addItem(idleItem)

        let reveal = NSMenuItem(title: "在 Finder 中显示会话文件", action: #selector(revealSession), keyEquivalent: "")
        reveal.target = self
        menu.addItem(reveal)

        let preview = NSMenuItem(title: "导出形状预览图…", action: #selector(exportPreview), keyEquivalent: "")
        preview.target = self
        menu.addItem(preview)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
    }

    @objc private func toggleExpanded() {
        state.pinned.toggle()
        pinItem?.title = state.pinned ? "取消钉住展开 HUD" : "钉住展开 HUD"
        applyExpansion()
        refresh(force: true)
    }

    @objc private func toggleHideWhenIdle() {
        hideWhenIdle.toggle()
        idleItem?.state = hideWhenIdle ? .on : .off
        tick()
    }

    private func applyExpansion() {
        // 等待人工确认时自动展开；其余时候由「钉住」决定
        let shouldExpand = state.pinned || state.activity.isWaitingApproval
        if state.isExpanded != shouldExpand { state.isExpanded = shouldExpand }
    }

    @objc private func revealSession() {
        guard let f = source.latestSessionFile() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([f])
    }

    @objc private func exportPreview() {
        let dir = NSTemporaryDirectory() + "dsh-notch-preview"
        PreviewRenderer.render(to: dir, metrics: metrics)
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    // MARK: - 轮询

    private func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
    }

    private func tick() {
        let events = source.loadEvents()
        let now = Date().timeIntervalSince1970 * 1000
        let activity = cursor.apply(events, now: now)

        // 状态驱动：只在真正变化时写入 @Published，避免打断动画
        state.now = now
        if state.activity != activity { state.activity = activity }

        if activity.isActive {
            lastActiveAt = Date()
        }

        // 首帧打一条诊断：确认数据通路真的通了（读到了多少事件、推出了什么状态）
        if !didLogFirstTick {
            didLogFirstTick = true
            NSLog("[dsh-notch] 首帧: 事件 \(events.count) 条, seq 游标 \(cursor.lastSeq), 状态 \(activity.status.rawValue), 「\(activity.title)」")
        }

        applyExpansion()

        // 常驻策略：DSH 运行中 → 常驻；DSH 退出 → 收起
        // （可选用「空闲时自动收起」把常驻改成只在干活时出现）
        let shouldShow: Bool
        if !dshRunning {
            shouldShow = false
        } else if hideWhenIdle {
            shouldShow = activity.isActive
                || (lastActiveAt.map { Date().timeIntervalSince($0) <= idleHideDelay } ?? false)
        } else {
            shouldShow = true
        }

        if shouldShow { presentIfNeeded() } else { hideIfNeeded() }
    }

    private func presentIfNeeded() {
        guard !isVisible else { return }
        isVisible = true
        panel?.present()
    }

    private func hideIfNeeded() {
        guard isVisible else { return }
        isVisible = false
        panel?.hideNotch()
    }

    /// 手动触发一次刷新（设置变更后调用）。
    private func refresh(force: Bool) {
        if force { cursor.reset() }
        tick()
    }
}
