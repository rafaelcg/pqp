import Foundation

/// Any JSON value, held as data and written back unchanged.
///
/// A story waiting to post keeps its layers in the shape the server takes
/// (`StoryLayerInput` encoded), so they can sit on disk across a relaunch and
/// still be sent exactly as they were built, without a second decoder for a
/// type that was only ever written.
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }

    /// Whatever is encodable, as a value. Numbers come back as `Double`, which
    /// writes an integral one without a fraction, so `byteSize: 120` stays `120`.
    init(encoding value: some Encodable) throws {
        let data = try Coding.encoder.encode(value)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    subscript(key: String) -> JSONValue? {
        get {
            if case .object(let fields) = self { return fields[key] }
            return nil
        }
        set {
            guard case .object(var fields) = self else { return }
            fields[key] = newValue
            self = .object(fields)
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}
