import AppKit
import Combine
import SwiftUI

/// 应用入口。
///
/// 用 `NSApplicationMain` 风格手动驱动而非 `App` 协议：`App` 的 Settings-only
/// 场景在没有主窗口时无法保持常驻，而菜单栏 App 恰恰不需要任何窗口。
///
/// 常驻策略（对应「只在 DSH 有活动时显示」）：
/// - App 本身常驻菜单栏（Info.plist 里 LSUIElement = true，无 Dock 图标）
/// - 轮询会话文件；**仅当 DSH 处于活跃态时**才在刘海显示胶囊
/// - DSH 关闭 / 无活动 → 刘海收起，菜单栏图标变灰
///
/// 额外命令：`DSHNotch --render-preview <目录>` 离屏渲染形状预览后退出（自检用）。
@main
enum DSHNotchMain {
    static func main() {
        // 自检模式：离屏渲染 → 出图 → 退出，不启动 UI
        if let idx = CommandLine.arguments.firstIndex(of: "--render-preview"),
           idx + 1 < CommandLine.arguments.count {
            _ = NSApplication.shared
            let dir = CommandLine.arguments[idx + 1]
            let metrics = NotchMetrics.current()
            print("[dsh-notch] \(metrics.describe)")
            PreviewRenderer.render(to: dir, metrics: metrics)
            return
        }

        // 自检模式：模拟**无刘海**屏（M1 Air / iMac / 合盖只接外接屏）渲染。
        // 本机是带刘海的 Air，没有无刘海环境，只能靠假几何把这条路径画出来看。
        if let idx = CommandLine.arguments.firstIndex(of: "--render-preview-nonotch"),
           idx + 1 < CommandLine.arguments.count {
            _ = NSApplication.shared
            let dir = CommandLine.arguments[idx + 1]
            let metrics = NotchMetrics(screenFrame: NSRect(x: 0, y: 0, width: 1440, height: 900),
                                       notchRect: NSRect(x: 620, y: 900, width: 200, height: 0),
                                       hasNotch: false)
            print("[dsh-notch] 无刘海模拟屏：\(metrics.describe)")
            PreviewRenderer.render(to: dir, metrics: metrics)
            return
        }

        // 自检模式：向窗口注入合成事件，验证点击 → 钉住这条链路
        if CommandLine.arguments.contains("--self-test") {
            _ = NSApplication.shared
            let test = InteractionSelfTest()
            exit(test.run() ? 0 : 1)
        }

        // 自检模式：在真实投影缓存上验证解析与合并（不启动 UI）
        if CommandLine.arguments.contains("--self-test-projections") {
            let test = ProjectionSelfTest()
            exit(test.run() ? 0 : 1)
        }

        // 自检模式：多会话排序 / 展开尺寸 / 真实多会话发现（不启动 UI）
        if CommandLine.arguments.contains("--self-test-sessions") {
            _ = NSApplication.shared
            let test = SessionSelfTest()
            exit(test.run() ? 0 : 1)
        }

        // 自检模式：跳转链路（深链 / 剪贴板 / 文案；不做真实跳转）
        if CommandLine.arguments.contains("--self-test-jump") {
            _ = NSApplication.shared
            let test = JumpSelfTest()
            exit(test.run() ? 0 : 1)
        }

        // 自检模式：配置读写的离线语义（默认值 / 坏文件 / 缓存失效 / 白名单）
        //
        // 必须在沙箱路径上跑，所以放在 IslandConfigSelfTest 内部改写 storeURL，
        // 不碰用户真实配置。
        if CommandLine.arguments.contains("--self-test-config") {
            _ = NSApplication.shared
            let test = IslandConfigSelfTest()
            exit(test.run() ? 0 : 1)
        }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // .accessory：不进 Dock、不抢焦点，但可正常接收事件
        app.setActivationPolicy(.accessory)
        app.run()
        // 保活 delegate
        withExtendedLifetime(delegate) { _ = delegate }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NotchPanel?
    private var timer: Timer?
    /// 指针轮询（高频，只读鼠标位置，不碰文件）
    private var pointerTimer: Timer?
    private let source = SessionSource()
    /// 会话投影缓存（token / 上下文 / 待办 / 模型 —— 事件流里没有的结构化指标）
    private let projections = ProjectionCache()
    /// 多会话监控：每个会话一套独立游标。DSH 可以同时开多个对话，
    /// 只跟最新那一个文件会丢掉其余对话的状态。
    private lazy var monitor = SessionMonitor(source: source, projections: projections)
    /// 轮询序号（供监控器给非主会话降频）
    private var tickIndex = 0
    private let state = NotchViewState()
    private let metrics = NotchMetrics.current()
    private var isVisible = false
    private var pinItem: NSMenuItem?
    private var idleItem: NSMenuItem?
    private var hoverItem: NSMenuItem?
    private var notchItem: NSMenuItem?
    private var launchItem: NSMenuItem?

    /// 数据轮询间隔（秒）。与插件端的 250ms 一致。
    private let pollInterval: TimeInterval = 0.25
    /// 指针轮询间隔（秒）。悬停要跟手，得比数据快一档。
    private let pointerInterval: TimeInterval = 1.0 / 15.0
    /// 空闲多久后收起刘海（秒）
    private let idleHideDelay: TimeInterval = 3.0
    private var lastActiveAt: Date?
    private var didLogFirstTick = false

    // MARK: - 悬停状态

    /// 指针是否停在岛上
    private var hovering = false
    /// 指针离开的时刻（用于延迟收起，避免边缘抖动导致反复闪）
    private var hoverExitAt: Date?
    /// 离开后多久收起（秒）
    private let hoverGrace: TimeInterval = 0.35
    /// 进入热区后需停留多久才展开（秒）——防止鼠标掠过顶部时误触发
    private var hoverEnterAt: Date?
    private let hoverDwell: TimeInterval = 0.18

    /// 启动时演示一次展开，让用户立刻看到「它在工作」
    private var showcaseActive = false

    private let verbose = ProcessInfo.processInfo.environment["DSH_NOTCH_VERBOSE"] != nil
    /// 订阅视图层的状态变化（例如点一下岛体钉住），好把它记进日志、立刻生效
    private var cancellables = Set<AnyCancellable>()

    /// DSH 是否在运行 —— 常驻策略的唯一依据
    private var dshRunning = false
    /// 空闲时自动收起（默认关：要的就是「DSH 开着就常驻」）
    private var hideWhenIdle: Bool {
        get { UserDefaults.standard.bool(forKey: "hideWhenIdle") }
        set { UserDefaults.standard.set(newValue, forKey: "hideWhenIdle") }
    }
    /// 鼠标悬停展开（默认开）
    private var hoverExpand: Bool {
        get { UserDefaults.standard.object(forKey: "hoverExpand") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "hoverExpand") }
    }
    private static let dshBundleID = "com.deepseek.dsh"

    // MARK: - 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("[dsh-notch] 屏幕度量: \(metrics.describe)")
        NSLog("[dsh-notch] 硬件刘海: \(metrics.hasNotch ? "有" : "无（退化为悬浮模式）")")
        dshRunning = Self.isDSHRunning()
        lastActiveAt = Date()   // 启动给一段宽限期，避免「空闲收起」立刻生效
        let panel = NotchPanel(metrics: metrics)
        panel.installContent(NotchContentView(metrics: metrics, state: state))
        self.panel = panel
        NSLog("[dsh-notch] zstd 工具: \(SessionSource.zstdToolPath ?? "未找到（将无法读取会话）")")
        let bootFiles = source.sessionFiles()
        NSLog("[dsh-notch] 候选会话 \(bootFiles.count) 个: \(bootFiles.map { String($0.id.prefix(14)) }.joined(separator: ", "))")
        NSLog("[dsh-notch] DSH 运行中: \(dshRunning) | 悬停热区: \(metrics.hoverHotRect)")

        let wc = NSWorkspace.shared.notificationCenter
        wc.addObserver(self, selector: #selector(dshAppChanged),
                       name: NSWorkspace.didLaunchApplicationNotification, object: nil)
        wc.addObserver(self, selector: #selector(dshAppChanged),
                       name: NSWorkspace.didTerminateApplicationNotification, object: nil)

        // 点一下岛体 = 钉住/取消钉住（在视图层触发），这里跟进收起与日志
        state.$pinned.dropFirst().sink { [weak self] pinned in
            guard let self else { return }
            if self.verbose { NSLog("[dsh-notch] 钉住状态: \(pinned ? "开（常驻展开）" : "关")") }
            self.pinItem?.title = pinned ? "取消钉住展开 HUD" : "钉住展开 HUD"
            self.applyExpansion()
        }.store(in: &cancellables)

        // 点某个对话 = 跳到那个对话（视图只报「点了哪个」，副作用留在这一层）
        state.onOpenSession = { [weak self] entry in
            self?.openSession(entry)
        }

        installStatusItem()
        startPolling()
        startPointerPolling()
        writeLaunchDiagnostics()
        // accessory 策略下需显式激活，NSPanel 才会显示
        NSApp.activate(ignoringOtherApps: false)

        // 启动演示：展开 2.4s 让用户确认「装上了、在跑」
        showcaseActive = true
        applyExpansion()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { [weak self] in
            self?.showcaseActive = false
            self?.applyExpansion()
        }

        // 诊断：延迟自查窗口几何（窗口注册是异步的，立刻查查不到）
        if verbose {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                self?.panel?.dumpSelf()
            }
        }
    }

    /// 把启动时的关键状态落到一个文件里。
    ///
    /// 为什么不用日志：本机统一日志读不到本进程的 NSLog（`log show` 与
    /// `log stream` 都抓不到，实测 0 行），而这是个**没有终端**的常驻 GUI ——
    /// 出问题时手里一点线索都没有。写个小文件最省事：既能自己诊断，
    /// 用户也能直接把内容发出来。
    private func writeLaunchDiagnostics() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/DSHNotch", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let text = """
        DSH Notch 启动诊断
        时间: \(Date())
        屏幕: \(metrics.describe)
        DSH 运行中: \(dshRunning)
        辅助功能权限: \(SessionJump.canSendKeys ? "已授权 → 点对话会置前 DSH 并自动 ⌘K/粘贴" : "未授权 → 点对话只置前 DSH + 复制标题")
        跳转深链: \(SessionJump.dshOpenURL.absoluteString)
        zstd 解压工具: \(SessionSource.zstdToolPath ?? "未找到 → 读不到任何会话（面板会一直空白）")
        会话候选: \(source.sessionFiles().count) 个
        """
        try? text.write(to: dir.appendingPathComponent("last-launch.txt"),
                        atomically: true, encoding: .utf8)
    }

    static func isDSHRunning() -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == dshBundleID }
    }

    @objc private func dshAppChanged() {
        let now = Self.isDSHRunning()
        if now != dshRunning {
            dshRunning = now
            NSLog("[dsh-notch] DSH \(now ? "已启动" : "已退出") → 灵动岛\(now ? "常驻" : "收起")")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        pointerTimer?.invalidate()
    }

    // MARK: - 菜单栏

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
            btn.image = NSImage(systemSymbolName: "waveform.path.ecg", accessibilityDescription: "DSH Notch")
            btn.image?.isTemplate = true
        }
        let menu = NSMenu()
        let info = NSMenuItem(title: String(format: "刘海 %.0f×%.0f pt · 屏幕 %.0f×%.0f",
                                            metrics.notchWidth, metrics.notchHeight,
                                            metrics.screenFrame.width, metrics.screenFrame.height),
                              action: nil, keyEquivalent: "")
        info.isEnabled = false
        menu.addItem(info)
        menu.addItem(.separator())

        let help = NSMenuItem(title: "使用说明…", action: #selector(showHelp), keyEquivalent: "")
        help.target = self
        menu.addItem(help)
        menu.addItem(.separator())

        // 显示/隐藏物理刘海本身。
        // 写的是插件设置面板读的同一个文件（IslandConfig.save），
        // 所以从 app 里关掉，DSH 设置里也会同步显示为关闭 —— 两边不会打架。
        let notchToggle = NSMenuItem(title: IslandConfig.notchVisible ? "隐藏刘海灵动岛" : "显示刘海灵动岛",
                                     action: #selector(toggleNotchIsland), keyEquivalent: "")
        notchToggle.target = self
        notchItem = notchToggle
        menu.addItem(notchToggle)

        menu.addItem(.separator())

        let toggle = NSMenuItem(title: state.pinned ? "取消钉住展开 HUD" : "钉住展开 HUD",
                                action: #selector(toggleExpanded), keyEquivalent: "")
        toggle.target = self
        pinItem = toggle
        menu.addItem(toggle)

        let hover = NSMenuItem(title: "鼠标悬停展开",
                               action: #selector(toggleHoverExpand), keyEquivalent: "")
        hover.target = self
        hover.state = hoverExpand ? .on : .off
        hoverItem = hover
        menu.addItem(hover)

        let idleItem = NSMenuItem(title: "空闲时自动收起",
                                  action: #selector(toggleHideWhenIdle), keyEquivalent: "")
        idleItem.target = self
        idleItem.state = hideWhenIdle ? .on : .off
        self.idleItem = idleItem
        menu.addItem(idleItem)

        let launch = NSMenuItem(title: "开机自动启动",
                                action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        launch.target = self
        launch.state = Self.launchAtLoginEnabled ? .on : .off
        launchItem = launch
        menu.addItem(launch)

        // 自动定位对话（替用户按 ⌘K ⌘V）唯一的前置条件
        let ax = NSMenuItem(title: SessionJump.canSendKeys
                                ? "辅助功能已授权（点对话自动定位）"
                                : "授予辅助功能权限（自动定位对话）…",
                            action: #selector(requestAccessibility), keyEquivalent: "")
        ax.target = self
        menu.addItem(ax)

        menu.addItem(.separator())

        let reveal = NSMenuItem(title: "在 Finder 中显示会话文件", action: #selector(revealSession), keyEquivalent: "")
        reveal.target = self
        menu.addItem(reveal)

        let preview = NSMenuItem(title: "导出形状预览图…", action: #selector(exportPreview), keyEquivalent: "")
        preview.target = self
        menu.addItem(preview)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        item.menu = menu
    }

    @objc private func showHelp() {
        let alert = NSAlert()
        alert.messageText = "DSH Notch 怎么用"
        alert.informativeText = """
        刘海就是这块浮层。它在 DeepSeek Harness 运行期间常驻。

        · 鼠标移到刘海上 → 展开成大面板（看一眼就够，不用点）
        · 移开鼠标 0.35 秒 → 自动收起
        · 在岛上点一下 → 钉住常驻展开，再点一下取消
        · 等待人工确认时（状态变橙）会自动展开提醒你
        · 任务跑完会保持绿色「任务已完成」几秒，再自动收起
        · 状态色：灰=待命 蓝=思考 青=执行工具 橙=等你确认 绿=已完成

        折叠态显示：状态点 / 当前动作 / 工具名（或子代理数）/ 耗时。
        上下文吃紧（>50%）时会额外亮出占用百分比，过半转琥珀、超 80% 转红。

        展开态显示：状态角标、当前任务、轮次与步数（T3·S98）、工具参数正文、
        待办进度与当前待办项、耗时、工具调用次数、输出 token 数、
        上下文占用百分比、在飞的工具/子代理数、模型名与权限预设。

        ── 多个对话 ──
        DSH 同时开多个对话时，刘海同时跟随最多 6 个活跃会话（最近 30 分钟
        有写入的那些）。折叠态显示最该关注的那个，右侧徽标 ⚏2/3 表示
        「3 个在跟、2 个在跑」；展开态每个对话各占一行，按
        「等人工确认 > 执行工具 > 思考中 > 已完成 > 待命」排序，
        主会话那行有底色。任一会话在等你确认都会自动展开提醒，不只是主会话。

        菜单栏波形图标里还有：悬停展开开关、空闲自动收起、开机自启、
        定位会话文件、导出形状预览图、退出。

        ── 跳转到对话 ──
        展开态里点某一行对话（单会话时点中间那块正文）→ DSH 被拉到前台，
        同时那个会话的标题进了剪贴板。接着在 DSH 里按 ⌘K 打开会话搜索、
        ⌘V 粘贴，就能定位过去。

        若在菜单栏里授予「辅助功能」权限，⌘K 与粘贴这两步会替你完成，
        只剩一个回车确认。

        为什么不能一键直达：DSH 对外只注册了 dsh://open 这一条深链，
        作用是「把主窗口拉到前台」；它的主界面是无 URL 路由的 SPA，
        也没有任何「打开第 N 个对话」的外部接口。所以跳转只能复用
        DSH 自己的 ⌘K 会话搜索 —— 全程对 DSH 本体零改动、零注入。

        ── 数据 ──
        数据来自 ~/.dsh/sessions（事件流，zstd 解压后增量读取）与
        ~/.dsh/storages/session_projcache（DSH 自己的状态投影，
        提供 token / 上下文 / 待办等事件流里没有的指标）。
        全程只读，不上传，不修改任何 DSH 文件。
        """
        NSApp.activate(ignoringOtherApps: true)
        alert.addButton(withTitle: "知道了")
        alert.runModal()
    }

    @objc private func toggleExpanded() {
        state.pinned.toggle()
        pinItem?.title = state.pinned ? "取消钉住展开 HUD" : "钉住展开 HUD"
        applyExpansion()
        refresh(force: true)
    }

    @objc private func toggleHideWhenIdle() {
        hideWhenIdle.toggle()
        idleItem?.state = hideWhenIdle ? .on : .off
        // 同步给 DSH 设置面板（它读同一份配置）
        var v = IslandConfig.load()
        v.idleHide = hideWhenIdle
        _ = IslandConfig.save(v)
        tick()
    }

    /// 显示 / 隐藏物理刘海灵动岛。
    ///
    /// 写的是插件设置面板读的那份配置，所以从 app 里关掉，
    /// DSH 设置里也会同步显示为关闭 —— **两边不会各说各话**。
    @objc private func toggleNotchIsland() {
        let on = IslandConfig.toggleNotch()
        syncNotchMenuItem()
        if on {
            presentIfNeeded()
            tick()
        } else {
            state.pinned = false
            state.isExpanded = false
            hovering = false
            hideIfNeeded()
        }
        if verbose { NSLog("[dsh-notch] 刘海灵动岛已\(on ? "显示" : "隐藏")（配置已同步给 DSH 设置面板）") }
    }

    /// 让菜单项的标题与勾选状态跟上配置。
    private func syncNotchMenuItem() {
        guard let item = notchItem else { return }
        let on = IslandConfig.notchVisible
        item.title = on ? "隐藏刘海灵动岛" : "显示刘海灵动岛"
        item.state = on ? .on : .off
    }

    @objc private func toggleHoverExpand() {
        hoverExpand.toggle()
        hoverItem?.state = hoverExpand ? .on : .off
        if !hoverExpand {
            hovering = false
            hoverEnterAt = nil
            hoverExitAt = nil
            panel?.isInteractive = false
            applyExpansion()
        }
    }

    private func applyExpansion() {
        // 展开条件：用户钉住 / **任一会话**等人工确认 / 鼠标悬停 / 启动演示
        // （原来是只看主会话，多会话时某个次要对话在等人会被漏掉）
        let shouldExpand = state.pinned
            || state.sessions.contains { $0.activity.isWaitingApproval }
            || (hoverExpand && hovering)
            || showcaseActive
        if state.isExpanded != shouldExpand { state.isExpanded = shouldExpand }
    }

    // MARK: - 跳转到对话

    /// 点岛上的对话 → 跳到 DSH 里的那个对话。
    ///
    /// 只做两件确定成立的事：把 DSH 置前（唯一官方深链 `dsh://open`）、
    /// 把标题放进剪贴板。若已获辅助功能权限，`SessionJump` 还会补发
    /// ⌘K + ⌘V，用户只剩一个回车。
    ///
    /// 「打开第 N 个对话」在 DSH 侧没有官方入口，原因见 `SessionJump` 的注释。
    private func openSession(_ entry: SessionEntry) {
        let outcome = SessionJump.open(entry)
        NSLog("[dsh-notch] 跳转「\(entry.label)」→ \(outcome.brief)")
        state.jumpFeedback = outcome.brief
        // 反馈留 2.4s：够看清，又不会长期占住 header 的提示位
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { [weak self] in
            self?.state.jumpFeedback = nil
        }
    }

    /// 辅助功能权限：这是「自动定位」（替用户按 ⌘K ⌘V）的唯一前提。
    ///
    /// 没授权时 `CGEvent.post` 会被系统静默丢弃 —— 不是报错，是没反应，
    /// 所以这里主动把授权入口摆出来，而不是让用户猜为什么点了没效果。
    @objc private func requestAccessibility() {
        if SessionJump.canSendKeys {
            let alert = NSAlert()
            alert.messageText = "已获辅助功能权限"
            alert.informativeText = """
            点岛上的对话行时，除了把 DSH 拉到前台、把标题放进剪贴板，
            还会自动替你打开会话搜索（⌘K）并粘好标题 —— 你只需回车确认。

            （刚在系统设置里勾上的话，重启一次 DSH Notch 才会生效。）
            """
            alert.addButton(withTitle: "好")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }

        // 先触发系统自己的授权询问（带「打开系统设置」）
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        // 再把「辅助功能」这一页直接打开，省得用户自己去翻
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func revealSession() {
        guard let f = source.latestSessionFile() else { return }
        NSWorkspace.shared.activateFileViewerSelecting([f])
    }

    @objc private func exportPreview() {
        let dir = NSTemporaryDirectory() + "dsh-notch-preview"
        PreviewRenderer.render(to: dir, metrics: metrics)
        NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    }

    // MARK: - 开机自启（写用户级 LaunchAgent，无需管理员权限）

    private static let launchLabel = "com.deepseek.dshnotch"
    private static var launchAgentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(launchLabel).plist")
    }
    private static var launchAtLoginEnabled: Bool {
        FileManager.default.fileExists(atPath: launchAgentURL.path)
    }

    @objc private func toggleLaunchAtLogin() {
        let url = Self.launchAgentURL
        let uid = getuid()
        if Self.launchAtLoginEnabled {
            Self.launchctl(["bootout", "gui/\(uid)/\(Self.launchLabel)"])
            do {
                try FileManager.default.removeItem(at: url)
                NSLog("[dsh-notch] 已关闭开机自启")
            } catch {
                NSLog("[dsh-notch] 删除 LaunchAgent 失败: \(error.localizedDescription)")
            }
        } else {
            // 从 .build 直接跑时 executablePath 指向构建产物；装到 /Applications 后
            // 指向 app 内的可执行文件。用 Bundle.main.bundlePath 判断更稳：
            // app 包用 `open -a` 启动，避免 LaunchAgent 直接跑可执行文件时
            // 拿不到正确的 bundle 环境。
            let bundlePath = Bundle.main.bundlePath
            let isAppBundle = bundlePath.hasSuffix(".app")
            let plist: [String: Any] = [
                "Label": Self.launchLabel,
                "ProgramArguments": isAppBundle
                    ? ["/usr/bin/open", "-a", bundlePath]
                    : [Bundle.main.executablePath ?? ""],
                "RunAtLoad": true,
                "KeepAlive": false,
                "ProcessType": "Interactive",
            ]
            do {
                let data = try PropertyListSerialization.data(fromPropertyList: plist,
                                                              format: .xml, options: 0)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                try data.write(to: url)
            } catch {
                NSLog("[dsh-notch] 写 LaunchAgent 失败: \(error.localizedDescription)")
                return
            }
            Self.launchctl(["bootstrap", "gui/\(uid)", url.path])
            NSLog("[dsh-notch] 已开启开机自启: \(url.path)")
        }
        launchItem?.state = Self.launchAtLoginEnabled ? .on : .off
    }

    @discardableResult
    private static func launchctl(_ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        do {
            try p.run()
            p.waitUntilExit()
            if p.terminationStatus != 0 {
                NSLog("[dsh-notch] launchctl \(args.first ?? "") 返回 \(p.terminationStatus)（可忽略）")
            }
            return p.terminationStatus
        } catch {
            NSLog("[dsh-notch] launchctl 调用失败: \(error.localizedDescription)")
            return -1
        }
    }

    // MARK: - 轮询

    private func startPolling() {
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
    }

    /// 指针轮询：悬停检测的唯一来源。
    ///
    /// 面板是 `ignoresMouseEvents = true` 的穿透窗口，**收不到 mouseEntered**，
    /// 所以悬停不能靠窗口事件，只能主动读 `NSEvent.mouseLocation`。
    /// 读鼠标位置不需要任何权限，也不需要辅助功能授权。
    private func startPointerPolling() {
        pointerTimer = Timer.scheduledTimer(withTimeInterval: pointerInterval, repeats: true) { [weak self] _ in
            self?.pointerTick()
        }
    }

    private func pointerTick() {
        guard let panel, isVisible, hoverExpand else {
            if hovering { setHovering(false) }
            return
        }

        let p = NSEvent.mouseLocation
        let compactHot = metrics.hoverHotRect
        // 展开态整块也算「还在岛上」：鼠标往下挪进 HUD 读信息时不该收起。
        // 高度按**当前会话数**算 —— 多会话列表比单会话高，热区跟着长。
        let currentHot = metrics.islandRect(size: metrics.islandSize(expanded: state.isExpanded,
                                                                    sessionRows: state.sessions.count))
            .insetBy(dx: -8, dy: -8)
            .union(compactHot)
        let insideHot = currentHot.contains(p)

        // 交互开关跟着指针走（不留宽限）：只有指针真在岛上时才接管点击，
        // 否则窗口矩形（480×180）会把下方应用和菜单栏的点击一起吞掉。
        panel.isInteractive = insideHot

        if !hovering {
            // 悬停展开需要「停留」一小会儿，避免鼠标掠过往顶栏时误触发
            if compactHot.contains(p) {
                if let t = hoverEnterAt {
                    if Date().timeIntervalSince(t) >= hoverDwell {
                        hoverEnterAt = nil
                        setHovering(true)
                    }
                } else {
                    hoverEnterAt = Date()
                }
            } else {
                hoverEnterAt = nil
            }
        } else {
            if insideHot {
                hoverExitAt = nil
            } else if let t = hoverExitAt {
                if Date().timeIntervalSince(t) >= hoverGrace {
                    hoverExitAt = nil
                    setHovering(false)
                }
            } else {
                hoverExitAt = Date()
            }
        }
    }

    private func setHovering(_ value: Bool) {
        guard hovering != value else { return }
        hovering = value
        if verbose { NSLog("[dsh-notch] 悬停: \(value ? "进入热区 → 展开" : "离开 → 收起")") }
        applyExpansion()
    }

    // MARK: - 配置

    /// 上一次应用过的配置，用来判断「设置面板有没有改动」。
    private var appliedConfig: IslandConfig.Value?

    /// 检查设置面板写入的配置并应用。
    ///
    /// - Returns: 物理刘海应该显示时返回 true；被关掉返回 false。
    ///
    /// 为什么在 tick 最前面：设置面板关掉之后，岛必须**立刻**消失。
    /// 放在会话轮询之后会有最多 250ms 的延迟，而且会话解析失败时可能一直不更新。
    ///
    /// `IslandConfig.load()` 内部按 mtime+大小 缓存，这里每 250ms 调一次
    /// 实际只是一次 `stat`，开销可忽略；只有真变了才走下面的应用逻辑。
    private func applyConfigIfChanged() -> Bool {
        let cfg = IslandConfig.load()
        guard cfg != appliedConfig else { return IslandConfig.notchVisible }
        appliedConfig = cfg

        if verbose {
            NSLog("[dsh-notch] 配置变化: 物理刘海=\(cfg.notchEnabled ? "开" : "关")"
                  + " 跳转=\(cfg.jumpEnabled ? "开" : "关")"
                  + " 空闲收起=\(cfg.idleHide ? "开" : "关")")
        }
        // 从 DSH 设置面板改的，菜单标题与勾选状态要跟着变
        syncNotchMenuItem()

        // 空闲收起也归设置管。UserDefaults 每次写都要落盘，
        // 只在真变了时写（配置没变时这段根本不会进来）。
        if hideWhenIdle != cfg.idleHide {
            hideWhenIdle = cfg.idleHide
        }

        guard cfg.notchEnabled else {
            // 关掉时把状态清干净：否则重新打开会看到上次的展开态/钉住残留
            state.pinned = false
            state.isExpanded = false
            hovering = false
            hideIfNeeded()
            return false
        }
        return true
    }

    private func tick() {
        let now = Date().timeIntervalSince1970 * 1000
        tickIndex &+= 1

        // 配置优先判定：设置面板关掉物理刘海时要立刻消失，不能等会话轮询
        if !applyConfigIfChanged() { return }

        // 一次轮询拿到**全部**候选会话（按关注度排序，第一个是主会话）
        let sessions = monitor.poll(now: now, tickIndex: tickIndex)
        let activity = sessions.first?.activity ?? .idle

        // 状态驱动：只在真正变化时写入 @Published，避免打断动画
        state.now = now
        if state.sessions != sessions { state.sessions = sessions }
        if state.activity != activity { state.activity = activity }

        if activity.isActive {
            lastActiveAt = Date()
        }

        // 首帧打一条诊断：确认数据通路真的通了
        if !didLogFirstTick {
            didLogFirstTick = true
            let names = sessions.map { "\($0.label.prefix(12))(\($0.activity.status.rawValue))" }
                .joined(separator: ", ")
            NSLog("[dsh-notch] 首帧: 会话 \(sessions.count) 个 [\(names)] 主会话「\(activity.title)」")
        }

        applyExpansion()

        // 常驻策略：DSH 运行中 → 常驻；DSH 退出 → 收起
        // （可选用「空闲时自动收起」把常驻改成只在干活时出现）
        let shouldShow: Bool
        if !dshRunning && !showcaseActive {
            shouldShow = false
        } else if hideWhenIdle {
            shouldShow = activity.isActive || hovering
                || (lastActiveAt.map { Date().timeIntervalSince($0) <= idleHideDelay } ?? false)
        } else {
            shouldShow = true
        }

        if shouldShow { presentIfNeeded() } else { hideIfNeeded() }
    }

    private func presentIfNeeded() {
        guard !isVisible else { return }
        isVisible = true
        panel?.present()
    }

    private func hideIfNeeded() {
        guard isVisible else { return }
        isVisible = false
        hoverEnterAt = nil
        panel?.isInteractive = false
        panel?.hideNotch()
    }

    /// 手动触发一次刷新（设置变更后调用）。
    private func refresh(force: Bool) {
        if force { monitor.reset() }
        tick()
    }
}
