import Foundation

/// 一条 DSH 会话事件（对应 session.v4.jsonl.zstd 解压后的单行 JSON）。
///
/// 真实结构（逆向 dsh 0.2.0-rc.2 确认，见 test fixtures）：
/// ```json
/// { "type": "tool/call", "seq": 29, "time": 1791042626255,
///   "data": { "turn": 1, "callId": "call_…", "name": "bash",
///             "arguments": "{\"command\":\"ls -la …\"}" } }
/// ```
/// 注意 `data.arguments` 是 **JSON 字符串**而非对象，需要二次解析。
struct SessionEvent: Decodable {
    let type: String
    let seq: Int?
    let time: Double?
    let data: EventData?

    struct EventData: Decodable {
        let turn: Int?
        let step: Int?
        let callId: String?
        let name: String?
        let text: String?
        let command: String?
        let isError: Bool?
        /// 可能是对象，也可能是「内嵌 JSON 的字符串」，故用 FlexibleJSON 承接。
        let arguments: FlexibleJSON?
    }
}

/// 容忍三种形态：缺失 / 字符串 / 任意 JSON。
///
/// `[String: Any]` 不符合 `Decodable`（Any 无法 Decodable），所以先用
/// `JSONValue` 承接任意 JSON 值，再在 displayText 里取所需字段。
enum FlexibleJSON: Decodable {
    case none
    case string(String)
    case object([String: JSONValue])
    case other

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .none; return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        self = .other
    }

    /// 统一取出「命令 / 路径 / 搜索模式 / 问题」这类可展示文本。
    var displayText: String? {
        switch self {
        case .none, .other:
            return nil
        case .string(let s):
            // arguments 本身是「内嵌 JSON 的字符串」→ 解开后按字段取
            if let data = s.data(using: .utf8),
               let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data) {
                return Self.pick(from: obj)
            }
            return s.isEmpty ? nil : s
        case .object(let obj):
            return Self.pick(from: obj)
        }
    }

    private static func pick(from obj: [String: JSONValue]) -> String? {
        if let c = obj["command"]?.stringValue { return c }
        if let p = (obj["file_path"] ?? obj["path"])?.stringValue { return p }
        if let p = obj["pattern"]?.stringValue { return "搜索 \"\(p)\"" }
        if let q = obj["question"]?.stringValue { return "提问: \(q)" }
        if let d = obj["description"]?.stringValue, !d.isEmpty { return d }
        guard !obj.isEmpty else { return nil }
        let parts = obj.keys.sorted().compactMap { k -> String? in
            guard let v = obj[k] else { return nil }
            switch v {
            case .string(let s): return "\(k): \(s)"
            case .number(let n): return "\(k): \(n)"
            case .bool(let b): return "\(k): \(b)"
            case .null: return nil
            default: return "\(k): \(v)"
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

/// 可解码的任意 JSON 值（`Any` 的可解码替身）。
enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        self = .null
    }

    var stringValue: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        default: return nil
        }
    }
}
