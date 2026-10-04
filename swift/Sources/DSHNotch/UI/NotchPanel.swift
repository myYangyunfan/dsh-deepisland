import AppKit
import SwiftUI

/// 贴在物理刘海上的浮动面板。
///
/// 三个关键属性（缺一不可，否则会读作「悬浮黑盒子」而非系统的一部分）：
/// - `level = .statusBar`：浮在普通应用窗口之上
/// - `ignoresMouseEvents`：鼠标穿透，不抢用户正在做的事
/// - `collectionBehavior`：跨桌面 / 全屏都常驻
///
/// 另外 `hidesOnDeactivate = false` 很关键——默认 NSPanel 在应用失焦时会隐藏，
/// 而灵动岛必须在你切到别的 App 时依然可见。
final class NotchPanel: NSPanel {
    /// 内容尺寸（不含阴影留白）
    var contentSize = NSSize(width: 250, height: 34)
    /// 阴影/光晕留白
    private let shadowPadding: CGFloat = 22

    init() {
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
        // 关键：切到其他 App 时不隐藏
        hidesOnDeactivate = false
        // 关键：浮在普通窗口之上（.statusBar 档位，恰好在菜单栏所在层级）
        level = .statusBar
        // 关键：跨所有桌面、全屏辅助、忽略窗口循环
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        // 默认鼠标穿透；展开时按需关闭
        ignoresMouseEvents = true
    }

    /// 覆盖整个刘海区域所需的总尺寸。
    private var totalSize: NSSize {
        NSSize(width: contentSize.width + shadowPadding * 2,
               height: contentSize.height + shadowPadding)
    }

    /// 主屏是否有硬件刘海。
    static var screenHasNotch: Bool {
        // 优先主屏，否则找第一个有刘海的屏
        for screen in ([NSScreen.main] + NSScreen.screens).compactMap({ $0 }) {
            if screen.safeAreaInsets.top > 0 { return true }
        }
        return false
    }

    /// 目标屏幕：有刘海的用之，否则退回主屏。
    static var targetScreen: NSScreen? {
        if let m = NSScreen.main, m.safeAreaInsets.top > 0 { return m }
        return NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main
    }

    /// 显示内容（SwiftUI）。
    func showNotch<V: View>(_ content: V) {
        let hosting = NSHostingView(rootView: content
            .frame(width: contentSize.width, height: contentSize.height)
        )
        contentView = hosting

        guard let screen = Self.targetScreen else { return }
        let total = totalSize
        // 必须用 screen.frame（而非 visibleFrame）——后者会排除刘海/菜单栏区域
        let x = screen.frame.origin.x + (screen.frame.width - total.width) / 2
        let y = screen.frame.origin.y + screen.frame.height - total.height
        setFrame(CGRect(x: x, y: y, width: total.width, height: total.height), display: false)

        orderFront(nil)
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

    /// 立即隐藏（无动画），供无刘海屏降级时使用。
    func hideImmediately() {
        orderOut(nil)
    }
}
