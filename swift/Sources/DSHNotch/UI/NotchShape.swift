import SwiftUI

/// 刘海延伸形状：**顶边平直、与屏幕顶边重合，只有底部两角圆角**。
///
/// ## 为什么不是「内凹耳朵」
///
/// 之前的实现给顶部两角画了内凹弧（`addQuadCurve` 控制点落在角上），
/// 想做「与摄像头区域互补的负形」。结果是：形状上沿被啃掉两块，
/// 读起来像个沙漏/奇形怪状的胶囊 —— 而物理刘海只是**一个方正的矩形缺口**，
/// 它的延伸自然也应该是矩形。
///
/// 关键在于**顶边必须落在屏幕顶边之外**：当形状顶端 y = 屏幕顶端时，
/// 两个方角正好压在屏幕边界上，肉眼看不见；于是整体读作
/// 「屏幕顶边正中长出来的一块黑色区域」= 刘海向下延伸。
/// 如果形状顶端距屏幕顶端还有 11pt（旧实现），方角暴露在画面里，
/// 就立刻变成「悬浮的黑盒子」。
///
/// ## 用 quadCurve 而不是 addArc
///
/// `Path.addArc` 的 `clockwise` 在 SwiftUI 的 y 向下坐标系里极易搞反，
/// 且端角计算容易差半个半径。二次贝塞尔以角点为控制点，无需关心角度方向。
struct NotchShape: Shape {
    /// 底部两角圆角半径
    var bottomRadius: CGFloat = 12

    var animatableData: CGFloat {
        get { bottomRadius }
        set { bottomRadius = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(bottomRadius, min(rect.width, rect.height) / 2)
        let minX = rect.minX, maxX = rect.maxX
        let minY = rect.minY, maxY = rect.maxY

        // 从左上角开始，顺时针一圈
        p.move(to: CGPoint(x: minX, y: minY))
        // 顶边：水平直线，与屏幕顶边重合（两角为方角，位于屏幕边界上，不可见）
        p.addLine(to: CGPoint(x: maxX, y: minY))
        // 右侧下行
        p.addLine(to: CGPoint(x: maxX, y: maxY - r))
        // 右下圆角
        p.addQuadCurve(to: CGPoint(x: maxX - r, y: maxY),
                       control: CGPoint(x: maxX, y: maxY))
        // 底边
        p.addLine(to: CGPoint(x: minX + r, y: maxY))
        // 左下圆角
        p.addQuadCurve(to: CGPoint(x: minX, y: maxY - r),
                       control: CGPoint(x: minX, y: maxY))
        p.closeSubpath()
        return p
    }
}
