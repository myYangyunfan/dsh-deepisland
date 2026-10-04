import AppKit

/// 预览图的像素采样探针：不靠肉眼，直接量出「岛体黑底」「光晕色」在每一行的水平范围。
///
/// 用途：判断形状是否溢出、文字是否越界、岛体是否水平居中、顶端是否贴屏。
/// 目测 PNG 极易被图片缩放骗到，探针给的才是真数字。
///
/// 用法：`probe-pixels <png 路径> [行号 ...]`（行号省略时取一组默认值）
@main
enum ProbePixels {
    static func main() {
        let args = CommandLine.arguments
        guard args.count >= 2 else {
            print("用法: probe-pixels <png> [y ...]")
            exit(1)
        }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])),
              let rep = NSBitmapImageRep(data: data) else {
            print("读不到图片: \(args[1])")
            exit(1)
        }
        let w = rep.pixelsWide
        let h = rep.pixelsHigh
        print("图片 \(w)×\(h)")

        var rows: [Int] = args.dropFirst(2).compactMap { Int($0) }
        if rows.isEmpty {
            rows = [1, 4, 12, 24, 40, 56, 80, 120, 160, 200, 260, 320].filter { $0 < h }
        }

        for y in rows where y < h {
            var dark: [(Int, Int)] = []
            var green: [(Int, Int)] = []
            var darkStart: Int?
            var greenStart: Int?

            func close(_ start: inout Int?, _ list: inout [(Int, Int)], _ end: Int) {
                if let s = start, end - s >= 4 { list.append((s, end - 1)) }
                start = nil
            }

            for x in 0..<w {
                guard let c = rep.colorAt(x: x, y: y) else { continue }
                let r = c.redComponent, g = c.greenComponent, b = c.blueComponent
                let isDark = r < 0.10 && g < 0.10 && b < 0.10
                // 光晕：绿/青明显压过红（壁纸是蓝灰，红≈绿，不会误判）
                let isGlow = g > r + 0.12 && g > 0.25
                if isDark { if darkStart == nil { darkStart = x } } else { close(&darkStart, &dark, x) }
                if isGlow { if greenStart == nil { greenStart = x } } else { close(&greenStart, &green, x) }
            }
            close(&darkStart, &dark, w)
            close(&greenStart, &green, w)

            let ds = dark.map { "\($0.0)-\($0.1)" }.joined(separator: ",")
            let gs = green.map { "\($0.0)-\($0.1)" }.joined(separator: ",")
            print("y=\(String(format: "%4d", y))  黑底[\(ds.isEmpty ? "-" : ds)]  光晕[\(gs.isEmpty ? "-" : gs)]")
        }
    }
}
