import AppKit

/// 屏幕几何度量：所有尺寸/定位的唯一真源。
///
/// 物理刘海没有公开 API 直接给出矩形，但 `auxiliaryTopLeftArea` /
/// `auxiliaryTopRightArea`（macOS 12+）给出刘海**左右两侧**的可绘制区域，
/// 于是：
///
///     刘海宽 = 屏幕宽 - 左侧区宽 - 右侧区宽
///     刘海高 = safeAreaInsets.top
///
/// 本机实测（MacBook Air 13"，1280×832 @2x）：
///     auxTopLeft  = (0, 804, 562, 28)
///     auxTopRight = (718, 804, 562, 28)
///     → 刘海 = 156 × 28，中心 x = 640（正好等于屏幕中心）
///
/// 注意：这里全部是**逻辑点（pt）**。屏幕顶部 28pt 的带状区域即菜单栏，
/// 刘海占其正中 156pt。向外扩宽多少，就等于盖掉多少菜单栏。
struct NotchMetrics {
    /// 屏幕逻辑坐标（AppKit，原点左下）
    var screenFrame: NSRect
    /// 刘海矩形（屏幕坐标）
    var notchRect: NSRect
    /// 屏幕是否有硬件刘海
    var hasNotch: Bool

    var notchWidth: CGFloat { notchRect.width }
    var notchHeight: CGFloat { notchRect.height }

    // MARK: - 尺寸策略

    /// 折叠态在刘海两侧各外扩多少（会盖住等宽的菜单栏空白区）
    private var compactWing: CGFloat { hasNotch ? 26 : 60 }
    /// 展开态在刘海两侧各外扩多少
    private var expandedWing: CGFloat { hasNotch ? 142 : 200 }

    /// 折叠胶囊：比刘海略宽，向下多出一条信息带
    var compactSize: CGSize {
        CGSize(width: notchWidth + compactWing * 2,
               height: notchHeight + infoBandHeight)
    }

    /// 展开 HUD：更宽更高，同样顶端贴屏
    ///
    /// 高度 160 → 176：信息行从「耗时 / 工具调用」两格扩到「耗时 / 工具 / 输出 token /
    /// 上下文占用」，另加一行模型信息与一条待办行，132pt 的内容带已放不下。
    var expandedSize: CGSize {
        let w = min(notchWidth + expandedWing * 2, screenFrame.width - 48)
        return CGSize(width: max(w, compactSize.width), height: notchHeight + 148)
    }

    /// 刘海下方那条用来显示文字的信息带高度
    var infoBandHeight: CGFloat { hasNotch ? 22 : 0 }

    /// 面板窗口外扩（给光晕/阴影留绘制空间，顶端不外扩）
    static let bleed: CGFloat = 20

    /// 窗口尺寸：按展开态取最大，避免展开时被裁掉
    var windowSize: NSSize {
        NSSize(width: expandedSize.width + Self.bleed * 2,
               height: expandedSize.height + Self.bleed)
    }

    // MARK: - 探测

    /// 目标屏幕：优先有硬件刘海的屏，否则主屏。
    static func targetScreen() -> NSScreen? {
        if let m = NSScreen.main, m.safeAreaInsets.top > 0 { return m }
        if let first = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) { return first }
        return NSScreen.main
    }

    static func current() -> NotchMetrics {
        guard let s = targetScreen() else {
            return NotchMetrics(
                screenFrame: NSRect(x: 0, y: 0, width: 1280, height: 800),
                notchRect: NSRect(x: 540, y: 772, width: 200, height: 28),
                hasNotch: false
            )
        }

        let f = s.frame
        let h = s.safeAreaInsets.top
        var width: CGFloat = 200   // 回退值

        if let l = s.auxiliaryTopLeftArea, let r = s.auxiliaryTopRightArea {
            let w = f.width - l.width - r.width
            if w > 0 { width = w }
        }

        // 刘海位于屏幕正中、顶部
        let rect = NSRect(x: f.midX - width / 2, y: f.maxY - h, width: width, height: h)
        return NotchMetrics(screenFrame: f, notchRect: rect, hasNotch: h > 0)
    }

    /// 面板窗口应处的位置：**顶端严格对齐屏幕顶端**。
    ///
    /// 之前用 `screen.frame.maxY - totalHeight` 且 totalHeight 含顶部阴影留白，
    /// 导致内容整体下移半个留白（11pt），读作「悬浮黑盒子」而不是刘海延伸。
    /// 现在窗口顶端 = 屏幕顶端，形状顶端与屏幕顶端重合，顶边方角因此不可见。
    var windowOrigin: NSPoint {
        let size = windowSize
        return NSPoint(x: screenFrame.midX - size.width / 2,
                       y: screenFrame.maxY - size.height)
    }

    /// 文字区距形状顶端的缩进：刘海高度（物理挖孔内画什么都看不见）
    var contentTopInset: CGFloat { notchHeight }

    // MARK: - 命中区（屏幕坐标，AppKit 左下原点）

    /// 岛体矩形：顶端贴屏，水平居中。
    ///
    /// 悬停/点击判定都用它，而不是窗口矩形 —— 窗口按展开态取最大并含
    /// `bleed` 留白（480×180），拿窗口当热区会把菜单栏一大片都算成"岛上"。
    func islandRect(expanded: Bool) -> NSRect {
        let size = expanded ? expandedSize : compactSize
        return NSRect(x: screenFrame.midX - size.width / 2,
                      y: screenFrame.maxY - size.height,
                      width: size.width,
                      height: size.height)
    }

    /// 悬停热区：折叠态岛体向外扩 8pt。
    ///
    /// 向外扩是因为**刘海正中那 156×28 是物理挖孔、屏幕上看不见任何东西**，
    /// 用户"把鼠标放到刘海上"时其实是在盲区里，判定必须宽松一点才跟手。
    var hoverHotRect: NSRect {
        islandRect(expanded: false).insetBy(dx: -8, dy: -8)
    }

    var describe: String {
        String(format: "屏幕 %.0f×%.0f@%.0fx | 刘海 %.0f×%.0f @(x=%.0f,y=%.0f) | 折叠 %.0f×%.0f | 展开 %.0f×%.0f",
               screenFrame.width, screenFrame.height,
               (NSScreen.main?.backingScaleFactor ?? 2),
               notchWidth, notchHeight, notchRect.minX, notchRect.minY,
               compactSize.width, compactSize.height,
               expandedSize.width, expandedSize.height)
    }
}
