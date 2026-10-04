// 探针：从外部读取 DSHNotch 面板窗口的几何，验证「顶端贴合屏幕顶边 + 水平居中」。
//
// 为什么需要：面板是 .statusBar 层级的无边框窗口，肉眼不可断言；
// 而 CGWindowListCopyWindowInfo 能拿到**不依赖屏幕录制权限**的窗口 bounds/层级
// （窗口标题才需要权限）。
//
// 编译运行：
//   swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 -parse-as-library \
//     -o /tmp/probe-window tools/probe-window.swift && /tmp/probe-window
import AppKit

@main
enum ProbeWindow {
    static func main() { run() }
}

func run() {
    guard let screen = NSScreen.main else { return }
    let scale = screen.backingScaleFactor
    print(String(format: "屏幕: %.0f×%.0f @%.0fx", screen.frame.width, screen.frame.height, scale))

    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                kCGNullWindowID) as? [[String: Any]] else {
        print("无法读取窗口列表")
        return
    }

    var found = false
    for w in list {
        // 注意：owner 是 CFBundleName「DSH Notch」（带空格），不是可执行名
        guard let owner = w[kCGWindowOwnerName as String] as? String,
              owner.replacingOccurrences(of: " ", with: "").contains("DSHNotch") else { continue }
        found = true
        let name = w[kCGWindowName as String] as? String ?? "-"
        let layer = w[kCGWindowLayer as String] as? Int ?? -999
        let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
        if let b = w[kCGWindowBounds as String] as? [String: CGFloat] {
            // CGWindow 坐标：原点左上、单位 pt
            print(String(format: "窗口「%@」 layer=%d alpha=%.2f", name, layer, alpha))
            print(String(format: "  bounds(pt): x=%.1f y=%.1f w=%.1f h=%.1f",
                         b["X"] ?? -1, b["Y"] ?? -1, b["Width"] ?? -1, b["Height"] ?? -1))
            let x = b["X"] ?? -1, y = b["Y"] ?? -1
            let ww = b["Width"] ?? -1, hh = b["Height"] ?? -1
            let centerOK = abs(x + ww / 2 - screen.frame.width / 2) < 1
            print("  顶端贴合屏幕顶边 (y≈0) : \(y <= 0.5 ? "✅" : "❌ y=\(y)")")
            print("  水平居中               : \(centerOK ? "✅" : "❌ 中心=\(x + ww / 2)")")
            print("  层级高于普通窗口        : \(layer >= 24 ? "✅ layer=\(layer)" : "⚠️ layer=\(layer)")")
            print(String(format: "  内边距推算岛体         : %.0f×%.0f pt", ww - 40, hh - 20))
        }
    }
    if !found { print("❌ 没有找到 DSHNotch 的窗口（应用未运行？）") }
}
