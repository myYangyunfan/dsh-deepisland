import AppKit
import SwiftUI

/// 刘海形状：顶部两角内凹（贴合物理刘海的负形），底部两角外凸。
///
/// 关键在于**内凹曲线**——如果用普通圆角矩形，会读作「悬浮的黑盒子」；
/// 只有做出与摄像头区域互补的凹弧，才会被眼睛当成刘海的延伸。
struct NotchShape: Shape {
    /// 顶部内凹半径（越大越贴合）
    var topEar: CGFloat = 10
    /// 底部外凸半径
    var bottomRadius: CGFloat = 16

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topEar, bottomRadius) }
        set { newValue }   // 占位：真实更新走 withAnimation + 重新构造 Shape
    }

    /// 动画插值：SwiftUI 会对新旧两个 Shape 逐帧求值，用线性插值过渡。
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let w = rect.width, h = rect.height
        let te = min(topEar, w / 2)
        let br = min(bottomRadius, h / 2)

        // 从左下角起，逆时针
        p.move(to: CGPoint(x: 0, y: h - br))
        p.addArc(center: CGPoint(x: 0, y: h - br), radius: br,
                 startAngle: .degrees(180), endAngle: .degrees(90), clockwise: false)
        // 左侧上行到内凹起点
        p.addLine(to: CGPoint(x: 0, y: te))
        // 左上内凹（凹向内，让出摄像头位置）
        p.addQuadCurve(to: CGPoint(x: te, y: 0),
                       control: CGPoint(x: 0, y: 0))
        p.addLine(to: CGPoint(x: w - te, y: 0))
        // 右上内凹
        p.addQuadCurve(to: CGPoint(x: w, y: te),
                       control: CGPoint(x: w, y: 0))
        p.addLine(to: CGPoint(x: w, y: h - br))
        p.addArc(center: CGPoint(x: w, y: h - br), radius: br,
                 startAngle: .degrees(90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: 0, y: h - br))
        p.closeSubpath()
        return p
    }
}
