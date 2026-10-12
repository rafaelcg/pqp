import Foundation

// CONVERSAS: the pure rules behind the conversation list and the phone tabs.
//
// Ports of the web client's `conversation-list.ts`, `conversation-typing.ts`,
// `phone-tabs.ts`, `conversations-config.ts` and `formatMessagePreview`
// (client/src/lib/), so the three clients agree on what a row says, what
// "unread" counts and which tab the app opens on. No SwiftUI in here: every
// rule is a unit test.

/// What `channel-activity` says about a conversation's newest message.
/// `preview` is nil when the reader has in-app previews off.
struct ConversationActivityPreview: Hashable, Sendable {
    let authorId: String
    let authorName: String
    let preview: String?
}

// MARK: - The two switches

/// `GET /api/dms/config`: `{home, phoneTabs}`.
///
/// - `home` (`conversations_home`): WhatsApp-style rows, Nova conversa with
///   friends listed, and Mensagem on member rows.
/// - `phoneTabs` (`conversations_home_phone_tabs`): the bottom bar Conversas /
///   Servidores / Tu instead of the hub.
///
/// Anything but an explicit `true` is off, and `phoneTabs` never outlives
/// `home`, so an API that forgot one half cannot turn on half a layout. An
/// older API answers 404, which is off: today's hub, unchanged.
struct DmsConfig: Codable, Hashable, Sendable {
    var home: Bool
    var phoneTabs: Bool

    static let off = DmsConfig(home: false, phoneTabs: false)

    init(home: Bool, phoneTabs: Bool) {
        self.home = home
        self.phoneTabs = home && phoneTabs
    }

    private enum CodingKeys: String, CodingKey { case home, phoneTabs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let home = (try? c.decodeIfPresent(Bool.self, forKey: .home)) ?? nil
        let tabs = (try? c.decodeIfPresent(Bool.self, forKey: .phoneTabs)) ?? nil
        self.init(home: home == true, phoneTabs: tabs == true)
    }

    // The last answer, kept on the device so the second launch draws the
    // right shell on its first frame instead of the hub and then the tabs.
    // The live read replaces it within a second of the shell appearing.
    static let defaultsKey = "pqp.dmsConfig"

    static func load(from defaults: UserDefaults = .standard) -> DmsConfig {
        switch defaults.string(forKey: defaultsKey) {
        case "home+tabs": DmsConfig(home: true, phoneTabs: true)
        case "home": DmsConfig(home: true, phoneTabs: false)
        default: .off
        }
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(phoneTabs ? "home+tabs" : (home ? "home" : "off"), forKey: Self.defaultsKey)
    }
}

// MARK: - Phone tabs

enum PhoneTab: String, CaseIterable, Sendable {
    case conversas
    case servidores
    case tu

    static let defaultsKey = "pqp.phoneTab"

    static func stored(in defaults: UserDefaults = .standard) -> PhoneTab? {
        defaults.string(forKey: defaultsKey).flatMap(PhoneTab.init(rawValue:))
    }

    func store(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }

    /// Which tab the app opens on.
    ///
    /// The last tab used. Nobody's habit moves until they move it, so an
    /// account with no stored choice starts on Servidores, which is what the
    /// app has always opened on. Somebody who came FOR a person (a DM push, a
    /// `/app/dm/...` link) lands on Conversas, where the thing they tapped is.
    static func landing(stored: PhoneTab?, arrivedForPerson: Bool) -> PhoneTab {
        if arrivedForPerson { return .conversas }
        return stored ?? .servidores
    }
}

// MARK: - The list

enum ConversationFilter: String, CaseIterable, Sendable {
    case all
    case unread
    case groups
}

enum ConversationList {
    /// The server caps a conversation's unread count at 100 (the badge says
    /// 99+ past that), and a live bump must not count past it either.
    static let unreadCap = 100

    /// Lowercase, accents folded: "joão" is found by "joao", the way people type.
    static func fold(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The search box: anybody's display name, username or tag in the
    /// conversation, or the title the row shows. Empty matches everything.
    static func matches(_ conversation: DmSummary, query: String) -> Bool {
        let needle = fold(query)
        guard !needle.isEmpty else { return true }
        if fold(conversation.title).contains(needle) { return true }
        return conversation.participants.contains { person in
            fold(person.displayName).contains(needle)
                || (person.username.map { fold($0).contains(needle) } ?? false)
                || (person.tag.map { fold($0).contains(needle) } ?? false)
        }
    }

    static func hasUnread(_ conversation: DmSummary) -> Bool {
        conversation.unread.count > 0
    }

    /// The list as drawn: search, then the chip.
    static func filter(
        _ list: [DmSummary],
        query: String,
        filter: ConversationFilter
    ) -> [DmSummary] {
        list.filter { conversation in
            guard matches(conversation, query: query) else { return false }
            switch filter {
            case .all: return true
            case .unread: return hasUnread(conversation)
            case .groups: return conversation.kind == "group"
            }
        }
    }

    /// Fixadas and Recentes. Pinned rows keep the pin order (the web rail's
    /// order, so the two places agree); the rest keep recency order.
    static func splitPinned(
        _ list: [DmSummary],
        pinnedIds: [String]
    ) -> (pinned: [DmSummary], recent: [DmSummary]) {
        let byId = Dictionary(list.map { ($0.channelId, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        var pinned: [DmSummary] = []
        for id in pinnedIds where !seen.contains(id) {
            if let conversation = byId[id] {
                pinned.append(conversation)
                seen.insert(id)
            }
        }
        return (pinned, list.filter { !seen.contains($0.channelId) })
    }

    /// The tab badge: how many CONVERSATIONS are waiting, not how many
    /// messages. Three people writing forty lines is 3.
    static func waitingCount(_ list: [DmSummary]) -> Int {
        list.filter(hasUnread).count
    }

    /// `channel-activity` for a conversation, folded into the list: one more
    /// unread (capped like the server's count), the preview when the frame
    /// carries one, and the row moved to the top. Nil when the conversation is
    /// not in the list, which is the caller's cue to refetch: only the server
    /// knows who is in a conversation this device has never seen.
    static func applyingActivity(
        _ list: [DmSummary],
        channelId: String,
        mention: Bool,
        preview: ConversationActivityPreview?,
        now: Date = Date()
    ) -> [DmSummary]? {
        guard let index = list.firstIndex(where: { $0.channelId == channelId }) else { return nil }
        var next = list
        var row = next[index]
        row.lastMessageAt = now
        row.unread = DmUnread(
            count: min(unreadCap, row.unread.count + 1),
            mentions: min(unreadCap, row.unread.mentions + (mention ? 1 : 0))
        )
        if let preview {
            if let text = preview.preview {
                row.lastMessage = DmLastMessage(
                    authorId: preview.authorId,
                    authorName: preview.authorName,
                    preview: text,
                    isAttachment: false,
                    isGif: false
                )
            } else {
                // Previews are off for this reader: say nothing rather than
                // keep a line that is no longer the newest message.
                row.lastMessage = nil
            }
        }
        next[index] = row
        return sortedByRecency(next)
    }

    /// A message this device saw in full (its own send, or one in the open
    /// conversation): the row's preview and time follow it, with no unread,
    /// because the reader is looking at it or wrote it.
    static func applyingMessage(_ list: [DmSummary], message: Message) -> [DmSummary]? {
        guard let index = list.firstIndex(where: { $0.channelId == message.channelId }) else { return nil }
        var next = list
        var row = next[index]
        row.lastMessageAt = message.createdAt
        row.lastMessage = MessagePreviewText.preview(of: message)
        next[index] = row
        return sortedByRecency(next)
    }

    /// Freshest first, the way the server orders the list. Stable for ties.
    static func sortedByRecency(_ list: [DmSummary]) -> [DmSummary] {
        list.enumerated().sorted { lhs, rhs in
            let left = lhs.element.lastMessageAt ?? .distantPast
            let right = rhs.element.lastMessageAt ?? .distantPast
            if left != right { return left > right }
            return lhs.offset < rhs.offset
        }
        .map(\.element)
    }
}

// MARK: - The preview line

enum MessagePreviewText {
    static let maxCharacters = 140

    /// The row's second line: the server's preview with the reader's own
    /// relationship to it added. "tu: " on your own message, the author's
    /// first name in a group, nothing in a 1:1.
    static func line(for conversation: DmSummary, viewerId: String?) -> String? {
        guard let message = conversation.lastMessage else { return nil }
        let body: String
        if message.isAttachment, message.isVoice == true, let ms = message.voiceDurationMs {
            body = String(localized: "Voice message · \(duration(ms))")
        } else if message.isAttachment {
            body = message.isGif ? String(localized: "Sent a GIF") : String(localized: "Sent a file")
        } else {
            body = message.preview
        }
        if let viewerId, message.authorId == viewerId {
            return String(localized: "you: \(body)")
        }
        if conversation.kind == "group" {
            let first = message.authorName.split(separator: " ").first.map(String.init) ?? message.authorName
            return "\(first.isEmpty ? message.authorName : first): \(body)"
        }
        return body
    }

    /// `0:12`, `1:05`. Voice notes are short; there is no hour column.
    static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds) / 1000
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// A full message turned into the list's preview, for a message the
    /// device saw itself rather than through `channel-activity`. The same
    /// redaction as `buildMessagePreview` in packages/shared/src/dm-preview.ts,
    /// so a row updated live reads exactly like the row after a reload.
    static func preview(of message: Message) -> DmLastMessage {
        let stripped = stripMarkdown(message.body)
        if stripped.isEmpty, let first = message.attachments.first {
            let voiceMs = message.attachments.compactMap { $0.voice?.durationMs }.first
            return DmLastMessage(
                authorId: message.authorId,
                authorName: message.authorName,
                preview: "",
                isAttachment: true,
                isGif: voiceMs == nil && first.contentType == "image/gif",
                isVoice: voiceMs != nil,
                voiceDurationMs: voiceMs
            )
        }
        return DmLastMessage(
            authorId: message.authorId,
            authorName: message.authorName,
            preview: truncate(stripped),
            isAttachment: false,
            isGif: false
        )
    }

    private static let markdownPasses: [(String, String, NSRegularExpression.Options)] = [
        (#"\[([^\]]+)\]\([^)]*\)"#, "$1", []),
        (#"(\*\*\*|___)([^*_]+)\1"#, "$2", []),
        (#"(\*\*|__)([^*_]+)\1"#, "$2", []),
        (#"(\*|_)([^*_]+)\1"#, "$2", []),
        (#"~~([^~]+)~~"#, "$1", []),
        (#"`([^`]+)`"#, "$1", []),
        (#"^>\s?"#, "", [.anchorsMatchLines]),
    ]

    static func stripMarkdown(_ body: String) -> String {
        var text = body
        for (pattern, template, options) in markdownPasses {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
            let range = NSRange(text.startIndex..., in: text)
            text = regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
        }
        return text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .joined(separator: " ")
    }

    static func truncate(_ text: String) -> String {
        guard text.count > maxCharacters else { return text }
        let cut = text.prefix(maxCharacters - 1)
        return cut.trimmingCharacters(in: .whitespaces) + "…"
    }
}

// MARK: - Typing in the list

/// Who is typing in which conversation, for the LIST.
///
/// The server sends a conversation's `typing-broadcast` to every participant,
/// not only to sockets that have it open (Conversas S2), so a row can say
/// "digitando…". Same five second life as the open channel's line; a message
/// from the typist ends it at once. Own frames are dropped: the viewer typing
/// on another device is not news.
struct ConversationTyping: Equatable, Sendable {
    static let ttl: TimeInterval = 5

    private struct Typist: Equatable, Sendable {
        let name: String
        let expiresAt: Date
    }

    /// channelId -> userId -> typist
    private var typing: [String: [String: Typist]] = [:]

    /// Returns true when what the list draws changed. A repeat frame from
    /// somebody already typing only pushes their expiry out.
    @discardableResult
    mutating func note(channelId: String, userId: String, name: String, viewerId: String?, now: Date = Date()) -> Bool {
        guard userId != viewerId else { return false }
        let known = typing[channelId]?[userId]
        typing[channelId, default: [:]][userId] = Typist(name: name, expiresAt: now.addingTimeInterval(Self.ttl))
        return !(known.map { $0.name == name && $0.expiresAt > now } ?? false)
    }

    /// Their message landed: they are not typing any more.
    @discardableResult
    mutating func clear(channelId: String, userId: String) -> Bool {
        guard typing[channelId]?.removeValue(forKey: userId) != nil else { return false }
        if typing[channelId]?.isEmpty == true { typing[channelId] = nil }
        return true
    }

    /// Drops everyone whose five seconds ran out. True when anybody left.
    @discardableResult
    mutating func prune(now: Date = Date()) -> Bool {
        var changed = false
        for (channelId, people) in typing {
            let alive = people.filter { $0.value.expiresAt > now }
            if alive.count != people.count {
                changed = true
                typing[channelId] = alive.isEmpty ? nil : alive
            }
        }
        return changed
    }

    /// Names typing in this conversation right now, sorted for a stable line.
    func names(in channelId: String, now: Date = Date()) -> [String] {
        (typing[channelId] ?? [:]).values
            .filter { $0.expiresAt > now }
            .map(\.name)
            .sorted()
    }

    /// When the next typist runs out, so the caller can redraw then.
    var soonestExpiry: Date? {
        typing.values.flatMap(\.values).map(\.expiresAt).min()
    }

    var isEmpty: Bool { typing.isEmpty }
}

// MARK: - Row time

enum ConversationTime {
    /// "20:41" today, "ontem", a weekday inside the week ("sex"), a short date
    /// past that. What WhatsApp trained everybody to read.
    static func label(for date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(Date.FormatStyle(
                date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone
            ))
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return String(localized: "yesterday")
        }
        let startOfToday = calendar.startOfDay(for: now)
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: startOfToday), date >= weekAgo {
            let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .weekday(.abbreviated)
            return date.formatted(style).replacingOccurrences(of: ".", with: "")
        }
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
            .day(.twoDigits).month(.twoDigits)
        return date.formatted(style)
    }
}

/// How often the Conversas tab re-reads which friends are online.
enum ConversasPresence {
    static let pollSeconds = 30
}
