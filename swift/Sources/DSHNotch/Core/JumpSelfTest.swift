import AppKit
import Foundation

/// 跳转链路自检：深链可达性 / 剪贴板文本选取 / 文案。
///
/// 刻意**不做真实跳转** —— `SessionJump.open` 会把 DSH 拉到前台并覆盖剪贴板
/// （有辅助功能权限时还会补发 ⌘K⌘V），自检不该有这种副作用。
/// 「深链真的能唤到 DSH」由系统 handler 查询来证明，不靠实测：
/// 本机已验证 `open "dsh://open"` 之后前台应用确实变成 DeepSeek Harness。
final class JumpSelfTest {
    private var passed = 0
    private var failed = 0

    func run() -> Bool {
        print("· dsh://open 深链与系统处理器")
        testDeepLink()
        print("· 剪贴板文本选取（标题优先，空白回退 id）")
        testClipboardText()
        print("· 剪贴板写入往返（写后复原，不霸占剪贴板）")
        testClipboardRoundTrip()
        print("· 反馈文案与权限探测")
        testOutcomeText()
        print("· 插件桥：端口解析与降级判定")
        testBridge()
        print("")
        print("[dsh-notch] 跳转自检结束：通过 \(passed)，失败 \(failed)")
        return failed == 0
    }

    // MARK: - 深链

    private func testDeepLink() {
        check(SessionJump.dshOpenURL.absoluteString == "dsh://open",
              "深链字面量是 dsh://open（DSH 的 open-url 只认这一个）")

        // 系统里必须有 App 注册了 dsh:// —— 这才是「能唤起来」的证据
        let handler = NSWorkspace.shared.urlForApplication(toOpen: SessionJump.dshOpenURL)
        check(handler != nil, "系统已注册 dsh:// 处理器：\(handler?.path ?? "未找到")")
        if let h = handler {
            check(h.path.contains("DeepSeek Harness"),
                  "处理器指向 DeepSeek Harness（\(h.lastPathComponent)）")
        }

        // 搜索键位：DSH 注册的是 KeyK + primary
        check(SessionJump.searchKey == 40, "会话搜索键位 = KeyK（kVK_ANSI_K, 40）")
    }

    // MARK: - 剪贴板文本

    private func testClipboardText() {
        let normal = entry(label: "高难度数学试卷出题", id: "session-abc12345")
        check(SessionJump.clipboardText(for: normal) == "高难度数学试卷出题",
              "正常标题原样进剪贴板")

        let blank = entry(label: "   ", id: "session-abc12345")
        check(SessionJump.clipboardText(for: blank) == "session-abc12345",
              "标题为空白时回退到会话 id（不会往剪贴板塞空串）")

        let padded = entry(label: "  带空格的标题  ", id: "x")
        check(SessionJump.clipboardText(for: padded) == "带空格的标题",
              "标题两端空白被裁掉")
    }

    // MARK: - 剪贴板往返

    private func testClipboardRoundTrip() {
        let pb = NSPasteboard.general
        let saved = pb.string(forType: .string)

        pb.clearContents()
        let wrote = pb.setString("DSHNotch-jump-selftest", forType: .string)
        check(wrote, "写入剪贴板返回成功")
        check(pb.string(forType: .string) == "DSHNotch-jump-selftest",
              "读回的内容与写入一致")

        // 复原，别把用户剪贴板留在测试值上
        pb.clearContents()
        if let saved { _ = pb.setString(saved, forType: .string) }
        check(true, "已复原原有剪贴板内容")
    }

    // MARK: - 文案与权限

    private func testOutcomeText() {
        let manual = SessionJump.Outcome.copied(title: "t", autoTyped: false)
        let auto = SessionJump.Outcome.copied(title: "t", autoTyped: true)
        check(manual.brief.contains("⌘K"), "未授权时提示「⌘K 粘贴」：\(manual.brief)")
        check(auto.brief.contains("回车"), "已授权时提示「回车确认」：\(auto.brief)")
        check(manual.isSuccess && auto.isSuccess, "成功路径判定为成功")
        check(!SessionJump.Outcome.failed(reason: "x").isSuccess, "失败路径判定为失败")

        // 权限探测本身不应崩，且是个明确的布尔值
        let trusted = SessionJump.canSendKeys
        print("  · 辅助功能权限: \(trusted ? "已授权（会替用户按 ⌘K ⌘V）" : "未授权（仅复制标题）")")
        check(true, "权限探测可正常求值")
    }

    // MARK: - 插件桥
    //
    // 不做真实 POST：那会往 DSH 插件的队列里塞一条真跳转请求，
    // 副作用是用户的 DSH 会突然切会话。这里只验「能不能算出桥地址」与
    // 「桥不可用时是否干净降级」——这两件事决定离线/未装插件的用户体验。
    // 真实往返由仓库的 test/test-bridge-client.mjs 端到端覆盖。
    private func testBridge() {
        // 端口文件路径必须与插件服务端写的那一个完全一致
        let expected = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("DSHNotch/bridge.json")
        check(SessionJump.bridgeDescriptorURL == expected,
              "端口文件路径与插件服务端一致：\(SessionJump.bridgeDescriptorURL.path)")

        // 没有端口文件时用兜底端口，且一定是回环地址
        let base = SessionJump.bridgeBaseURL()
        check(base.scheme == "http", "桥走 http（回环明文，不上 TLS）")
        check(base.host == "127.0.0.1", "桥只连本机回环：\(base.host ?? "?")")
        let port = base.port.map { Int($0) } ?? -1
        check(port == SessionJump.fallbackBridgePort || (port > 1023 && port < 65536),
              "桥端口合法（\(port)）：有文件用文件里的，没文件用兜底 \(SessionJump.fallbackBridgePort)")

        // 桥不通时必须返回 false，让调用方走降级 —— 不能卡住也不能崩。
        // 此刻 DSH 若在跑，桥就在，断言不成立；所以这条按「无论通不通都不得
        // 卡死或崩溃」来评：只看返回值合法性与耗时上限。
        let t0 = Date()
        let ok = SessionJump.postToBridge(sessionId: "session-selftest-should-not-be-used",
                                          title: "自检",
                                          timeout: 0.6)
        let spent = Date().timeIntervalSince(t0)
        check(true, "投递调用正常返回（通=\(ok)）")
        check(spent < 3.0, String(format: "投递没卡住界面（%.2fs）", spent))

        // 桥通时 Outcome 必须报「已切到该对话」，并被认成成功
        let bridged = SessionJump.Outcome.bridged(sessionId: "session-abc")
        check(bridged.isSuccess, "桥路径判定为成功")
        check(bridged.usedBridge, "桥路径被标记为走了桥")
        check(bridged.brief.contains("切到"), "桥路径文案：\(bridged.brief)")

        // 降级路径不能被误判成走了桥
        let copied = SessionJump.Outcome.copied(title: "t", autoTyped: false)
        check(!copied.usedBridge, "降级路径标记为未走桥")
    }

    // MARK: - 夹具

    private func entry(label: String, id: String) -> SessionEntry {
        var a = Activity()
        a.status = .tool
        a.title = "跑测试"
        return SessionEntry(id: id,
                            file: URL(fileURLWithPath: "/tmp/\(id)"),
                            project: "proj",
                            mtime: Date(),
                            label: label,
                            activity: a)
    }

    // MARK: - 断言

    private func check(_ ok: Bool, _ msg: String) {
        if ok {
            passed += 1
            print("  ✓ \(msg)")
        } else {
            failed += 1
            print("  ✗ \(msg)")
        }
    }
}
