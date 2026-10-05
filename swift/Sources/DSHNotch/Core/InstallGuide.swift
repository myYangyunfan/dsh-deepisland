import Foundation

/// 安装向导：检测插件是否已登记进 profile，并提供一键修复。
///
/// ## 为什么需要它（这不是"多做一个功能"）
///
/// /// 更正一个说法：`reconcileProfilePlugins` 确实是死函数，但**它不是关键**。
/// 真正写 bundles 的是 `selectBundle(name, true)`：
///
/// ```swift
/// // 插件管理器服务端
/// if (options?.enabled !== false) await this.selectBundle(name, true)
/// ```
///
/// 界面调用时传 `enabled: false`（`installBundle(spec, { enabled: false })`），
/// 于是这一步被跳过；官方 CLI 不传该参数，所以 `dsh plugin add` **会自动登记**。
///
/// 而界面上本来有个**「立即启用」按钮**（装完对话框里，t("installEnableNow")），
/// 点它就等于补登记 —— 大多数人装完直接关了对话框，所以没点上。
/// 本app 是给「没看见那个按钮」的人准备的等价替代。
///
/// 插件管理器的「安装」只做了一半 —— 它跑 `pnpm add`，只写 `dependencies`，
/// **不碰 `dsh.profile.bundles`**。而宿主按 `bundles` 顺序叠加载树，
/// 所以装完插件**压根不会被加载**，而且宿主**一点提示都没有**。
///
/// ## 为什么不能在 DSH 的灵动岛设置里做这件事
///
/// 常被问：「装了插件不就有设置页了？能在设置页里引导补登记吗？」
/// 答：**那个状态设置页不存在**。查证链条（全部实测，非推理）：
///
/// 1. 宿主文档（`dsh-app-boot` README）明写：插件树 = 从空列表开始，
///    **按 `dsh.profile.bundles` 顺序**叠各 bundle 的 patch。
///    `dependencies` 只管把文件装进 `node_modules`。
/// 2. 客户端清单的唯一入口是 `ClientModuleRegistry` 构造函数里的
///    `for (const entry of ctx.loader.entries())` 加上
///    `ctx.on("internal/plugin", ...)` —— 两路都只经过 Loader。
/// 3. 客户端文档：把 `dsh.client` 声明变成 `/plugins` 下的 bundle
///    的是 "**the host half**"（服务端插件先执行）。
///
/// 更强的一次：隔离 profile 里**真起 web 服务**看日志 —— 同一份package.json、
/// 只改 bundles：
///
/// | bundles | 服务日志 |
/// | :--- | :--- |
/// | 无插件 | **完全静默，一个字都不提这个插件** |
/// | 有插件 | `[dsh-vibe-island] install: present` / `bridge: 已就绪` |
///
/// 这比 `--dump-config` 强：前者是「配置文件里有没有」，
/// 后者是「插件真的跑了没有」。
///
/// 而 `ClientModuleRegistry` 注释里那个 `scan` 不是独立扫盘——
/// 同文件另一处写明 `Checked on every scan trigger (cordis 'internal/plugin')`，
/// 即 Loader 挂载事件。
///
/// 隔离实测（`DSH_HOME` 指到临时目录 + `dsh --dump-config`，
/// 同一份 package.json、同一个 node_modules，只改 bundles）：
///
/// | dependencies | bundles |插件树里 |
/// | :--- | :--- | :--- |
/// | 有 | 无 | **不出现** |
/// | 有 | 有 | 出现 |
///
/// 所以引导位只能是**不依赖插件已被加载**的地方 —— app 菜单正是那种
/// （是插件自动装 app，不是 app 依赖插件），方向相反但不矛盾。
///
/// 原来的解法是让用户去仓库里双击 `scripts/setup.command`。
/// 但那是给"手上没有 app 的人"的路；对**已经有 app 的人**（老用户升级、
/// 手滑删了插件又重装、或者本来就手工装过 app），再让他去下载仓库找文件
/// 纯属绕远。
///
/// 而本 app 是独立进程、**不依赖插件是否被加载**（插件自动装它，不是它依赖插件），
/// 所以它是最合适的引导位置：
///
/// ```text
/// DSH 设置面板（灵动岛）  → 只在插件已加载时存在，帮不到「还没加载」的人
/// setup.command          → 需要用户先去下载仓库
/// ✅ app 菜单（这里）      → 已经跑在机器上，随时能查随时能修
/// ```
///
/// ## 仍然存在的缺口
///
/// **全新用户第一次装的时候，这个面板还不存在**（app 也没装）。
/// 那条路必须靠 README + 插件管理器/发行页的说明文字。
/// 本文件解决的是"已经有 app 之后的每一次登记"。
enum InstallGuide {

    /// 插件的包名（与 package.json 的 name 一致）
    static let bundleName = "@dsh-external/dsh-vibe-island"

    /// profile 根目录：`~/.dsh/profiles/`
    ///
    /// `profilesDirOverride` 只给自检用。这套逻辑会**改写 profile 的
    /// package.json**，测试若指向真实目录就是把用户配置搅了 ——
    /// 改前备份救不了（用户不会去翻备份）。生产路径永远是 nil。
    static var profilesDirOverride: URL?

    static var profilesDir: URL {
        if let o = profilesDirOverride { return o }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".dsh/profiles", isDirectory: true)
    }

    /// 某个 profile 的状态。
    struct ProfileStatus {
        let name: String
        /// 装在 `dependencies` 里（装了）
        let installed: Bool
        /// 在 `dsh.profile.bundles` 里（会被加载）
        let activated: Bool
        let manifestURL: URL

        /// 装了但没激活 —— 就是需要引导的状态。
        var needsFix: Bool { installed && !activated }
    }

    /// 插件的加载状态。
    enum State {
        /// 已登记并加载 —— 一切正常
        case ok(ProfileStatus)
        /// 装了但没登记。`name` 是那个 profile 名
        case needsFix(ProfileStatus)
        /// 没装（profile 存在但 dependencies 里没有它）
        case notInstalled
        /// 根本找不到任何 profile（DSH 从没启动过？路径不对？）
        case noProfile

        var needsFix: Bool { if case .needsFix = self { return true }; return false }
    }

    /// 扫描所有 profile，报告插件的加载状态。
    ///
    /// 扫全部而不是只认某一个：用户可能同时有 `desktop` / `web` 等 profile，
    /// 而**每个 profile 的 bundles 是独立的** —— 登了 `web` 不等于登了 `desktop`。
    /// 只报「第一个有问题的 profile」，因为要修也得一次修一个（改完要重启）。
    static func scan() -> State {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: profilesDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return .noProfile }

        for dir in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { continue }

            let manifest = dir.appendingPathComponent("package.json")
            guard let data = try? Data(contentsOf: manifest),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }

            let installed = ((root["dependencies"] as? [String: Any])?[bundleName] != nil)
            let activated = ((root["dsh"] as? [String: Any])?["profile"] as? [String: Any])?["bundles"]
                .flatMap { $0 as? [Any] }?.contains { ($0 as? String) == bundleName } ?? false

            let st = ProfileStatus(
                name: dir.lastPathComponent,
                installed: installed,
                activated: activated,
                manifestURL: manifest
            )
            if st.needsFix { return .needsFix(st) }
            if st.installed && st.activated { return .ok(st) }
        }

        // 走到这：要么都没装，要么 profile 目录都没有
        let anyProfile = (try? fm.contentsOfDirectory(atPath: profilesDir.path))?.isEmpty == false
        return anyProfile ? .notInstalled : .noProfile
    }

    /// 补登记：把插件名追加进 `dsh.profile.bundles`。
    ///
    /// 三条纪律（每条都对应一个真实的坑）：
    ///
    /// 1. **改前备份**。直接写坏 manifest 会让 DSH 起不来，那比"插件不生效"严重得多。
    /// 2. **原子替换**。写临时文件再 `replaceItemAt` —— 直接覆写时中途被杀
    ///    会留下半截 JSON，DSH 下次启动直接崩。
    /// 3. **写完必须核对**。写完重新读一遍确认 bundles 里真的有它，
    ///    失败要如实报告并给出备份路径，不能报成功。
    ///
    /// - Note: DSH 正在运行时改它的 manifest 有被覆盖的风险
    ///   （宿主自己在退出/安装时也会写 manifest）。所以调用方必须先让用户
    ///   退出 DSH —— 见 `promptFix()`。
    @discardableResult
    static func fix(_ st: ProfileStatus) -> (ok: Bool, detail: String) {
        let fm = FileManager.default
        var backup: URL?
        var root: [String: Any]

        do {
            let data = try Data(contentsOf: st.manifestURL)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return (false, "读不懂 \(st.manifestURL.path)（不是合法 JSON）")
            }
            root = obj
            backup = st.manifestURL.appendingPathExtension("bak-before-activate-\(Int(Date().timeIntervalSince1970))")
            try fm.copyItem(at: st.manifestURL, to: backup!)
        } catch {
            return (false, "备份失败：\(error.localizedDescription)")
        }

        // 逐层建键：dsh.profile.bundles 可能整段都不存在
        var dsh = (root["dsh"] as? [String: Any]) ?? [:]
        var profile = (dsh["profile"] as? [String: Any]) ?? [:]
        var bundles = (profile["bundles"] as? [String]) ?? []
        if !bundles.contains(bundleName) { bundles.append(bundleName) }
        profile["bundles"] = bundles
        dsh["profile"] = profile
        root["dsh"] = dsh

        // 编码：不能默认 JSONSerialization 的紧凑格式，手写可读性差且容易丢 unicode
        guard let data = prettyJSON(root) else {
            return (false, "序列化失败（可能是 manifest 里有无法编码的值）")
        }

        do {
            try fm.createDirectory(at: st.manifestURL.deletingLastPathComponent(),
                                   withIntermediateDirectories: true)
            let tmp = st.manifestURL.appendingPathExtension("tmp-\(ProcessInfo.processInfo.processIdentifier)")
            try data.write(to: tmp)
            _ = try fm.replaceItemAt(st.manifestURL, withItemAt: tmp)
        } catch {
            return (false, "写入失败：\(error.localizedDescription)（原文件已备份到 \(backup!.path)）")
        }

        // 自证：重新读一遍
        let after = scan()
        if case .ok = after {
            return (true, "已登记到 profile「\(st.name)」。原 manifest 备份在 \(backup!.path)")
        }
        return (false, "写入完成但复核未通过（bundles 里仍没有本插件）。原文件备份在 \(backup!.path)")
    }

    /// 手写 JSON 编码：保持 key 有序、缩进两格、输出 UTF-8 且不转义中文。
    ///
    /// 不用 `JSONSerialization.data(withJSONObject:options:.prettyPrinted)`：
    /// 它会把非 ASCII 转成 `\uXXXX`（对用户可读性差），而且不保证 key 顺序。
    private static func prettyJSON(_ root: [String: Any]) -> Data? {
        var out = ""
        func enc(_ v: Any) -> String? {
            switch v {
            case let s as String:
                var r = "\""
                for ch in s.unicodeScalars {
                    switch ch {
                    case "\"": r += "\\\""
                    case "\\": r += "\\\\"
                    case "\n": r += "\\n"
                    case "\t": r += "\\t"
                    default:
                        if ch.value < 0x20 {
                            r += String(format: "\\u%04x", ch.value)
                        } else {
                            r.unicodeScalars.append(ch)   // 中文原样保留
                        }
                    }
                }
                return r + "\""
            case let n as NSNumber:
                // 区分 bool 与数字：NSNumber 里 CFGetTypeID 能判
                if String(cString: n.objCType) == "c" { return n.boolValue ? "true" : "false" }
                return n.doubleValue == n.doubleValue.rounded() ? String(Int(n.doubleValue)) : String(n.doubleValue)
            case let b as Bool: return b ? "true" : "false"
            case let a as [Any]:
                let items = a.compactMap { enc($0) }
                return "[\n      " + items.joined(separator: ",\n      ") + "\n    ]"
            case let d as [String: Any]:
                let keys = d.keys.sorted()     // 稳定顺序，便于 diff
                let items = keys.compactMap { k -> String? in
                    guard let v = enc(d[k]!) else { return nil }
                    // ⚠️ esc() 返回的**已经带引号**，外面不要再包一层。
                    // 早期写成 "\"\(esc(k))\": \(v)" → key 变成 ""dependencies""
                    // → 整个 JSON 解析失败 → 写完读回来全是 nil
                    // → 表现为「提示成功了，文件却是空的」。自检当场抓到。
                    return "\(esc(k)): \(v)"
                }
                return "{\n      " + items.joined(separator: ",\n      ") + "\n    }"
            case is NSNull: return "null"
            default: return nil
            }
        }
        func esc(_ s: String) -> String { (enc(s) ?? "\"\"\"") }

        guard let body = enc(root) else { return nil }
        out = body
        return out.data(using: .utf8)
    }
}
