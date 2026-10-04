// 探针：打印真实屏幕几何，用于确定刘海宽高与窗口定位。
// 编译运行：
//   swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 -parse-as-library \
//     -o /tmp/probe-screen tools/probe-screen.swift
//   /tmp/probe-screen
import AppKit

@main
enum ProbeScreen {
    static func main() { run() }
}

func fmt(_ r: NSRect?) -> String {
    guard let r else { return "nil" }
    return String(format: "(x=%.1f y=%.1f w=%.1f h=%.1f)", r.origin.x, r.origin.y, r.width, r.height)
}

func run() {
let screens = NSScreen.screens
print("屏幕数量: \(screens.count)")
for (i, s) in screens.enumerated() {
    print("--- 屏幕 #\(i) \(s.localizedName) ---")
    print("  frame          : \(fmt(s.frame))")
    print("  visibleFrame   : \(fmt(s.visibleFrame))")
    print("  scaleFactor    : \(s.backingScaleFactor)")
    print("  safeAreaInsets : top=\(s.safeAreaInsets.top) left=\(s.safeAreaInsets.left) bottom=\(s.safeAreaInsets.bottom) right=\(s.safeAreaInsets.right)")
    print("  auxTopLeft     : \(fmt(s.auxiliaryTopLeftArea))")
    print("  auxTopRight    : \(fmt(s.auxiliaryTopRightArea))")
    if let l = s.auxiliaryTopLeftArea, let r = s.auxiliaryTopRightArea {
        let notchW = s.frame.width - l.width - r.width
        print("  >>> 推算刘海 : width=\(notchW) height=\(s.safeAreaInsets.top)")
    }
    print("  是否主屏       : \(s == NSScreen.main)")
    print("  有刘海         : \(s.safeAreaInsets.top > 0)")
}
}
