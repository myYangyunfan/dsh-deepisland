import AppKit

/// 点击自检探针：把指针挪到指定位置后合成一次左键点击，
/// 用来验证「鼠标在岛上时点击会被面板接收」这条链路。
///
/// 用法：
///     probe-click --notch      # 点刘海那块
///     probe-click --corner     # 点左下角（对照组：不该被面板接收）
///     probe-click <x> <y>
///
/// 注意：合成事件投到 `.cghidEventTap` 时，若系统未授予辅助功能权限，
/// macOS 可能静默丢弃 —— 此时本探针会打印结果但宿主端不会收到点击。
@main
enum ProbeClick {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let s = NotchMetrics.targetScreen() ?? NSScreen.main else {
            print("无屏幕"); exit(1)
        }

        var point: CGPoint
        switch args.first ?? "" {
        case "--notch":
            point = CGPoint(x: s.frame.midX, y: s.frame.maxY - s.safeAreaInsets.top + 12)
        case "--corner":
            point = CGPoint(x: s.frame.minX + 60, y: s.frame.minY + 60)
        default:
            guard args.count >= 2, let x = Double(args[0]), let y = Double(args[1]) else {
                print("用法: probe-click --notch | --corner | <x> <y>"); exit(2)
            }
            point = CGPoint(x: x, y: y)
        }

        let cg = CGPoint(x: point.x, y: s.frame.maxY - point.y)
        print("AXIsProcessTrusted = \(AXIsProcessTrusted()) （合成事件投 HID tap 需此权限）")
        CGWarpMouseCursorPosition(cg)
        CGAssociateMouseAndMouseCursorPosition(1)
        // 先停留一会儿：宿主靠轮询判定悬停，判定完成后才会打开交互
        Thread.sleep(forTimeInterval: 0.4)

        let src = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                           mouseCursorPosition: cg, mouseButton: .left)
        let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                         mouseCursorPosition: cg, mouseButton: .left)

        // --pid <pid>：直接投递给目标进程（绕开 HID tap 的权限门槛，用于区分
        // 「系统丢了事件」和「面板根本收不到点击」两种情况）
        if let i = args.firstIndex(of: "--pid"), i + 1 < args.count, let pid = Int32(args[i + 1]) {
            down?.postToPid(pid)
            Thread.sleep(forTimeInterval: 0.06)
            up?.postToPid(pid)
            print(String(format: "已直接投递左键点击给 pid %d @ CG(%.0f, %.0f)", pid, cg.x, cg.y))
            Thread.sleep(forTimeInterval: 0.4)
            return
        }

        down?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.06)
        up?.post(tap: .cghidEventTap)
        print(String(format: "已合成左键点击 @ CG(%.0f, %.0f)", cg.x, cg.y))
        Thread.sleep(forTimeInterval: 0.4)
    }
}
