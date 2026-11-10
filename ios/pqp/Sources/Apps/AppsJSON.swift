import Foundation

/// The JSON the bridge carries, measured and merged the way the web host does
/// it (`jsonByteLength`, `applyMergePatch` in `packages/shared` and
/// `client/src/lib/apps/merge-patch.ts`): sizes are the UTF-8 bytes of the
/// COMPACT serialisation of the parsed value, never of the text somebody sent.
enum AppJSON {
    /// `JSON.stringify` of the value: no whitespace, no escaped slashes, control
    /// characters as `\uXXXX` except the five JSON gives a short form.
    static func compact(_ value: JSONValue) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    static func byteCount(_ value: JSONValue) -> Int { compact(value).utf8.count }

    /// Nesting depth, an empty scalar being 0. Past `AppLimits.jsonMaxDepth` a
    /// value is refused (`jsonProblem`).
    static func depth(_ value: JSONValue) -> Int {
        switch value {
        case .array(let items): 1 + (items.map(depth).max() ?? 0)
        case .object(let fields): 1 + (fields.values.map(depth).max() ?? 0)
        default: 0
        }
    }

    /// Why a value is not plain bridge JSON, or nil when it is: nested too deep,
    /// a non-finite number (JSON cannot carry one, but a decoder bug could), or
    /// over `maxBytes` once serialised.
    static func problem(_ value: JSONValue, maxBytes: Int) -> String? {
        if depth(value) >= AppLimits.jsonMaxDepth { return "nesting is deeper than \(AppLimits.jsonMaxDepth)" }
        if containsNonFinite(value) { return "numbers must be finite" }
        if byteCount(value) > maxBytes { return "serialized value is larger than \(maxBytes) bytes" }
        return nil
    }

    /// RFC 7396. A patch that is not an object replaces the target; an object
    /// patch merges key by key and a `null` deletes the key.
    static func mergePatch(_ target: JSONValue?, with patch: JSONValue) -> JSONValue {
        guard case .object(let fields) = patch else { return patch }
        var out: [String: JSONValue] = [:]
        if case .object(let existing)? = target { out = existing }
        for (key, value) in fields {
            if case .null = value {
                out.removeValue(forKey: key)
            } else {
                out[key] = mergePatch(out[key], with: value)
            }
        }
        return .object(out)
    }

    /// What the session state would weigh after `patch`.
    static func bytesAfter(_ current: JSONValue, patch: JSONValue) -> Int {
        byteCount(mergePatch(current, with: patch))
    }

    /// A key order that does not change between runs, for tests and for the
    /// strict-keys check; JS objects keep insertion order, a Swift dictionary does not.
    static func sortedKeys(_ fields: [String: JSONValue]) -> [String] { fields.keys.sorted() }

    // MARK: -

    private static func containsNonFinite(_ value: JSONValue) -> Bool {
        switch value {
        case .number(let n): !n.isFinite
        case .array(let items): items.contains(where: containsNonFinite)
        case .object(let fields): fields.values.contains(where: containsNonFinite)
        default: false
        }
    }

    private static func write(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += number(n)
        case .string(let s): writeString(s, into: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                write(item, into: &out)
            }
            out += "]"
        case .object(let fields):
            out += "{"
            var first = true
            for key in sortedKeys(fields) {
                if !first { out += "," }
                first = false
                writeString(key, into: &out)
                out += ":"
                write(fields[key]!, into: &out)
            }
            out += "}"
        }
    }

    private static func number(_ n: Double) -> String {
        guard n.isFinite else { return "null" }
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return "\(n)"
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

extension JSONValue {
    /// The Foundation shape (`NSNumber`, `NSString`, ...) `JSONSerialization` writes.
    var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case .bool(let b): b
        case .number(let n): n
        case .string(let s): s
        case .array(let items): items.map(\.foundationObject)
        case .object(let fields): fields.mapValues(\.foundationObject)
        }
    }

    var objectFields: [String: JSONValue]? {
        if case .object(let fields) = self { return fields }
        return nil
    }

    var intValue: Int? {
        if case .number(let n) = self, n == n.rounded(), abs(n) < 9_007_199_254_740_992 { return Int(n) }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    /// Parses JSON text; nil when it is not valid JSON.
    static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// JSON text of this value, compact.
    var compactText: String { AppJSON.compact(self) }
}

/// A token bucket: `perSecond` tokens a second up to `burst`, taken one at a time.
struct AppTokenBucket {
    private let perSecond: Double
    private let burst: Double
    private var tokens: Double
    private var last: Date
    private let now: () -> Date

    init(perSecond: Double, burst: Double, now: @escaping () -> Date = Date.init) {
        self.perSecond = perSecond
        self.burst = burst
        self.tokens = burst
        self.now = now
        self.last = now()
    }

    mutating func take() -> Bool {
        let current = now()
        tokens = min(burst, tokens + current.timeIntervalSince(last) * perSecond)
        last = current
        guard tokens >= 1 else { return false }
        tokens -= 1
        return true
    }
}
