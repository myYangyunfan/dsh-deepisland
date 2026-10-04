import AppKit
import SwiftUI

/// 交互自检：把合成的 `NSEvent` 直接投进窗口，验证
/// 「点击岛体 → 钉住状态翻转」这条链路（SwiftUI 手势是否真的接上了）。
///
/// 为什么不用合成 `CGEvent`：`CGEvent.post(tap:)` 需要辅助功能授权，
/// 本机 `AXIsProcessTrusted = false`，事件会被系统**静默丢弃**（已实测确认）。
/// 悬停链路不靠合成事件 —— 用 `probe-hover` 真正挪动指针做过端到端验证；
/// 这里只补 SwiftUI 手势那最后一环。
///
/// 用 `DSHNotch --self-test` 运行，退出码 0 表示通过。
final class InteractionSelfTest {
    private let metrics = NotchMetrics.current()
    private let state = NotchViewState()
    private var panel: NotchPanel?
    private var failures: [String] = []

    func run() -> Bool {
        let panel = NotchPanel(metrics: metrics)
        panel.installContent(NotchContentView(metrics: metrics, state: state))
        // 真实运行时由指针轮询打开；这里直接置位，模拟「指针已在岛上」
        panel.isInteractive = true
        panel.present()
        self.panel = panel
        pump(0.35)

        check(!state.pinned, "初始应为未钉住")
        check(state.isExpanded == false, "初始应为折叠态（无悬停/钉住/等待确认）")

        click()
        pump(0.35)
        check(state.pinned, "第一次点击 → 应钉住")
        check(state.isExpanded == false, "视图层只翻转 pinned，展开由 App 层 applyExpansion 决定")

        click()
        pump(0.35)
        check(!state.pinned, "第二次点击 → 应取消钉住")

        // 展开态下再点一次：热区随展开变化后仍应命中
        state.isExpanded = true
        pump(0.3)
        click()
        pump(0.35)
        check(state.pinned, "展开态下点击 → 仍应钉住")

        panel.hideImmediately()
        for f in failures { print("  ✗ 失败: \(f)") }
        print(failures.isEmpty
              ? "[self-test] 交互自检通过 ✅（点击 → 钉住翻转，含展开态）"
              : "[self-test] 交互自检失败 ❌（\(failures.count) 项）")
        return failures.isEmpty
    }

    private func check(_ cond: Bool, _ desc: String) {
        print("  \(cond ? "✓" : "✗") \(desc)  [pinned=\(state.pinned) expanded=\(state.isExpanded)]")
        if !cond { failures.append(desc) }
    }

    /// 在岛体正中合成一次完整的按下 + 抬起（SwiftUI 的点击手势需要成对事件）。
    private func click() {
        guard let panel else { return }
        let island = metrics.islandRect(expanded: state.isExpanded)
        let origin = metrics.windowOrigin
        let loc = CGPoint(x: island.midX - origin.x, y: island.midY - origin.y)
        let ts = ProcessInfo.processInfo.systemUptime
        for (i, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
            guard let ev = NSEvent.mouseEvent(with: type, location: loc,
                                              modifierFlags: [], timestamp: ts + Double(i) * 0.02,
                                              windowNumber: panel.windowNumber,
                                              context: nil, eventNumber: i + 1,
                                              clickCount: 1, pressure: 1) else { continue }
            panel.sendEvent(ev)
            pump(0.1)
        }
    }

    /// 让 RunLoop 跑一会儿，把 SwiftUI 的手势识别与动画推进完
    private func pump(_ seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }
}
