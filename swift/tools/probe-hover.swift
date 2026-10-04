import AppKit

/// 悬停自检探针：把鼠标指针瞬移到指定位置（AppKit 屏幕坐标，左下原点），
/// 用来在无人操作的情况下验证「鼠标移到刘海上会展开」这条链路。
///
/// 用法：
///     probe-hover <x> <y> [停留毫秒]
///     probe-hover --notch        # 直接放到刘海正中
///     probe-hover --corner       # 挪去左下角（离开热区）
///
/// 注意 `CGWarpMouseCursorPosition` 用的是**左上原点**的全局坐标，
/// 而 AppKit 是左下原点，这里做一次翻转，避免差一个屏幕高度。
@main
enum ProbeHover {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard !args.isEmpty else {
            print("用法: probe-hover <x> <y> | --notch | --corner")
            exit(2)
        }

        let screen = NotchMetrics.targetScreen() ?? NSScreen.main
        guard let s = screen else { print("无屏幕"); exit(1) }

        var target: CGPoint
        switch args[0] {
        case "--notch":
            // 刘海下方一点点（避开物理挖孔，落在信息带上）
            target = CGPoint(x: s.frame.midX, y: s.frame.maxY - s.safeAreaInsets.top + 12)
        case "--corner":
            target = CGPoint(x: s.frame.minX + 60, y: s.frame.minY + 60)
        default:
            guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else {
                print("参数不对"); exit(2)
            }
            target = CGPoint(x: x, y: y)
        }

        // AppKit(左下) → CG(左上)
        let cg = CGPoint(x: target.x, y: s.frame.maxY - target.y)
        CGWarpMouseCursorPosition(cg)
        // 让系统把这次移动派发出去（光标与鼠标重新关联）
        CGAssociateMouseAndMouseCursorPosition(1)
        print(String(format: "指针 → AppKit(%.0f, %.0f) | CG(%.0f, %.0f) | 刘海 %@",
                     target.x, target.y, cg.x, cg.y,
                     String(format: "%.0f×%.0f", s.frame.width, s.safeAreaInsets.top)))

        // 停留：给宿主 App 的指针轮询一点时间做判定
        let dwell = args.count >= 4 ? (Double(args[3]) ?? 400) / 1000 : 0.4
        Thread.sleep(forTimeInterval: dwell)
    }
}
