import Foundation

/// `#channel` inside a Baú post, the phone's half of the web's
/// `client/src/lib/community-home/channel-refs.ts`. Same grammar, same rules;
/// keep the two (and `BauChannelRefs.kt`) in step.
///
/// The API stores `<#channelId>`, never the name, so a rename does not break
/// the link and a body that holds only an id cannot leak a private channel's
/// name. The name comes from the channel list this account already loads for
/// the server, which is the list it is allowed to see: an id that is not in it
/// is drawn as `.unavailable`, with no name and no link.
///
/// Old posts that say `#geral` in plain words become a link too when exactly
/// one visible channel carries that name.
enum BauChannelRefs {
    enum Part: Equatable, Sendable {
        case text(String)
        case link(id: String, name: String)
        case unavailable(id: String)
    }

    static let maxSuggestions = 8
    private static let maxQuery = 100

    // swiftlint:disable:next force_try
    private static let refPattern = try! NSRegularExpression(
        pattern: "<#([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>"
    )
    /// The character before the `#` is captured instead of looked behind:
    /// `page#anchor`, `<#id>` and `&#39;` are ruled out by what it is.
    // swiftlint:disable:next force_try
    private static let plainHash = try! NSRegularExpression(
        pattern: "(^|[^A-Za-z0-9_<#&/])#([A-Za-z0-9_-]+)"
    )

    static func ref(_ channelId: String) -> String { "<#\(channelId.lowercased())>" }

    /// Categories are folders, not places to send somebody.
    static func referenceable(_ channels: [Channel]) -> [Channel] {
        channels.filter { !$0.isCategory }
    }

    private struct Names {
        var unique: [String: Channel] = [:]
        var ambiguous: Set<String> = []
        var isEmpty: Bool { unique.isEmpty && ambiguous.isEmpty }
    }

    private static func names(_ channels: [Channel]) -> Names {
        var out = Names()
        for channel in referenceable(channels) {
            let key = channel.name.lowercased()
            if out.ambiguous.contains(key) { continue }
            if out.unique[key] != nil {
                out.unique[key] = nil
                out.ambiguous.insert(key)
            } else {
                out.unique[key] = channel
            }
        }
        return out
    }

    /// A stored body cut into text (id nil) and `<#id>` references (ids lowercased).
    private static func splitRefs(_ text: String) -> [(id: String?, raw: String)] {
        var out: [(id: String?, raw: String)] = []
        var last = text.startIndex
        let whole = NSRange(text.startIndex..., in: text)
        for match in refPattern.matches(in: text, range: whole) {
            guard let range = Range(match.range, in: text),
                  let idRange = Range(match.range(at: 1), in: text) else { continue }
            if range.lowerBound > last { out.append((nil, String(text[last..<range.lowerBound]))) }
            out.append((String(text[idRange]).lowercased(), String(text[range])))
            last = range.upperBound
        }
        if last < text.endIndex { out.append((nil, String(text[last...]))) }
        return out
    }

    private static func splitPlain(_ text: String, _ names: Names) -> [Part] {
        var parts: [Part] = []
        var last = text.startIndex
        let whole = NSRange(text.startIndex..., in: text)
        for match in plainHash.matches(in: text, range: whole) {
            guard let full = Range(match.range, in: text),
                  let before = Range(match.range(at: 1), in: text),
                  let nameRange = Range(match.range(at: 2), in: text),
                  let channel = names.unique[String(text[nameRange]).lowercased()] else { continue }
            let start = before.upperBound
            if start > last { parts.append(.text(String(text[last..<start]))) }
            parts.append(.link(id: channel.id, name: channel.name))
            last = full.upperBound
        }
        if last < text.endIndex { parts.append(.text(String(text[last...]))) }
        return parts.isEmpty ? [.text(text)] : parts
    }

    /// The pieces of a body to draw.
    static func parse(_ text: String, channels: [Channel]) -> [Part] {
        if text.isEmpty { return [] }
        let visible = Dictionary(
            referenceable(channels).map { ($0.id.lowercased(), $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let names = names(channels)
        var out: [Part] = []
        for (id, raw) in splitRefs(text) {
            if let id {
                if let channel = visible[id] {
                    out.append(.link(id: channel.id, name: channel.name))
                } else {
                    out.append(.unavailable(id: id))
                }
            } else if names.isEmpty {
                out.append(.text(raw))
            } else {
                out.append(contentsOf: splitPlain(raw, names))
            }
        }
        return out
    }

    // MARK: Composer

    struct Query: Equatable {
        /// From the `#` to the end of the text.
        let range: Range<String.Index>
        /// What has been typed after the `#`, possibly empty.
        let query: String
    }

    private static func isNameChar(_ c: Character) -> Bool {
        guard c.isASCII else { return false }
        return c.isLetter || c.isNumber || c == "_" || c == "-"
    }

    /// The `#token` the text ends in, or nil. The `#` has to start a word.
    /// A SwiftUI `TextField` does not expose its caret, so this follows the end
    /// of the text, which is where a phone keyboard is almost always typing.
    static func findQuery(_ value: String) -> Query? {
        var index = value.endIndex
        var length = 0
        while index > value.startIndex {
            let before = value.index(before: index)
            let char = value[before]
            if char == "#" {
                if before > value.startIndex {
                    let preceding = value[value.index(before: before)]
                    if !preceding.isWhitespace { return nil }
                }
                return Query(range: before..<value.endIndex, query: String(value[index...]))
            }
            if !isNameChar(char) { return nil }
            length += 1
            if length > maxQuery { return nil }
            index = before
        }
        return nil
    }

    /// Prefix matches first, then substring matches, each in sidebar order.
    static func filter(_ channels: [Channel], query: String, limit: Int = maxSuggestions) -> [Channel] {
        let needle = query.lowercased()
        var scored: [(channel: Channel, rank: Int, order: Int)] = []
        for (order, channel) in referenceable(channels).enumerated() {
            let name = channel.name.lowercased()
            if needle.isEmpty || name.hasPrefix(needle) {
                scored.append((channel, 0, order))
            } else if name.contains(needle) {
                scored.append((channel, 1, order))
            }
        }
        scored.sort { ($0.rank, $0.order) < ($1.rank, $1.order) }
        return scored.prefix(limit).map(\.channel)
    }

    /// Replace the active token. A shared name goes in as the raw `<#id>`.
    static func apply(to value: String, query: Query, channel: Channel, channels: [Channel]) -> String {
        let ambiguous = names(channels).ambiguous.contains(channel.name.lowercased())
        let token = ambiguous ? ref(channel.id) : "#\(channel.name)"
        return String(value[..<query.range.lowerBound]) + token + " "
    }

    /// Stored `<#id>` to readable `#name`, where the name is unique and visible.
    static func toDisplay(_ stored: String, channels: [Channel]) -> String {
        let visible = Dictionary(
            referenceable(channels).map { ($0.id.lowercased(), $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let names = names(channels)
        return splitRefs(stored).map { id, raw in
            guard let id else { return raw }
            guard let channel = visible[id], names.unique[channel.name.lowercased()] != nil else {
                return ref(id)
            }
            return "#\(channel.name)"
        }.joined()
    }

    /// Readable `#name` to stored `<#id>` for every name that matches one channel.
    static func toStored(_ display: String, channels: [Channel]) -> String {
        let names = names(channels)
        if names.isEmpty { return display }
        return splitRefs(display).map { id, raw in
            if let id { return ref(id) }
            return splitPlain(raw, names).map { part -> String in
                switch part {
                case .link(let id, _): return ref(id)
                case .text(let value): return value
                case .unavailable: return ""
                }
            }.joined()
        }.joined()
    }
}
