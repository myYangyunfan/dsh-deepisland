import Foundation

/// 投影解析与合并的自检。
///
/// 两条腿走路：
/// - **合成 fixture** 精确断言每个字段（真实文件里字段可能恰好缺失，覆盖不了边界）。
/// - **本机真实投影缓存** 验证端到端能读到并解析出来（顺便暴露宿主格式漂移）。
///
/// 运行：`DSHNotch --self-test-projections`
final class ProjectionSelfTest {
    private var passed = 0
    private var failed = 0

    private func check(_ cond: Bool, _ msg: String) {
        if cond {
            passed += 1
        } else {
            failed += 1
            print("  ✗ \(msg)")
        }
    }

    private func checkEqual<T: Equatable>(_ a: T?, _ b: T?, _ msg: String) {
        check(a == b, "\(msg) —— 期望 \(String(describing: b))，实际 \(String(describing: a))")
    }

    func run() -> Bool {
        print("[dsh-notch] 投影自检开始")
        testTolerantParsing()
        testFixtureParsing()
        testCursorMerge()
        testDoneHold()
        testRealFiles()
        print("[dsh-notch] 投影自检结束：通过 \(passed)，失败 \(failed)")
        return failed == 0
    }

    // MARK: - 容错

    private func testTolerantParsing() {
        print("· 容错解析")
        check(ProjectionCache.parse(Data()) == nil, "空数据应返回 nil")
        check(ProjectionCache.parse(Data("not json".utf8)) == nil, "非 JSON 应返回 nil")
        check(ProjectionCache.parse(Data("{}".utf8)) == nil, "无 record 应返回 nil")
        check(ProjectionCache.parse(Data(#"{"record":{}}"#.utf8)) == nil, "无 rows 应返回 nil")
        // 有 rows 但字段全空 —— 应解析成功但 isEmpty
        let empty = ProjectionCache.parse(Data(#"{"record":{"rows":{}}}"#.utf8))
        check(empty != nil, "空 rows 应解析成功")
        check(empty?.isEmpty == true, "空 rows 应判定 isEmpty")
    }

    // MARK: - 字段解析（fixture 照抄本机真实结构）

    private func testFixtureParsing() {
        print("· 字段解析")
        let json = """
        {"version":7,"record":{"rows":{
         "tokenUsage":{"ver":1,"seq":544,"val":{"totals":{
           "uncachedInputTokens":2106768,"outputTokens":39369,
           "cacheReadTokens":1704232,"cacheWriteTokens":0}}},
         "contextPressure":{"ver":1,"seq":544,"val":{
           "surfaceTokens":77628,"contextWindow":262144,"pressureTokens":54829}},
         "sessionStats":{"ver":1,"seq":544,"val":{"turns":3,"steps":98,"llmMs":993847,
           "toolMs":873876,"lastTurn":3,"openStep":null,
           "pendingCalls":{"call_a":1791042626255}}},
         "todos":{"ver":2,"seq":544,"val":{"todos":[
           {"content":"调研开源项目","status":"completed"},
           {"content":"设计技术蓝图","status":"in_progress"}]}},
         "modelSelection":{"ver":2,"seq":544,"val":{
           "lastUsed":{"provider":"itti","model":"gemini-3.8-flash-high"},"pending":null}},
         "plan":{"ver":3,"seq":544,"val":{"active":true,"wanted":null,"running":null}},
         "permissions":{"ver":2,"seq":544,"val":{"preset":"danger-full-access"}},
         "title":{"ver":1,"seq":20,"val":"刘海屏智能体插件调研"}
        }}}
        """
        guard let p = ProjectionCache.parse(Data(json.utf8)) else {
            check(false, "fixture 应解析成功")
            return
        }
        checkEqual(p.seq, 544, "seq 取各 row 最大值")
        checkEqual(p.outputTokens, 39369, "输出 token")
        checkEqual(p.uncachedInputTokens, 2106768, "未缓存输入 token")
        checkEqual(p.cacheReadTokens, 1704232, "缓存命中 token")
        checkEqual(p.totalInputTokens, 3811000, "累计输入 = 未缓存 + 缓存命中")
        checkEqual(p.contextUsed, 77628, "上下文占用")
        checkEqual(p.contextWindow, 262144, "上下文窗口")
        checkEqual(p.turns, 3, "回合数")
        checkEqual(p.steps, 98, "步数")
        checkEqual(p.hasOpenStep, false, "openStep 为 null → 无未闭合 step")
        checkEqual(p.pendingCallIds, ["call_a"], "在飞调用 callId")
        checkEqual(p.todoTotal, 2, "待办总数")
        checkEqual(p.todoDone, 1, "已完成待办数")
        checkEqual(p.todoCurrent, "设计技术蓝图", "当前待办 = in_progress 那条")
        checkEqual(p.modelName, "gemini-3.8-flash-high", "模型名")
        checkEqual(p.provider, "itti", "provider")
        checkEqual(p.planActive, true, "plan 模式")
        checkEqual(p.permissionPreset, "danger-full-access", "权限预设")
        checkEqual(p.title, "刘海屏智能体插件调研", "会话标题")
        checkEqual(p.hasTodo, true, "有待办")
        checkEqual(p.isEmpty, false, "非空投影")

        // 上下文比例 ≈ 29.6%
        if let f = p.contextFraction {
            check(abs(f - 0.29613) < 0.001, "上下文比例 ≈ 29.6%，实际 \(f)")
        } else {
            check(false, "上下文比例应可算出")
        }

        // token 紧凑格式
        checkEqual(Projections.shortTokens(999), "999", "短 token <1000")
        checkEqual(Projections.shortTokens(39369), "39.4k", "短 token 万级")
        checkEqual(Projections.shortTokens(2106768), "2.1M", "短 token 百万级")

        // 上下文分档（Activity 层）
        var a = Activity()
        a.proj = p
        checkEqual(a.contextText, "30%", "上下文文本四舍五入")
        checkEqual(a.contextLevel, 0, "30% 属常规档")
        checkEqual(a.todoText, "1/2", "待办进度文本")
        checkEqual(a.turnStepText, nil, "无 turn/step 时徽标为空")

        // 全 null 的 rows（真实场景：会话刚开始）
        let sparse = ProjectionCache.parse(Data(#"{"record":{"rows":{"todos":{"ver":2,"seq":5,"val":null}}}}"#.utf8))
        check(sparse != nil, "val 为 null 应解析成功")
        checkEqual(sparse?.todoTotal, 0, "null 待办 → 0")
        check(sparse?.isEmpty == true, "仅 null 字段 → isEmpty")
    }

    // MARK: - 游标合并

    private func event(_ json: String) -> SessionEvent? {
        try? JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func testCursorMerge() {
        print("· 游标合并")
        guard let start = event(#"{"type":"turn/start","seq":1,"time":1791000000000,"data":{"turn":2}}"#),
              let callAgent = event(#"{"type":"tool/call","seq":2,"time":1791000001000,"data":{"turn":2,"step":5,"callId":"call_a","name":"subagent","arguments":"{\"description\":\"跑个子任务\"}"}}"#),
              let callBash = event(#"{"type":"tool/call","seq":3,"time":1791000002000,"data":{"turn":2,"step":6,"callId":"call_b","name":"bash","arguments":"{\"command\":\"ls\"}"}}"#)
        else {
            check(false, "测试事件构造失败")
            return
        }

        var cursor = ActivityCursor()
        var proj = Projections()
        proj.pendingCallIds = ["call_a", "call_b"]

        let a = cursor.apply([start, callAgent, callBash], now: 1791000003000, projections: proj)
        checkEqual(a.turn, 2, "事件流给了 turn")
        checkEqual(a.step, 6, "step 取最后一个 step/start 或工具事件")
        checkEqual(a.pendingTools, 2, "在飞工具数 = 投影 pendingCalls 键数")
        checkEqual(a.pendingAgents, 1, "在飞子代理数 = pendingCalls ∩ agent 类工具（subagent）")
        checkEqual(a.status, .tool, "状态为执行中")
        checkEqual(a.currentTool, "bash", "当前工具 = 最后一次调用")
        checkEqual(a.toolCount, 2, "本回合工具计数")

        // 投影里只有一个未知 callId（事件流还没读到）→ 不计入 agent
        var p2 = Projections()
        p2.pendingCallIds = ["call_unknown"]
        let b = cursor.apply([start, callAgent, callBash], now: 1791000003000, projections: p2)
        checkEqual(b.pendingAgents, 0, "无法映射工具名时不计子代理")
        checkEqual(b.pendingTools, 1, "但仍计入在飞工具数")

        // 没有投影 → 全部归零，不崩
        let c = cursor.apply([start, callAgent, callBash], now: 1791000003000, projections: nil)
        checkEqual(c.pendingAgents, 0, "无投影时子代理为 0")
        checkEqual(c.pendingTools, 0, "无投影时在飞工具为 0")

        // 投影兜底 turn/step：事件流里没有任何 step/start
        var cursor2 = ActivityCursor()
        var p3 = Projections()
        p3.turns = 7
        p3.steps = 42
        let d = cursor2.apply([start], now: 1791000003000, projections: p3)
        checkEqual(d.turn, 2, "事件流的 turn 优先于投影")
        checkEqual(d.step, 42, "step 缺失时用投影兜底")
    }

    // MARK: - 完成态保持

    private func testDoneHold() {
        print("· 完成态保持（结果不立刻消失）")
        // 事件时间用**真实毫秒级 epoch**：doneAt 现在取自事件自己的时间戳
        // （为了不让历史会话在启动瞬间集体显示「已完成」），用 1000/2000 这种
        // 玩具数字会立刻被判定成「历史重放」而拿不到回执期。
        let t0: Double = 1_791_000_000_000
        func ev(_ type: String, _ seq: Int, _ offset: Double, _ extra: String) -> SessionEvent? {
            event("{\"type\":\"\(type)\",\"seq\":\(seq),\"time\":\(Int(t0 + offset)),\"data\":{\(extra)}}")
        }
        guard let start = ev("turn/start", 1, 0, "\"turn\":1"),
              let call = ev("tool/call", 2, 500,
                            "\"callId\":\"c1\",\"name\":\"bash\",\"arguments\":\"{}\""),
              let end = ev("turn/end", 3, 1000, "\"turn\":1")
        else {
            check(false, "完成态事件构造失败")
            return
        }

        var cursor = ActivityCursor()
        // now 取「turn/end 之后 1 秒」
        let a = cursor.apply([start, call, end], now: t0 + 2000)
        checkEqual(a.status, .done, "回合结束 → done（而不是立刻 idle）")
        checkEqual(a.title, "任务已完成", "done 标题")
        checkEqual(a.isActive, true, "done 仍算活跃（岛要保持显示）")

        // 保持期内（距 turn/end 3 秒）
        let b = cursor.apply([start, call, end], now: t0 + 4000)
        checkEqual(b.status, .done, "3 秒内仍为 done")

        // 超过保持期 → 归位
        let c = cursor.apply([start, call, end], now: t0 + 1000 + ActivityCursor.doneHoldMs + 200)
        checkEqual(c.status, .idle, "超过保持期 → idle（岛收起）")
        checkEqual(c.isActive, false, "idle 不活跃")

        // 保持期内来了新回合 → 应立刻回到思考态
        var cursor2 = ActivityCursor()
        _ = cursor2.apply([start, call, end], now: t0 + 2000)
        let fresh = ev("turn/start", 4, 1500, "\"turn\":2")!
        let d = cursor2.apply([start, call, end, fresh], now: t0 + 3000)
        checkEqual(d.status, .thinking, "新回合打断 done")
        checkEqual(d.toolCount, 0, "新回合工具计数清零")

        // 历史重放：几小时前结束的回合**不该**获得一段新的 5 秒回执期
        // （否则 App 一启动，一排历史会话全显示「任务已完成」）
        var cursor3 = ActivityCursor()
        // 取整：事件里的 time 是整数毫秒，留着小数会让下面的相等断言永远差一点点
        let longAgo = (Date().timeIntervalSince1970 * 1000).rounded(.down) - 3 * 3600_000
        let hStart = event("{\"type\":\"turn/start\",\"seq\":1,\"time\":\(Int(longAgo)),\"data\":{\"turn\":1}}")!
        let hEnd = event("{\"type\":\"turn/end\",\"seq\":2,\"time\":\(Int(longAgo + 1000)),\"data\":{\"turn\":1}}")!
        let e = cursor3.apply([hStart, hEnd], now: Date().timeIntervalSince1970 * 1000)
        checkEqual(e.status, .idle, "重放几小时前结束的回合 → 直接 idle（不给新回执期）")
        check(cursor3.lastEventTime == longAgo + 1000, "游标记录了最后事件时间")
        check(cursor3.lastEventTime != nil, "最后事件时间可读（供停摆降级判定）")
    }

    // MARK: - 真实文件

    private func testRealFiles() {
        print("· 本机真实投影缓存")
        let cache = ProjectionCache()
        let source = SessionSource()
        let root = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh/sessions", isDirectory: true)
        guard let walker = FileManager.default.enumerator(at: root,
                                                          includingPropertiesForKeys: nil) else {
            print("  (跳过：读不到 sessions 目录)")
            return
        }
        var tried = 0
        var hit = 0
        var files: [URL] = []
        for case let url as URL in walker where url.lastPathComponent == "session.v4.jsonl.zstd" {
            tried += 1
            guard cache.projectionURL(for: url) != nil else { continue }
            hit += 1
            files.append(url)
            if let p = cache.load(for: url) {
                passed += 1
                print("  ✓ \(url.deletingLastPathComponent().lastPathComponent.prefix(24))"
                      + " seq=\(p.seq) turns=\(p.turns ?? -1) steps=\(p.steps ?? -1)"
                      + " out=\(p.outputTokens ?? -1) ctx=\(p.contextFraction.map { String(format: "%.1f%%", $0 * 100) } ?? "-")"
                      + " todos=\(p.todoDone)/\(p.todoTotal)"
                      + " pending=\(p.pendingCallIds.count)"
                      + " model=\(p.modelName ?? "-")")
            } else {
                failed += 1
                print("  ✗ 解析失败: \(url.lastPathComponent)")
            }
        }
        print("  会话文件 \(tried) 个，其中有投影缓存 \(hit) 个")
        // 只要存在缓存就能解析；本机至少有一个（否则说明路径规则变了，值得注意）
        check(hit > 0, "本机应至少命中一个投影缓存（否则命名规则可能已变）")

        testEndToEnd(files: files, cache: cache, source: source)
    }

    /// 端到端：真实事件流 → 游标 → 与「独立重算的期望值」对比。
    ///
    /// 关键在这条断言**不依赖游标实现**：期望值由测试自己遍历事件算出，
    /// 所以能真正判出游标算错（而不是自己验证自己）。
    /// 顺便量一下投影缓存相对事件流滞后多少 —— 这是「投影能不能当数据源」的实证。
    private func testEndToEnd(files: [URL], cache: ProjectionCache, source: SessionSource) {
        print("· 真实事件流端到端")
        var maxLag = 0
        var lagSamples = 0
        let recentFirst = files.sorted { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            return da > db
        }
        for url in recentFirst.prefix(3) {
            guard let events = source.loadEvents(from: url), !events.isEmpty else { continue }

            // 独立重算期望值
            var expectedTools = 0
            var expectedTurn: Int?
            var seenTurnStart = false
            var toolCallsTotal = 0
            var maxSeq = 0
            for e in events {
                if let s = e.seq { maxSeq = max(maxSeq, s) }
                if e.type == "turn/start" {
                    expectedTools = 0
                    seenTurnStart = true
                    expectedTurn = e.data?.turn ?? expectedTurn
                }
                if e.type == "tool/call" {
                    toolCallsTotal += 1
                    if seenTurnStart { expectedTools += 1 }
                }
            }

            var cursor = ActivityCursor()
            let now = Date().timeIntervalSince1970 * 1000
            let act = cursor.apply(events, now: now, projections: cache.load(for: url))

            let name = url.deletingLastPathComponent().lastPathComponent.prefix(24)
            checkEqual(act.toolCount, expectedTools,
                       "[\(name)] 本回合工具计数（独立重算 = \(expectedTools)，全量 \(toolCallsTotal)）")
            checkEqual(act.turn, expectedTurn, "[\(name)] 当前轮次")
            check(act.step != nil, "[\(name)] 应能取到 step")
            check(act.pendingAgents == 0, "[\(name)] 事件流里没有子代理 → 并发数应为 0")
            print("    \(name) turn=\(act.turn ?? -1) step=\(act.step ?? -1)"
                  + " toolCount=\(act.toolCount)/\(toolCallsTotal)"
                  + " ctx=\(act.contextText ?? "-") todos=\(act.todoText ?? "-")"
                  + " proj.seq=\(act.proj.seq) events.maxSeq=\(maxSeq)")

            // 投影实时性：row.seq 只在该值变化时推进，落后于 events.maxSeq 属正常，
            // 但差距过大说明投影停更了（那就不能拿它当数据源）。
            let lag = maxSeq - act.proj.seq
            maxLag = max(maxLag, lag)
            lagSamples += 1
            check(lag >= 0, "[\(name)] 投影 seq 不应超过事件流")
        }
        if lagSamples > 0 {
            print("  投影滞后：最大 \(maxLag) 个事件序号（样本 \(lagSamples)）")
            check(maxLag < 300, "投影滞后应有限（实测最大 \(maxLag)）")
        }
    }
}
