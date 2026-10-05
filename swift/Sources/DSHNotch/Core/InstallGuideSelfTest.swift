import Foundation

/// `InstallGuide` 的自检。
///
/// 🔴 全程在**沙箱 profile** 上跑（`profilesDir` 可注入）——
/// 这套逻辑会**改写 profile 的 package.json**，万一测试指向真实目录，
/// 就把用户的 DSH 配置搅了。改前备份救不了（用户不会去翻备份）。
///
/// 验证重点是三条纪律：改前备份、原子替换（无 .tmp 残留）、写完自证。
final class InstallGuideSelfTest {

    private(set) var passed = 0
    private(set) var failed = 0

    private func check(_ ok: Bool, _ msg: String, _ detail: String = "") {
        if ok { passed += 1; print("  ✅ \(msg)") }
        else {
            failed += 1
            print("  ✗ \(msg)" + (detail.isEmpty ? "" : "  → \(detail)"))
        }
    }

    /// 造一个沙箱 profiles 目录，返回其路径。
    private func makeSandbox() -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("dshguide-test-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString.prefix(4))")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 写一个 profile 的 manifest。
    @discardableResult
    private func writeManifest(_ profiles: URL, _ name: String,
                               installed: Bool, activated: Bool) -> URL {
        let dir = profiles.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var root: [String: Any] = [
            "name": "dsh-profile-\(name)",
            "private": true,
            "dependencies": installed
                ? [InstallGuide.bundleName: "git+https://github.com/myYangyunfan/dsh-deepisland.git"]
                : [:],
        ]
        // bundles 里放**别的**插件（验"没被弄丢"），activated 时才加本插件。
        //
        // ⚠️ 第一版这里只在 activated 时才写 dsh 段，于是"装了没激活"的夹具
        // 里 bundles 是空的 —— 断言「原有 bundles 项没被弄丢」失败，
        // 查下来是**夹具造错**，不是被测代码的问题。
        var bs = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
        if activated { bs.append(InstallGuide.bundleName) }
        root["dsh"] = ["profile": ["bundles": bs]]
        let url = dir.appendingPathComponent("package.json")
        try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            .write(to: url)
        return url
    }

    /// 跑之前把 profilesDir 指到沙箱，跑完恢复。
    private func withSandbox(_ body: (URL) -> Void) {
        let sandbox = makeSandbox()
        let saved = InstallGuide.profilesDirOverride
        InstallGuide.profilesDirOverride = sandbox
        defer {
            InstallGuide.profilesDirOverride = saved
            try? FileManager.default.removeItem(at: sandbox)
        }
        body(sandbox)
    }

    func run() -> Bool {
        print("· 状态检测：四种情形")
        withSandbox { sandbox in
            // 1) 已装已激活
            _ = writeManifest(sandbox, "ok", installed: true, activated: true)
            if case .ok = InstallGuide.scan() {
                check(true, "已装且已激活 → .ok")
            } else {
                check(false, "已装且已激活 → .ok", String(describing: InstallGuide.scan()))
            }

            // 2) 装了没激活（就是要修的那一种）
            _ = writeManifest(sandbox, "broken", installed: true, activated: false)
            let st = InstallGuide.scan()
            if case .needsFix(let s) = st {
                check(true, "装了没激活 → .needsFix")
                check(s.name == "broken", "报告的 profile 名正确", s.name)
                check(s.needsFix, "needsFix 标志为真")
                check(s.installed && !s.activated, "状态字段正确（installed=true activated=false）")
            } else {
                check(false, "装了没激活 → .needsFix", String(describing: st))
            }

            // 3) 没装
            _ = writeManifest(sandbox, "empty", installed: false, activated: false)
            // 清掉前两个，只留 empty
            for n in ["ok", "broken"] { try? FileManager.default.removeItem(at: sandbox.appendingPathComponent(n)) }
            if case .notInstalled = InstallGuide.scan() {
                check(true, "没装 → .notInstalled")
            } else {
                check(false, "没装 → .notInstalled", String(describing: InstallGuide.scan()))
            }
        }

        print("· 目录不存在 → .noProfile")
        do {
            let saved = InstallGuide.profilesDirOverride
            InstallGuide.profilesDirOverride = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("dshguide-nope-\(UUID().uuidString.prefix(4))")
            if case .noProfile = InstallGuide.scan() {
                check(true, "profiles 目录不存在 → .noProfile")
            } else {
                check(false, "profiles 目录不存在 → .noProfile", String(describing: InstallGuide.scan()))
            }
            InstallGuide.profilesDirOverride = saved
        }

        print("· 修复：备份 / 原子替换 / 自证")
        withSandbox { sandbox in
            let url = writeManifest(sandbox, "fixme", installed: true, activated: false)
            let before = (try? Data(contentsOf: url)) ?? Data()

            guard case .needsFix(let st) = InstallGuide.scan() else {
                check(false, "造出 needsFix 状态（前提）")
                return
            }
            let (ok, detail) = InstallGuide.fix(st)
            check(ok, "修复返回成功", detail)
            check(detail.contains("备份"), "给出了备份路径", detail)

            // 备份文件确实存在，且内容等于改动前
            let fm = FileManager.default
            let backups = (try? fm.contentsOfDirectory(atPath: url.deletingLastPathComponent().path))?
                .filter { $0.contains(".bak-before-activate") } ?? []
            check(backups.count == 1, "备份文件真的落盘", "找到 \(backups.count) 个：\(backups)")
            if let b = backups.first {
                let bk = (try? Data(contentsOf: url.deletingLastPathComponent().appendingPathComponent(b))) ?? Data()
                check(bk == before, "备份内容 = 改动前的内容", "备份 \(bk.count) 字节 / 原 \(before.count) 字节")
            }

            // 改后 bundles 里真的有它
            let after = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any]
            let bundles = ((after?["dsh"] as? [String: Any])?["profile"] as? [String: Any])?["bundles"] as? [String] ?? []
            check(bundles.contains(InstallGuide.bundleName), "bundles 里现在有本插件", "\(bundles)")
            check(bundles.contains("@deepseek-ai/dsh-base"), "原有的 bundles 项没被弄丢", "\(bundles)")

            // 其它字段没被破坏
            check((after?["dependencies"] as? [String: Any])?[InstallGuide.bundleName] != nil,
                "dependencies 仍在（没被覆盖）",
                String(describing: after?["dependencies"]))
            check(after?["name"] != nil, "name 字段仍在", String(describing: after?["name"]))

            // 原子替换：不留 .tmp
            let leftovers = (try? fm.contentsOfDirectory(atPath: url.deletingLastPathComponent().path))?
                .filter { $0.contains(".tmp-") } ?? []
            check(leftovers.isEmpty, "没有 .tmp 残留（原子替换做对了）", "\(leftovers)")

            // 复核：fix 自己说成功，scan 也要认
            let after2 = InstallGuide.scan()
            if case .ok = after2 {
                check(true, "修复后 scan 认定为 .ok（自证通过）")
            } else {
                check(false, "修复后 scan 认定为 .ok（自证通过）", String(describing: after2))
            }
        }

        print("· 幂等与边界")
        withSandbox { sandbox in
            let url = writeManifest(sandbox, "again", installed: true, activated: false)
            if case .needsFix(let st) = InstallGuide.scan() {
                // 修两次
                _ = InstallGuide.fix(st)
                if case .needsFix(let st2) = InstallGuide.scan() {
                    let (ok2, _) = InstallGuide.fix(st2)
                    check(ok2, "已修复后再修不报错")
                    let a = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any]
                    let b = ((a?["dsh"] as? [String: Any])?["profile"] as? [String: Any])?["bundles"] as? [String] ?? []
                    check(b.filter { $0 == InstallGuide.bundleName }.count == 1, "bundles 里没有重复项", "\(b)")
                } else {
                    // 已修复 → 第二次应该是 .ok，菜单项根本不会出现
                    check(true, "修一次后状态变 .ok（菜单项会消失）")
                }
            } else {
                check(false, "造出 needsFix 状态（前提）")
            }
        }

        print("· manifest 里 dsh 段整体缺失时也要能补")
        withSandbox { sandbox in
            let dir = sandbox.appendingPathComponent("nodsh", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent("package.json")
            // 完全没有 dsh 键
            let noDsh: [String: Any] = [
                "name": "x", "private": true,
                "dependencies": [InstallGuide.bundleName: "git+https://github.com/x/y.git"],
            ]
            try? JSONSerialization.data(withJSONObject: noDsh, options: [.prettyPrinted]).write(to: url)

            if case .needsFix(let st) = InstallGuide.scan() {
                let (ok, detail) = InstallGuide.fix(st)
                check(ok, "dsh 段缺失也能补出来", detail)
                let a = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String: Any]
                let b = ((a?["dsh"] as? [String: Any])?["profile"] as? [String: Any])?["bundles"] as? [String] ?? []
                check(b == [InstallGuide.bundleName], "补出的 bundles 正确", "\(b)")
            } else {
                check(false, "dsh 段缺失时能识别为 needsFix", String(describing: InstallGuide.scan()))
            }
        }

        print("· 坏 manifest 不能崩")
        withSandbox { sandbox in
            let dir = sandbox.appendingPathComponent("bad", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? "{ 这不是 json".write(to: dir.appendingPathComponent("package.json"),
                                     atomically: true, encoding: .utf8)
            let st = InstallGuide.scan()
            // 坏文件应被跳过（既不算 needsFix 也不算 ok）
            let skipped: Bool
            switch st {
            case .ok, .needsFix: skipped = false      // 坏文件不算这两种
            case .notInstalled, .noProfile: skipped = true
            }
            check(skipped, "坏 manifest 被跳过而不是崩溃", String(describing: st))
        }

        print("")
        print("[dsh-notch] 安装向导自检结束：通过 \(passed)，失败 \(failed)")
        return failed == 0
    }
}

