import Foundation

// @MENTION AUTOCOMPLETE in the chat composer.
//
// A port of `client/src/lib/mention-autocomplete.ts` (and Android's
// `MentionAutocomplete.kt`), rule for rule. The wire format of a mention is
// `@username`, resolved server-side against the channel's members
// (`resolveMentions` in `server/src/services/messages.ts`), so the only thing
// the composer has to get right is which username lands in the text: a display
// name in the text is a name that mentions nobody.
//
// A SwiftUI `TextField` on iOS 17 does not expose the caret, so the token is
// looked for at the END of the draft, which is where somebody typing a mention
// on a phone is almost always writing. A mention in the middle of a sentence is
// still typed the way it always was; it just does not get the strip.

struct MentionCandidate: Identifiable, Equatable, Sendable {
    let id: String
    let displayName: String
    /// Nil for an account that never claimed one; such a member cannot be mentioned.
    let username: String?
    let avatarUrl: String?
}

/// The `@token` being typed: `start` is the `@`, `end` is the caret.
struct MentionQuery: Equatable, Sendable {
    let start: Int
    let end: Int
    let query: String
}

enum MentionAutocomplete {
    /// Same ceiling as `usernameSchema`; past it the token cannot be a handle.
    static let maxQueryLength = 32
    /// Long lists are a scroll, not a picker.
    static let maxSuggestions = 8

    /// Mirrors the username half of `MENTION_PATTERN`.
    private static func isTokenChar(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber || c == "_")
    }

    /// The active token at `caret` (a character offset), or nil when the caret is
    /// not inside one. The `@` must start a word: `you@example.com` is an address.
    static func find(in value: String, caret: Int) -> MentionQuery? {
        let chars = Array(value)
        let end = max(0, min(caret, chars.count))
        var index = end
        while index > 0 {
            if end - index > maxQueryLength { return nil }
            let char = chars[index - 1]
            if char == "@" {
                if index > 1, !chars[index - 2].isWhitespace { return nil }
                return MentionQuery(start: index - 1, end: end, query: String(chars[index..<end]))
            }
            if !isTokenChar(char) { return nil }
            index -= 1
        }
        return nil
    }

    /// The token at the end of the draft, where a phone user is typing.
    static func findAtEnd(of value: String) -> MentionQuery? {
        find(in: value, caret: value.count)
    }

    /// Members matching the token, best first. Anyone without a username is
    /// dropped: there is nothing to insert for them.
    static func filter(_ candidates: [MentionCandidate], query: String, limit: Int = maxSuggestions) -> [MentionCandidate] {
        let needle = query.lowercased()
        // Only the best `limit` are kept, in order, as the candidates go by: a
        // server's member list is not paged, and sorting all of it on every
        // keystroke to show eight is work for nothing.
        var best: [(rank: Int, key: String, candidate: MentionCandidate)] = []
        for candidate in candidates {
            guard let username = candidate.username?.lowercased(), !username.isEmpty else { continue }
            let displayName = candidate.displayName.lowercased()
            let rank: Int
            if needle.isEmpty {
                rank = 1
            } else if username.hasPrefix(needle) {
                rank = 0
            } else if displayName.hasPrefix(needle) {
                rank = 1
            } else if username.contains(needle) || displayName.contains(needle) {
                rank = 2
            } else {
                continue
            }
            // Ties break on the name as a person reads it, accents folded.
            let key = candidate.displayName.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            if best.count == limit, let last = best.last, (rank, key) >= (last.rank, last.key) { continue }
            var at = best.count
            while at > 0, (rank, key) < (best[at - 1].rank, best[at - 1].key) { at -= 1 }
            best.insert((rank, key, candidate), at: at)
            if best.count > limit { best.removeLast() }
        }
        return best.map(\.candidate)
    }

    /// Replace the active token with `@username ` and keep the rest of the draft.
    static func apply(to value: String, active: MentionQuery, username: String) -> (value: String, caret: Int) {
        let chars = Array(value)
        let inserted = "@\(username) "
        let next = String(chars[0..<active.start]) + inserted + String(chars[active.end...])
        return (next, active.start + inserted.count)
    }
}

extension ServerMember {
    var mentionCandidate: MentionCandidate {
        MentionCandidate(id: id, displayName: displayName, username: username, avatarUrl: avatarUrl)
    }
}

extension PublicUser {
    var mentionCandidate: MentionCandidate {
        MentionCandidate(id: id, displayName: displayName, username: username, avatarUrl: avatarUrl)
    }
}
