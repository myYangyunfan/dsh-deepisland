import Foundation

/// 灵动岛的运行配置 —— 由 DSH 插件的设置面板控制，物理刘海 app 按它表现。
///
/// ## 为什么需要这个文件
///
/// 之前窗口内那个 DOM 岛和物理刘海这个 app 是**两个互不相通的东西**：
/// 设置面板的开关只作用于前者（`config.enabled` → 岛组件 `return null`），
/// 物理刘海完全不受影响。于是用户看到的是「设置里的开关点了没反应」，
/// 而物理刘海该显示还是显示。
///
/// 现在把配置提升为**两边共享的一份**，位置与插件服务端写的
/// `client-config.json` 完全一致：
///
/// ```text
/// 插件设置面板 ──POST /config──▶ 插件服务端（Node 进程）──▶ client-config.json
///                                                                        │
///                                          物理刘海 app（Swift）◀── 读同一份 ◀─┘
/// ```
///
/// ## 为什么优先读文件而不是走 HTTP
///
/// - **不卡界面**：读取在主线程，而每 250ms 一次的网络请求迟早会抖一下
/// - **不依赖插件在跑**：DSH 没开时也能读到上次的设置
/// - 文件就是 HTTP 端点背后的那一份，读它等于读权威值，不存在两套真相
///
/// ## 缓存策略
///
/// 每 250ms 读一次磁盘太浪费。用 **mtime + 大小** 判变化，
/// 没变就直接返回缓存值 —— `stat` 只是一次系统调用，可以忽略。
enum IslandConfig {

    // MARK: - 存储位置

    /// 与插件服务端 `configFilePath()` 写在同一处，别改。
    ///
    /// `overrideStore` 只给自检用：自检必须在沙箱路径上跑，
    /// 否则一跑就把用户的真实设置搅了。生产路径永远是 nil。
    static var overrideStore: URL?

    static var storeURL: URL {
        if let o = overrideStore { return o }
        let appSupport = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support")
        return appSupport.appendingPathComponent("DSHNotch/client-config.json")
    }

    // MARK: - 值

    /// 解析出的配置。所有字段都有默认值，**缺字段不等于关闭**。
    struct Value: Equatable {
        /// 窗口内的 DOM 岛是否显示。
        /// 用户说要把应用内的岛全删掉，所以这个只作为「兼容旧配置」存在。
        var domIslandEnabled: Bool = true

        /// 物理刘海岛是否显示 —— **这才是设置面板真正要控制的东西**。
        var notchEnabled: Bool = true

        /// 点岛上的对话是否直接跳会话（关掉就退回 ⌘K 方案）。
        var jumpEnabled: Bool = true

        /// 空闲多久后自动收起。
        var idleHide: Bool = true

        var scale: Double = 1.0

    /// 读到的原始字典，交给调用方取插件特有的键。
    var raw: [String: Any] = [:]

    /// 文件根本不存在（首次启动）—— 区别于「存在但 enabled: false」。
    var fileExists: Bool = false

    /// 手写相等：**只比影响行为的字段**。
    ///
    /// 不能用 `==` 自动合成 —— `raw` 是 `[String: Any]`，不可 Equatable。
    /// 而 `raw` 也不该参与比较：它装着设置面板的全部键，
    /// 其中任何一个改动都会让 tick() 误判成「配置变了」而重跑应用逻辑。
    /// 只看这五个真正驱动行为的值就够了。
    static func == (lhs: Value, rhs: Value) -> Bool {
        lhs.domIslandEnabled == rhs.domIslandEnabled
            && lhs.notchEnabled == rhs.notchEnabled
            && lhs.jumpEnabled == rhs.jumpEnabled
            && lhs.idleHide == rhs.idleHide
            && lhs.scale == rhs.scale
            && lhs.fileExists == rhs.fileExists
    }
}

    // MARK: - 读

    private static var cache: Value?
    private static var cachedStamp: String = ""

    /// 读配置。结果会被缓存到文件变化为止。
    @discardableResult
    static func load() -> Value {
        let url = storeURL
        let stamp = currentStamp(url)

        if let c = cache, stamp == cachedStamp { return c }

        var value = Value()
        value.fileExists = stamp != ""

        if !stamp.isEmpty, let data = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            value.raw = obj
            // 只认真正的 Bool。JSON 里 "false" 之类不该当布尔用 ——
            // 服务端已做白名单，这里再挡一层，防手改文件写坏类型。
            if let b = obj["enabled"] as? Bool { value.domIslandEnabled = b }
            if let b = obj["notchEnabled"] as? Bool { value.notchEnabled = b }
            if let b = obj["jumpEnabled"] as? Bool { value.jumpEnabled = b }
            if let b = obj["hideWhenIdle"] as? Bool { value.idleHide = b }
            if let n = obj["scale"] as? Double, n >= 0.5, n <= 2.0 { value.scale = n }
        }

        cache = value
        cachedStamp = stamp
        return value
    }

    /// 强制下次 `load()` 重新读盘（自检用；正常路径靠 mtime 自动失效）。
    static func invalidate() {
        cache = nil
        cachedStamp = ""
    }

    /// "mtime-大小"，变了就是文件变了。
    ///
    /// 不用 mtime 单独判：某些文件系统只精确到秒，同一秒内改两次会漏。
    /// 拼上大小几乎不可能撞。
    private static func currentStamp(_ url: URL) -> String {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              let m = a[.modificationDate] as? Date,
              let s = a[.size] as? Int
        else { return "" }
        return "\(Int(m.timeIntervalSince1970 * 1000))-\(s)"
    }

    // MARK: - 写（app 侧也能改，比如菜单里的开关）

    /// 把配置写回磁盘，让插件设置面板下次读到。
    ///
    /// 存在的意义是**双向**：设置面板能关物理刘海，app 自己的菜单也能关。
    /// 两边写同一个文件，就不会出现「A 说开着、B 说关着」。
    @discardableResult
    static func save(_ value: Value) -> Bool {
        var obj = value.raw
        obj["enabled"] = value.domIslandEnabled
        obj["notchEnabled"] = value.notchEnabled
        obj["jumpEnabled"] = value.jumpEnabled
        obj["hideWhenIdle"] = value.idleHide
        obj["scale"] = value.scale
        // 剔除插件设置面板不认识的键：服务端有白名单，
        // 写进去它会忽略，但留着会让下一个人以为它在生效。
        obj = obj.filter { key, _ in
            ["enabled", "notchEnabled", "jumpEnabled", "hideWhenIdle", "scale",
             "placement", "platformMode", "glowEffect", "expandOnHover",
             "showSubagentCount", "bridgeEnabled"].contains(key)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) else {
            return false
        }
        do {
            try FileManager.default.createDirectory(
                at: storeURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            // 原子替换：直接覆写时中途被杀会留下半截 JSON，
            // 下次读失败就悄悄退回默认值，用户会以为设置丢了。
            let tmp = storeURL.appendingPathExtension("tmp-\(ProcessInfo.processInfo.processIdentifier)")
            try data.write(to: tmp)
            _ = try FileManager.default.replaceItemAt(storeURL, withItemAt: tmp)
            invalidate()
            return true
        } catch {
            NSLog("[dsh-notch] 配置写入失败: \(error.localizedDescription)")
            return false
        }
    }
}

// MARK: - 便捷开关

extension IslandConfig {
    /// 当前是否应该显示物理刘海岛。
    static var notchVisible: Bool { load().notchEnabled }

    /// 切换物理刘海的显示状态，返回切换后的值。
    @discardableResult
    static func toggleNotch() -> Bool {
        var v = load()
        v.notchEnabled.toggle()
        return save(v) ? v.notchEnabled : load().notchEnabled
    }
}
