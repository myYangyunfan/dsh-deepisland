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
/// 1. **有桥时（首选）**：把 sessionId 投给 DSH 插件的本机桥，由渲染进程调
///    `uiWorkspace.openSession(id)` 直接打开 —— 一步到位，不需要辅助功能权限。
/// 2. **无桥时（降级）**：`dsh://open` 置前 + 标题写进剪贴板 → 用户 ⌘K、⌘V 定位；
///    有辅助功能权限时代替用户按 ⌘K → ⌘V，用户只剩一个回车。
///
/// 第 2 步必须看 `AXIsProcessTrusted()`：没授权时 `CGEvent.post` 会被系统
/// **静默丢弃**（本项目早前做点击自检时踩过这个坑），发了等于没发。
/// 所以这里先探测权限，不满足就干净地退回「只复制」。
///
/// ## 桥是怎么来的
///
/// app 进不去 DSH（深链只有 `dsh://open`），但**插件的渲染进程可以**打开会话。
/// 于是 DSH 插件的服务端半边在 `127.0.0.1` 上起了一个小 HTTP 服务
/// （仓库 `lib/index.js`），并把实际端口写进 `bridge.json`。本 app 读那个文件
/// 拿到端口，`POST /jump` 把 sessionId 递过去，插件客户端轮询到后执行跳转。
///
/// 桥不存在通常是这几种情况：用户没装插件、DSH 没开、插件版本旧。
/// 全部走第 2 步降级，功能不受影响 —— 所以桥是纯增强。
enum SessionJump {
    /// DSH 唯一对外注册的深链
    static let dshOpenURL = URL(string: "dsh://open")!

    /// DSH 的会话搜索快捷键：宿主注册为 `KeyK` + `primary`
    static let searchKey: CGKeyCode = 40   // kVK_ANSI_K

    /// 是否已获辅助功能权限（决定能不能替用户按键）
    static var canSendKeys: Bool { AXIsProcessTrusted() }

    /// 跳转结果，用于在岛上显示反馈
    enum Outcome: Equatable {
        /// 已交给插件的桥，DSH 会直接切到该会话
        case bridged(sessionId: String)
        /// 已置前 DSH 并写入剪贴板；`autoTyped` 表示还替他开了搜索框、粘好了
        case copied(title: String, autoTyped: Bool)
        case failed(reason: String)

        /// 岛上显示的一行短提示
        var brief: String {
            switch self {
            case .bridged:
                return "已切到该对话"
            case .copied(_, let auto):
                return auto ? "已定位 · 回车确认" : "已复制标题 · ⌘K 粘贴"
            case .failed(let reason):
                return reason
            }
        }

        /// 是否是成功路径（自检断言用）
        var isSuccess: Bool {
            switch self {
            case .bridged, .copied: return true
            case .failed: return false
            }
        }

        /// 是否走了插件桥（自检与诊断用）
        var usedBridge: Bool {
            if case .bridged = self { return true }
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

    /// 桥端口文件：与插件服务端 `lib/index.js` 写在同一处。
    static var bridgeDescriptorURL: URL {
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return appSupport.appendingPathComponent("DSHNotch/bridge.json")
    }

    /// 桥的兜底端口：插件服务端默认 47311，被占时顺延，文件里才有真值。
    static let fallbackBridgePort = 47311

    /// 从端口文件里读出桥地址。
    ///
    /// 读不到就用兜底端口 —— 服务端在 47311 上起桥时本来就不写文件也照样能用，
    /// 所以「文件不存在」不等于「桥不在」，别在这里就放弃。
    static func bridgeBaseURL() -> URL {
        var port = fallbackBridgePort
        if let data = try? Data(contentsOf: bridgeDescriptorURL),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let p = obj["port"] as? Int, p > 1023, p < 65536 {
            port = p
        }
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    /// 把跳转请求投给插件的桥。
    ///
    /// - Returns: 投递成功返回 true；桥没起、拒绝或超时返回 false（调用方走降级）。
    ///
    /// 用同步的 `URLSession` 但**不绑主线程**：点击处理在主线程，
    /// 真同步等网络会把界面卡住。超时给得很短（1.2s）—— 本机回环，
    /// 正常是毫秒级；超过这个数就说明桥不在，等下去没意义。
    @discardableResult
    static func postToBridge(sessionId: String, title: String, timeout: TimeInterval = 1.2) -> Bool {
        let base = bridgeBaseURL()
        var request = URLRequest(url: base.appendingPathComponent("jump"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let payload: [String: String] = ["sessionId": sessionId, "title": title]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        var result = false
        let done = DispatchSemaphore(value: 0)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.waitsForConnectivity = false
        // 关键：bridge.json 可能是别人写的、或写坏了，schema 宽松一点免得整条解码失败
        cfg.httpAdditionalHeaders = ["Accept": "application/json"]
        let session = URLSession(configuration: cfg)
        let task = session.dataTask(with: request) { data, response, _ in
            defer { done.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            // 核对插件名：47311 附近可能有别的服务，别把别人的 200 当成桥
            let plugin = obj["plugin"] as? String ?? ""
            let ok = obj["ok"] as? Bool ?? false
            result = ok && plugin.contains("dsh-vibe-island")
        }
        task.resume()
        _ = done.wait(timeout: .now() + timeout + 0.4)
        session.invalidateAndCancel()
        return result
    }

    /// 跳转到某个会话。
    ///
    /// 优先走插件桥（一步到位，不需要辅助功能权限）；桥不可用时降级为
    /// 「置前 + 复制标题 +（有权限则）⌘K ⌘V」。
    ///
    /// 副作用（有意为之）：降级路径会把 DSH 拉到前台、并覆盖剪贴板。
    @discardableResult
    static func open(_ entry: SessionEntry) -> Outcome {
        // 1) 首选：交给插件桥。请求极快，不阻塞主线程
        if postToBridge(sessionId: entry.id, title: entry.label) {
            return .bridged(sessionId: entry.id)
        }

        // 2) 降级：官方唯一入口置前 + 标题进剪贴板
        let text = clipboardText(for: entry)
        let activated = NSWorkspace.shared.open(dshOpenURL)

        let pb = NSPasteboard.general
        pb.clearContents()
        let copied = pb.setString(text, forType: .string)

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
