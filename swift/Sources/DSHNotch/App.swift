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
@main
enum DSHNotchMain {
    static func main() {
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
    private var lastShown: Activity?
    private let state = NotchViewState()
    private var notched = false

    /// 轮询间隔（秒）。与插件端的 250ms 一致。
    private let pollInterval: TimeInterval = 0.25
    /// 空闲多久后收起刘海（秒）
    private let idleHideDelay: TimeInterval = 3.0
    private var lastActiveAt: Date?
    private var didLogFirstTick = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        notched = NotchPanel.screenHasNotch
        panel = NotchPanel()
        if !notched {
            NSLog("[dsh-notch] 当前屏幕无刘海，改为屏幕底部悬浮药丸模式")
        }
        NSLog("[dsh-notch] zstd 工具: \(SessionSource.zstdToolPath ?? "未找到（将无法读取会话）")")
        NSLog("[dsh-notch] 最新会话: \(source.latestSessionFile()?.lastPathComponent ?? "无")")
        installStatusItem()
        startPolling()
        // accessory 策略下需显式激活，NSPanel 才会显示
        NSApp.activate(ignoringOtherApps: false)
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
        menu.addItem(withTitle: "刘海屏有硬件缺口", action: nil, keyEquivalent: "").isEnabled = false
        menu.addItem(.separator())
        let toggle = NSMenuItem(title: "展开/收起 HUD", action: #selector(toggleExpanded), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        let reveal = NSMenuItem(title: "在 Finder 中显示会话文件", action: #selector(revealSession), keyEquivalent: "")
        reveal.target = self
        menu.addItem(reveal)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
    }

    @objc private func toggleExpanded() {
        state.isExpanded.toggle()
        refresh(force: true)
    }

    @objc private func revealSession() {
        guard let f = source.latestSessionFile() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([f])
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
        let activity = cursor.apply(events, now: Date().timeIntervalSince1970 * 1000)

        if activity.isActive {
            lastActiveAt = Date()
        }

        // 首帧打一条诊断：确认数据通路真的通了（读到了多少事件、推出了什么状态）
        if !didLogFirstTick {
            didLogFirstTick = true
            NSLog("[dsh-notch] 首帧: 事件 \(events.count) 条, seq 游标 \(cursor.lastSeq), 状态 \(activity.status.rawValue), 「\(activity.title)」")
        }

        // 活跃 → 显示；空闲超过延迟 → 收起
        if activity.isActive {
            show(activity)
        } else if let last = lastActiveAt, Date().timeIntervalSince(last) > idleHideDelay {
            hideNotch()
        } else if lastShown == nil && !state.isExpanded {
            // 首帧还没到活动期，短暂展示「待命」以确认通路正常
            show(activity)
        }
    }

    private func show(_ activity: Activity) {
        let changed = lastShown != activity
        lastShown = activity
        guard let panel else { return }
        // 用 MainActor 隔离 UI 更新
        let st = state
        DispatchQueue.main.async {
            panel.showNotch(NotchContentView(activity: activity, state: st))
        }
        if changed { panel.alphaValue = 1 }
    }

    private func hideNotch() {
        guard lastShown != nil else { return }
        lastShown = nil
        panel?.hideNotch()
    }

    /// 手动触发一次刷新（设置变更后调用）。
    private func refresh(force: Bool) {
        if force { cursor.reset() }
        tick()
    }
}
