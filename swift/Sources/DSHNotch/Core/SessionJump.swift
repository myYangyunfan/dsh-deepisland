import AppKit
import ApplicationServices

/// 从灵动岛跳到 DSH 里的对应对话。
///
/// ## 为什么只能这么做
///
/// DSH Desktop 对外**只注册了一条深链** `dsh://open`，而且主进程的
/// `open-url` 处理里只认这一个字面量：
///
/// ```js
/// app.on("open-url", (event, url) => {
///   event.preventDefault();
///   if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
/// });
/// ```
///
/// 它的作用就是把主窗口拉到前台（实测有效）。除此之外没有任何入口：
/// - 主界面是**无 URL 路由**的 SPA（前端里唯一带 `pushState` 的是内置 PDF 阅读器）
/// - preload 暴露的只有 `dshDesktop` / `dshPlatform` / `__DSH_LOCALE__` 之类，
///   没有会话控制能力
/// - host 的 19387 端口是要鉴权的 ACP 传输层，只服务 agent 协议，不是 UI 控制口
///
/// 所以「打开第 N 个对话」没有官方入口，跳转只能**把 DSH 置前 + 复用 DSH
/// 自己的会话搜索**。
///
/// ## 会话搜索是 ⌘K
///
/// 宿主里注册的是：
///
/// ```js
/// register("session.search", () => t("search.sessions.aria"),
///          ["search sessions"], "KeyK", ["primary"], ["primary", "alt"],
///          () => ({ status: "handled", run: controls.search }));
/// ```
///
/// `KeyK` + `primary`（macOS 上 primary = Command）＝ **⌘K**。
///
/// ## 两级跳转
///
/// 1. **永远做**：`dsh://open` 置前 + 标题写进剪贴板 → 用户 ⌘K、⌘V 即可定位
/// 2. **有辅助功能权限时**：替用户按下 ⌘K → ⌘V，用户只剩一个回车
///
/// 第 2 步必须看 `AXIsProcessTrusted()`：没授权时 `CGEvent.post` 会被系统
/// **静默丢弃**（本项目早前做点击自检时踩过这个坑），发了等于没发。
/// 所以这里先探测权限，不满足就干净地退回「只复制」。
enum SessionJump {
    /// DSH 唯一对外注册的深链
    static let dshOpenURL = URL(string: "dsh://open")!

    /// DSH 的会话搜索快捷键：宿主注册为 `KeyK` + `primary`
    static let searchKey: CGKeyCode = 40   // kVK_ANSI_K

    /// 是否已获辅助功能权限（决定能不能替用户按键）
    static var canSendKeys: Bool { AXIsProcessTrusted() }

    /// 跳转结果，用于在岛上显示反馈
    enum Outcome: Equatable {
        /// 已置前 DSH 并写入剪贴板；`autoTyped` 表示还替他开了搜索框、粘好了
        case copied(title: String, autoTyped: Bool)
        case failed(reason: String)

        /// 岛上显示的一行短提示
        var brief: String {
            switch self {
            case .copied(_, let auto):
                return auto ? "已定位 · 回车确认" : "已复制标题 · ⌘K 粘贴"
            case .failed(let reason):
                return reason
            }
        }

        /// 是否是成功路径（自检断言用）
        var isSuccess: Bool {
            if case .copied = self { return true }
            return false
        }
    }

    /// 写进剪贴板的文本：投影标题优先，空白时退回会话 id。
    ///
    /// 用标题而不是 id —— ⌘K 的搜索框对人友好，标题也是列表行里**看得到**的那串字。
    static func clipboardText(for entry: SessionEntry) -> String {
        let t = entry.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? entry.id : t
    }

    /// 跳转到某个会话。
    ///
    /// 副作用（有意为之）：会把 DSH 拉到前台、并覆盖剪贴板。
    @discardableResult
    static func open(_ entry: SessionEntry) -> Outcome {
        let text = clipboardText(for: entry)

        // 1) 置前 DSH —— 唯一官方入口
        let activated = NSWorkspace.shared.open(dshOpenURL)

        // 2) 标题进剪贴板：这是「无论有没有权限都一定成立」的那半步
        let pb = NSPasteboard.general
        pb.clearContents()
        let copied = pb.setString(text, forType: .string)

        // 3) 有权限就替他把搜索框打开并粘贴
        let auto = canSendKeys
        if auto { scheduleAutoLocate() }

        guard activated || copied else { return .failed(reason: "跳转失败") }
        return .copied(title: text, autoTyped: auto)
    }

    /// 在后台线程之外、按顺序补发按键。
    ///
    /// 延迟是必需的：`dsh://open` 走的是 LaunchServices，窗口变成 key 需要
    /// 一点时间，按键早于窗口就绪会掉到别的应用上。
    /// 只发「⌘K + ⌘V」，**不发回车** —— 搜索结果里第一项未必就是目标，
    /// 交给用户自己确认，比替他猜安全。
    private static func scheduleAutoLocate(openDelay: TimeInterval = 0.5,
                                           pasteDelay: TimeInterval = 0.3) {
        DispatchQueue.main.asyncAfter(deadline: .now() + openDelay) {
            postCommandKey(searchKey)
            DispatchQueue.main.asyncAfter(deadline: .now() + pasteDelay) {
                postCommandKey(9)   // kVK_ANSI_V
            }
        }
    }

    /// 发一个 ⌘+<key>（自带 keyDown/keyUp，flags 两边都要给）
    private static func postCommandKey(_ key: CGKeyCode) {
        let src = CGEventSource(stateID: .hidSystemState)
        for isDown in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src,
                                  virtualKey: key,
                                  keyDown: isDown) else { continue }
            e.flags = .maskCommand
            e.post(tap: .cghidEventTap)
        }
    }
}
