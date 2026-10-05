import Foundation

/// `IslandConfig` 的离线自检。
///
/// 守三件容易退化的事：
/// 1. **默认值必须是"显示"** —— 配置读不到时若默认关闭，用户会以为 app 坏了
/// 2. **坏文件不能把配置搞坏** —— 手改 JSON 写坏类型时必须退回默认值而不是崩
/// 3. **缓存按 mtime 失效** —— 改了文件要能读到，且没改时不能白读磁盘
///
/// 不依赖任何运行中的 DSH：只测文件的读/写/缓存语义。
final class IslandConfigSelfTest {

    private(set) var passed = 0
    private(set) var failed = 0

    private func check(_ ok: Bool, _ msg: String, _ detail: String = "") {
        if ok { passed += 1; print("  ✅ \(msg)") }
        else {
            failed += 1
            print("  ✗ \(msg)" + (detail.isEmpty ? "" : "  → \(detail)"))
        }
    }

    /// 跑之前把真实配置备份走 —— 自检不该弄丢用户的设置。
    private func withSandbox(_ body: () -> Void) {
        let url = IslandConfig.storeURL
        let fm = FileManager.default
        var backup: Data?
        var existed = false
        if let d = try? Data(contentsOf: url) { backup = d; existed = true }

        // 指向一个临时路径，避免动到用户真实配置
        let sandbox = url.deletingLastPathComponent()
            .appendingPathComponent("client-config.selftest-\(ProcessInfo.processInfo.processIdentifier).json")
        IslandConfig.overrideStore = sandbox
        defer {
            IslandConfig.overrideStore = nil
            try? fm.removeItem(at: sandbox)
            if let b = backup, existed { try? b.write(to: url) }
            else if !existed { try? fm.removeItem(at: url) }
        }
        body()
    }

    func run() -> Bool {
        print("· 配置默认值与文件缺失")
        testDefaults()

        print("· 写入 → 读回往返")
        withSandbox { testRoundTrip() }

        print("· 坏文件必须退回默认值（不能崩、不能读到错值）")
        withSandbox { testBadFile() }

        print("· 缓存按 mtime+大小 失效")
        withSandbox { testCacheInvalidation() }

        print("· 白名单：写出去不含插件不认识的键")
        withSandbox { testWhitelist() }

        print("")
        print("[dsh-notch] 配置自检结束：通过 \(passed)，失败 \(failed)")
        return failed == 0
    }

    // MARK: - 用例

    private func testDefaults() {
        IslandConfig.invalidate()
        let v = IslandConfig.Value()
        check(v.notchEnabled, "默认显示物理刘海（配置读不到时不能默认关闭）")
        check(v.jumpEnabled, "默认开启点岛跳会话")
        check(!v.scale.isNaN && v.scale == 1.0, "默认缩放 1.0", String(v.scale))
        check(v.fileExists == false, "尚未读过文件时 fileExists 为 false")
    }

    private func testRoundTrip() {
        IslandConfig.invalidate()
        var v = IslandConfig.Value()
        v.notchEnabled = false
        v.jumpEnabled = false
        v.idleHide = true
        v.scale = 1.25
        check(IslandConfig.save(v), "写入成功")

        IslandConfig.invalidate()
        let back = IslandConfig.load()
        check(back.notchEnabled == false, "notchEnabled 读回为 false")
        check(back.jumpEnabled == false, "jumpEnabled 读回为 false")
        check(back.idleHide == true, "idleHide 读回为 true")
        check(abs(back.scale - 1.25) < 0.001, "scale 读回 1.25", String(back.scale))
        check(back.fileExists, "读回后 fileExists 为 true")

        // 不存在的键不该导致读回 nil
        check(back.raw["placement"] == nil || back.raw["placement"] is String,
              "raw 里只保留能安全解析的值")
    }

    private func testBadFile() {
        // 注意：这里直接写 IslandConfig.storeURL（自检期间它已被指向沙箱路径），
        // 不要自己再拼一遍路径 —— 两处写法容易在改沙箱逻辑时漏掉一处。
        let url = IslandConfig.storeURL
        // 手改坏了：类型全错 + 一个悬空的 JSON
        try? "{ this is not json".write(to: url, atomically: true, encoding: .utf8)
        IslandConfig.invalidate()
        let v = IslandConfig.load()
        check(v.notchEnabled, "坏 JSON 时退回「显示」而不是崩或关闭")
        check(v.scale == 1.0, "坏 JSON 时缩放退回 1.0", String(v.scale))

        // 合法 JSON 但类型写错
        try? "{\"notchEnabled\": \"false\", \"scale\": \"big\"}".write(to: url, atomically: true, encoding: .utf8)
        IslandConfig.invalidate()
        let v2 = IslandConfig.load()
        check(v2.notchEnabled, "字符串 \"false\" 不当成布尔（否则会被误关）")
        check(v2.scale == 1.0, "字符串缩放被忽略")
    }

    private func testCacheInvalidation() {
        IslandConfig.invalidate()

        var v = IslandConfig.Value()
        v.notchEnabled = true
        _ = IslandConfig.save(v)
        IslandConfig.invalidate()
        check(IslandConfig.load().notchEnabled == true, "初始为开")

        v.notchEnabled = false
        _ = IslandConfig.save(v)
        let after = IslandConfig.load()
        check(after.notchEnabled == false, "改文件后（未 invalidate）也能读到新值",
              "缓存没按 mtime 失效，会一直返回旧值")
    }

    private func testWhitelist() {
        IslandConfig.invalidate()
        var v = IslandConfig.Value()
        v.raw = ["完全无关的键": "x", "bridgeEnabled": false]
        v.notchEnabled = true
        _ = IslandConfig.save(v)

        IslandConfig.invalidate()
        let back = IslandConfig.load()
        check(back.raw["完全无关的键"] == nil, "无关的键没有写进文件")
        check(back.raw["bridgeEnabled"] as? Bool == false, "插件认识的键原样保留")
    }
}
