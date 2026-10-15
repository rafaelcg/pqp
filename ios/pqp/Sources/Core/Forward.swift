import Foundation

// ENCAMINHAR (forward), the iOS half of `packages/shared/src/forward.ts`.
//
// A forward is an ordinary message with a `forward` snapshot on it: where it
// came from, a title, an excerpt, maybe a picture. It rides on every read the
// app already makes (history, `message-broadcast`, pins), so decoding it on
// `Message` is what makes the card appear in channels, DMs, threads and forum
// posts alike. The contract and the rules are in `docs/FORWARD.md`; this file
// is the Swift twin of the shared schema plus the client's own decisions: what
// the card says, what a tap does, who the picker offers, what a refusal says.
//
// Everything here is free of SwiftUI and the session, because the places a
// bug hides are all pure (the fallback body that must be hidden byte for
// byte, an origin that is ours or is not, a ranking, a refusal) and pure
// functions are the only thing a unit test can see.

// MARK: - The snapshot on a message

/// `messageForwardSchema`. Strict where the shared schema is strict and
/// lenient where it says so: a version this build does not know, or a snapshot
/// that fails today's parse, is NOT a forward at all, which is the
/// `.catch(null)` the schema applies. The message then shows its `body`.
struct MessageForward: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable {
        case bauPost = "bau_post"
        case message
    }

    enum MediaKind: String, Codable, Sendable {
        case image, video, youtube, embed
    }

    /// The snapshot version this build draws.
    static let supportedVersion = 1

    let v: Int
    let kind: Kind
    let sourceServerId: String
    let sourceServerName: String
    /// Root-relative like `servers.icon_url`, or nil.
    let sourceServerIconUrl: String?
    /// `message` only, without the `#`.
    let sourceChannelName: String?
    /// The Baú post id, or the message id.
    let sourceId: String
    let authorDisplayName: String?
    /// `bau_post` only.
    let title: String?
    /// Plain text, never re-resolved: a mention in it is text and pings nobody.
    let excerpt: String
    /// Only ever a stable public URL (a YouTube poster), never a signed one.
    let mediaThumbUrl: String?
    let mediaKind: MediaKind?
    /// Absolute, on the instance's own origin.
    let url: String
    let createdAt: String
    /// Members-only post or private-channel message: it can only be forwarded
    /// again inside `sourceServerId`.
    let restricted: Bool
    /// With `restricted`: the only server this card may be forwarded into
    /// (never a conversation). It can differ from `sourceServerId`: a free
    /// card forwarded into a private channel of another server is restricted
    /// to that one. Absent on a restricted card from an older build.
    let restrictedToServerId: String?

    /// Where a forward of this card may go, or nil when anywhere: the named
    /// server, else the source's for an older restricted card.
    var stayInServerId: String? {
        guard restricted else { return nil }
        return restrictedToServerId ?? sourceServerId
    }

    private enum CodingKeys: String, CodingKey {
        case v, kind, sourceServerId, sourceServerName, sourceServerIconUrl
        case sourceChannelName, sourceId, authorDisplayName, title, excerpt
        case mediaThumbUrl, mediaKind, url, createdAt, restricted, restrictedToServerId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        guard v == Self.supportedVersion else {
            throw DecodingError.dataCorruptedError(
                forKey: .v, in: c, debugDescription: "A snapshot version this build does not draw"
            )
        }
        kind = try c.decode(Kind.self, forKey: .kind)
        sourceServerId = try c.decode(String.self, forKey: .sourceServerId)
        sourceServerName = try c.decode(String.self, forKey: .sourceServerName)
        sourceServerIconUrl = try c.decodeIfPresent(String.self, forKey: .sourceServerIconUrl)
        sourceChannelName = try c.decodeIfPresent(String.self, forKey: .sourceChannelName)
        sourceId = try c.decode(String.self, forKey: .sourceId)
        authorDisplayName = try c.decodeIfPresent(String.self, forKey: .authorDisplayName)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        excerpt = try c.decode(String.self, forKey: .excerpt)
        mediaThumbUrl = try c.decodeIfPresent(String.self, forKey: .mediaThumbUrl)
        // A media kind added later costs the glyph, not the card.
        mediaKind = (try? c.decodeIfPresent(MediaKind.self, forKey: .mediaKind)) ?? nil
        url = try c.decode(String.self, forKey: .url)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        restricted = (try? c.decodeIfPresent(Bool.self, forKey: .restricted)) ?? false
        restrictedToServerId = (try? c.decodeIfPresent(String.self, forKey: .restrictedToServerId)) ?? nil
    }

    init(
        kind: Kind,
        sourceServerId: String,
        sourceServerName: String,
        sourceServerIconUrl: String? = nil,
        sourceChannelName: String? = nil,
        sourceId: String,
        authorDisplayName: String? = nil,
        title: String? = nil,
        excerpt: String,
        mediaThumbUrl: String? = nil,
        mediaKind: MediaKind? = nil,
        url: String,
        createdAt: String = "2026-10-15T12:00:00.000Z",
        restricted: Bool = false,
        restrictedToServerId: String? = nil
    ) {
        v = Self.supportedVersion
        self.kind = kind
        self.sourceServerId = sourceServerId
        self.sourceServerName = sourceServerName
        self.sourceServerIconUrl = sourceServerIconUrl
        self.sourceChannelName = sourceChannelName
        self.sourceId = sourceId
        self.authorDisplayName = authorDisplayName
        self.title = title
        self.excerpt = excerpt
        self.mediaThumbUrl = mediaThumbUrl
        self.mediaKind = mediaKind
        self.url = url
        self.createdAt = createdAt
        self.restricted = restricted
        self.restrictedToServerId = restrictedToServerId
    }
}

// MARK: - The fallback body

enum ForwardFallback {
    /// `FORWARD_FALLBACK_PREFIX`.
    static let prefix = "Encaminhado: "
    /// `FORWARD_FALLBACK_TEXT_MAX`, counted in UTF-16 code units exactly as the
    /// shared helper's `String.length` and `slice` do, so an emoji at the cut
    /// lands on the same side on every platform.
    private static let textMax = 140

    /// `forwardFallbackBody`: `Encaminhado: <title or excerpt> <url>`, what the
    /// server writes as the body when the forwarder added no words, so a
    /// client that predates the card still shows something useful.
    static func body(for forward: MessageForward) -> String {
        let title = forward.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let excerpt = forward.excerpt.trimmingCharacters(in: .whitespacesAndNewlines)
        let pick = !title.isEmpty ? title : (!excerpt.isEmpty ? excerpt : forward.sourceServerName)
        let raw = pick
            .replacing(/\s+/, with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let units = Array(raw.utf16)
        let text: String
        if units.count > textMax {
            let cut = String(decoding: units[0..<(textMax - 3)], as: UTF16.self)
            text = cut.trimmingTrailingWhitespace() + "..."
        } else {
            text = raw
        }
        return "\(prefix)\(text) \(forward.url)"
    }

    /// `isForwardFallbackBody`: compared against the snapshot, so a comment
    /// that merely starts with the same word is never hidden.
    static func isFallback(_ body: String, for forward: MessageForward) -> Bool {
        body == Self.body(for: forward)
    }
}

private extension String {
    func trimmingTrailingWhitespace() -> String {
        var scalars = Substring(self)
        while let last = scalars.last, last.isWhitespace { scalars.removeLast() }
        return String(scalars)
    }
}

extension Message {
    /// The words to draw above the card: the forwarder's comment, or nothing
    /// when the body is only the fallback an old client reads.
    var forwardComment: String {
        guard let forward else { return body }
        return ForwardFallback.isFallback(body, for: forward) ? "" : body
    }

    /// A forward whose body is the fallback. The fallback carries the same
    /// permalink the card opens, so it must not also earn a Baú card.
    var hasForwardFallbackBody: Bool {
        guard let forward else { return false }
        return ForwardFallback.isFallback(body, for: forward)
    }
}

// MARK: - What the card says and does

/// The card, reduced to what a view draws. Pure so the states (a Baú post, a
/// channel message, a card with no picture, an empty excerpt, an unreadable
/// link) can be asserted without a simulator.
struct ForwardCardContent: Equatable, Sendable {
    enum Source: Equatable, Sendable {
        /// "Encaminhado de <server> · Baú"
        case bau(server: String)
        /// "Encaminhado de <server> · #canal"
        case channel(server: String, channel: String)
        /// A message snapshot with no channel name: just the server.
        case server(String)
    }

    let source: Source
    let iconPath: String?
    /// The heading: a post's title, or a message's author when it has none.
    let heading: String?
    let excerpt: String
    let thumbnail: URL?
    /// A glyph for the media kind, when there is media and no picture.
    let glyph: String?
    let restricted: Bool

    init(_ forward: MessageForward) {
        let channel = forward.sourceChannelName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch forward.kind {
        case .bauPost:
            source = .bau(server: forward.sourceServerName)
        case .message:
            source = channel.isEmpty
                ? .server(forward.sourceServerName)
                : .channel(server: forward.sourceServerName, channel: channel)
        }
        iconPath = forward.sourceServerIconUrl
        let title = forward.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let author = forward.authorDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        heading = Self.plain(!title.isEmpty ? title : (author.isEmpty ? nil : author))
        excerpt = Self.plain(forward.excerpt.trimmingCharacters(in: .whitespacesAndNewlines)) ?? ""
        thumbnail = Self.loadable(forward.mediaThumbUrl)
        if thumbnail == nil, let kind = forward.mediaKind {
            glyph = switch kind {
            case .image: "photo"
            case .video, .youtube: "play.rectangle.fill"
            case .embed: "link"
            }
        } else {
            glyph = nil
        }
        restricted = forward.restricted
    }

    /// The snapshot is plain text, but a server that has not been fixed yet may
    /// leave chat markup in it (`<@uuid>`, `<@&uuid>`, `<#uuid>`, `<:name:uuid>`).
    /// The card never shows ids: a person becomes "@alguém", a role "@cargo", a
    /// channel "#canal", a custom emoji ":name:". Nothing here is resolved to a
    /// real account, so nothing in the card can read as, or act as, a mention.
    static func plain(_ text: String?) -> String? {
        guard var text, !text.isEmpty else { return text }
        let id = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        text = text.replacingOccurrences(of: "<@&\(id)>", with: "@" + String(localized: "role"), options: .regularExpression)
        text = text.replacingOccurrences(of: "<@!?\(id)>", with: "@" + String(localized: "someone"), options: .regularExpression)
        text = text.replacingOccurrences(of: "<#\(id)>", with: "#" + String(localized: "channel"), options: .regularExpression)
        text = text.replacingOccurrences(of: "<a?:([A-Za-z0-9_]+):\(id)>", with: ":$1:", options: .regularExpression)
        return text
    }

    /// https only; plain http is a debug build talking to the local stack
    /// (ATS refuses it on a release build anyway).
    static func loadable(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, let url = URL(string: raw) else { return nil }
        switch url.scheme?.lowercased() {
        case "https": return url
        #if DEBUG
        case "http": return url
        #endif
        default: return nil
        }
    }
}

/// What a tap on the card does.
enum ForwardOpen: Equatable, Sendable {
    /// A place inside this app (a Baú post, a message in a channel).
    case inApp(DeepLinkTarget)
    /// Anything else, in the browser: the public URL, or a source this
    /// account is not a member of, where the web app says what to do.
    case external(URL)
    /// A `url` that is not a web link at all.
    case none

    /// The deep link rule. A URL on this instance whose path is one of the
    /// places the app has a screen for opens in the app, but only for a reader
    /// who belongs to the source server: for anybody else the app would
    /// resolve nothing and the tap would do nothing, so the browser gets it.
    static func resolve(
        _ forward: MessageForward,
        memberServerIds: Set<String>?,
        currentOrigin: String? = BauShare.currentWebOrigin
    ) -> ForwardOpen {
        guard let url = URL(string: forward.url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              components.host?.isEmpty == false
        else { return .none }

        let origin = BauShare.origin(of: components)
        let isOurs = origin.map { BauShare.isOwnInstanceOrigin($0, currentOrigin: currentOrigin) } ?? false
        guard isOurs, let target = DeepLink.target(path: components.path) else {
            return .external(url)
        }
        switch target {
        case .bauPost(let serverId, _), .message(let serverId, _, _):
            // `memberServerIds == nil` is "could not ask": try the app, which
            // is what the link is for. Ids are compared lowercased on both
            // sides, because a shouted link must still find its server.
            if let memberServerIds,
               !memberServerIds.contains(where: { $0.lowercased() == serverId.lowercased() }) {
                return .external(url)
            }
            return .inApp(target)
        default:
            return .external(url)
        }
    }
}

// MARK: - Sources and targets

/// What is being forwarded, as `POST /api/forwards` wants it.
struct ForwardSource: Equatable, Sendable {
    let kind: MessageForward.Kind
    let id: String
    /// A Baú post is addressed with its server.
    let serverId: String?
    /// A one-line description for the picker's header.
    let summary: String
    /// Set when the source can only be forwarded inside this server: a
    /// members-only post, or a forward of a restricted card. The server is the
    /// authority (it refuses with `stays_in_server`); this only keeps the
    /// picker from offering what it already knows will be refused.
    let stayInServerId: String?

    /// A chat message. A forward of a forward carries the original snapshot on
    /// the server, but the request still names the message that carries it.
    static func message(_ message: Message, stayInServerId: String? = nil) -> ForwardSource {
        let forward = message.forward
        let words = message.forwardComment.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary: String
        if let forward, words.isEmpty {
            let title = forward.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            summary = title.isEmpty ? forward.excerpt : title
        } else {
            summary = words.isEmpty ? message.authorName : words
        }
        return ForwardSource(
            kind: .message, id: message.id, serverId: nil, summary: summary,
            stayInServerId: forward?.stayInServerId ?? stayInServerId
        )
    }

    /// Which server a message may only be forwarded inside, mirroring the web:
    /// a restricted card names its own; otherwise a message in a private
    /// channel, or in a channel the loaded list does not hold (a thread or a
    /// forum post, whose own flag may not carry its parent's privacy, or a
    /// list that could not be read), stays in its server. The server enforces
    /// it anyway. A message with no server (nil) has nothing to stay in.
    static func messageStaysIn(
        _ message: Message, serverId: String?, channels: [Channel]?
    ) -> String? {
        if let own = message.forward?.stayInServerId { return own }
        guard let serverId else { return nil }
        guard let channels, let channel = channels.first(where: { $0.id == message.channelId }) else {
            return serverId
        }
        return channel.isPrivate ? serverId : nil
    }

    static func bauPost(_ post: CommunityHomePost) -> ForwardSource {
        let title = post.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let words = post.body ?? post.teaser ?? ""
        return ForwardSource(
            kind: .bauPost, id: post.id, serverId: post.serverId,
            summary: title.isEmpty ? words : title,
            stayInServerId: post.isMembersOnly ? post.serverId : nil
        )
    }
}

/// One place a forward can go.
struct ForwardTarget: Identifiable, Hashable, Codable, Sendable {
    /// The channel (or conversation) id; the only thing the request sends.
    let channelId: String
    let title: String
    /// The server it lives in, or nil for a conversation.
    let serverId: String?
    let serverName: String?
    let iconUrl: String?
    /// Seed for the monogram (a server or conversation id).
    let seed: String
    let isConversation: Bool

    var id: String { channelId }

    /// "# geral" under the server's name; a DM has no second line.
    var subtitle: String? { isConversation ? nil : serverName }
}

/// Ranking and searching for the picker. Pure.
enum ForwardTargets {
    /// Five, as the server caps it.
    static let maxTargets = 5

    /// Whether `target` is a place this source may go. A restricted source
    /// stays in its server: no conversation, no other server.
    static func isAllowed(_ target: ForwardTarget, stayInServerId: String?) -> Bool {
        guard let stayInServerId else { return true }
        return !target.isConversation && target.serverId == stayInServerId
    }

    /// The text a search matches against, folded so "geral" finds "Geral" and
    /// "sao" finds "São".
    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }

    static func matches(_ target: ForwardTarget, query: String) -> Bool {
        let needle = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        if needle.isEmpty { return true }
        return fold(target.title).contains(needle)
            || (target.serverName.map { fold($0).contains(needle) } ?? false)
    }

    /// The list the picker shows: recents first (in the order they were used),
    /// then everything else in the order given, each place once. `recent` is a
    /// list of ids, most recent first; ids that are not in `all` are skipped,
    /// so a left server or a deleted channel never shows up.
    static func ranked(all: [ForwardTarget], recent: [String]) -> (recent: [ForwardTarget], rest: [ForwardTarget]) {
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        var head: [ForwardTarget] = []
        for id in recent {
            guard let target = byId[id], seen.insert(id).inserted else { continue }
            head.append(target)
        }
        let tail = all.filter { seen.insert($0.id).inserted }
        return (head, tail)
    }

    /// Where a send goes next: the picked places with no answer yet, and the
    /// ones refused for a reason worth another try (slow mode, the budget, a
    /// hiccup). A place that has the forward, or was refused for good (no
    /// access, stays in its server), is left alone, so "try again" never
    /// resends to somebody who already has it nor insists on a refusal.
    static func pending(_ selected: [ForwardTarget], outcomes: [String: ForwardOutcome]) -> [ForwardTarget] {
        selected.filter { target in
            guard let outcome = outcomes[target.id] else { return true }
            return outcome.refusal?.isTransient == true
        }
    }

    /// Adds or removes `target`, refusing a sixth.
    static func toggled(_ selected: [ForwardTarget], _ target: ForwardTarget) -> (selected: [ForwardTarget], refusedFull: Bool) {
        if let index = selected.firstIndex(where: { $0.id == target.id }) {
            var copy = selected
            copy.remove(at: index)
            return (copy, false)
        }
        guard selected.count < maxTargets else { return (selected, true) }
        return (selected + [target], false)
    }
}

/// The last places a forward went, kept on the device so the picker opens on
/// the people and channels this account actually forwards to.
struct ForwardRecents: Sendable {
    private let key = "pqp.forward.recents"
    private let limit = 12

    func load(defaults: UserDefaults = .standard) -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    func remember(_ ids: [String], defaults: UserDefaults = .standard) {
        var merged = ids
        for id in load(defaults: defaults) where !merged.contains(id) { merged.append(id) }
        defaults.set(Array(merged.prefix(limit)), forKey: key)
    }
}

// MARK: - The request and its answer

struct ForwardRequest: Encodable, Sendable {
    struct Source: Encodable, Sendable {
        let kind: String
        let id: String
        let serverId: String?
    }

    struct Target: Encodable, Sendable {
        let channelId: String
    }

    let source: Source
    let targets: [Target]
    let comment: String?
    let nonce: String

    init(source: ForwardSource, targets: [ForwardTarget], comment: String, nonce: String) {
        self.source = Source(kind: source.kind.rawValue, id: source.id, serverId: source.serverId)
        self.targets = targets.map { Target(channelId: $0.channelId) }
        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        self.comment = trimmed.isEmpty ? nil : trimmed
        self.nonce = nonce
    }

    /// `FORWARD_COMMENT_MAX`.
    static let commentMax = 1500
}

/// Why one target did not get the forward (`forwardRefusalReasonSchema`).
/// An unknown reason reads as `unavailable`, the catch-all.
enum ForwardRefusal: String, Sendable {
    case noAccess = "no_access"
    case cannotSend = "cannot_send"
    case badTarget = "bad_target"
    case staysInServer = "stays_in_server"
    case unreachable
    case slowMode = "slow_mode"
    case rateLimited = "rate_limited"
    case automod
    case unavailable

    init(wire: String) { self = ForwardRefusal(rawValue: wire) ?? .unavailable }

    /// Worth offering "Try again" for.
    var isTransient: Bool {
        switch self {
        case .slowMode, .rateLimited, .unavailable: true
        default: false
        }
    }

    func copy(retryAfterMs: Int?) -> String {
        switch self {
        case .noAccess: String(localized: "You can't see this channel.")
        case .cannotSend: String(localized: "You can't send messages here.")
        case .badTarget: String(localized: "Messages can't go here.")
        case .staysInServer: String(localized: "This one stays in its own server.")
        case .unreachable: String(localized: "Couldn't send to this person.")
        case .slowMode:
            if let retryAfterMs, retryAfterMs > 0 {
                String(localized: "Slow mode is on here. Try again in \(Int((Double(retryAfterMs) / 1000).rounded(.up)))s.")
            } else {
                String(localized: "Slow mode is on here. Try again in a moment.")
            }
        case .rateLimited: String(localized: "Too many messages. Try again shortly.")
        case .automod: String(localized: "This server's rules blocked it.")
        case .unavailable: String(localized: "Couldn't send right now. Try again.")
        }
    }
}

/// One target's outcome, in the order the request asked.
struct ForwardOutcome: Sendable, Equatable {
    let channelId: String
    let serverId: String?
    let refusal: ForwardRefusal?
    let retryAfterMs: Int?

    var ok: Bool { refusal == nil }
}

/// `POST /api/forwards` answer. Lenient per row: a row this build cannot read
/// is an `unavailable` refusal rather than a failed decode of the whole answer,
/// because the other rows really did go out.
struct ForwardResponse: Decodable, Sendable {
    let outcomes: [ForwardOutcome]

    /// Every field optional and read with `try?`: a row with one unreadable
    /// field is still a row about a target we can name, and that target must
    /// not look unanswered (it may well have gone out). The same `nonce` on a
    /// retry is what keeps a retry from posting a second card.
    private struct Row: Decodable {
        struct Target: Decodable {
            let channelId: String?
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                channelId = (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? nil
            }
            private enum CodingKeys: String, CodingKey { case channelId }
        }

        let ok: Bool?
        let target: Target?
        let channelId: String?
        let serverId: String?
        let reason: String?
        let retryAfterMs: Int?

        private enum CodingKeys: String, CodingKey {
            case ok, target, channelId, serverId, reason, retryAfterMs
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil
            target = (try? c.decodeIfPresent(Target.self, forKey: .target)) ?? nil
            channelId = (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? nil
            serverId = (try? c.decodeIfPresent(String.self, forKey: .serverId)) ?? nil
            reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
            retryAfterMs = (try? c.decodeIfPresent(Int.self, forKey: .retryAfterMs)) ?? nil
        }
    }

    private enum CodingKeys: String, CodingKey { case results }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var list = try c.nestedUnkeyedContainer(forKey: .results)
        var rows: [ForwardOutcome] = []
        while !list.isAtEnd {
            guard let row = try? list.decode(Row.self) else {
                _ = try? list.decode(JSONValue.self)
                continue
            }
            let id = row.channelId ?? row.target?.channelId ?? ""
            // Neither somebody to attach it to nor a plain answer: nothing to
            // record. (A person target has no channel id and is kept.)
            guard !id.isEmpty || row.ok != nil else { continue }
            // An answer that does not say `ok: true` plainly is not claimed as
            // sent; `unavailable` is the catch-all.
            rows.append(ForwardOutcome(
                channelId: id,
                serverId: row.serverId,
                refusal: row.ok == true ? nil : ForwardRefusal(wire: row.reason ?? ""),
                retryAfterMs: row.retryAfterMs
            ))
        }
        outcomes = rows
    }
}

struct ForwardConfig: Decodable, Sendable, Equatable {
    var enabled: Bool

    static let off = ForwardConfig(enabled: false)

    init(enabled: Bool) { self.enabled = enabled }

    private enum CodingKeys: String, CodingKey { case enabled }

    /// Anything but an explicit `true` is off.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = ((try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? nil) == true
    }
}

/// Request-level failures, each with its own sentence. The per-target
/// refusals above are inside a 200.
enum ForwardFailure: Error, Equatable, Sendable {
    /// The flag went off, or the source is gone or not readable (one answer).
    case unavailable
    /// A DM or group message, a nudge, or nothing to show (422).
    case notForwardable
    case rateLimited(retryAfter: Int?)
    case other(String)

    var message: String {
        switch self {
        case .unavailable: String(localized: "This can't be forwarded anymore.")
        case .notForwardable: String(localized: "This can't be forwarded.")
        case .rateLimited(let retryAfter):
            retryAfter.map { String(localized: "Too many forwards. Try again in \($0)s.") }
                ?? String(localized: "Too many forwards. Try again shortly.")
        case .other(let text): text
        }
    }

    static func from(_ error: Error) -> ForwardFailure {
        guard let api = error as? APIError else { return .other(error.localizedDescription) }
        switch api {
        case .notFound: return .unavailable
        case .rateLimited(let retryAfter): return .rateLimited(retryAfter: retryAfter)
        case .server(let status, _) where status == 422: return .notForwardable
        default: return .other(api.localizedDescription)
        }
    }
}

extension APIClient {
    /// Memoised for a minute, not for the run: `forward_messages` is a runtime
    /// flag an operator flips live, and a phone that never re-asked would keep
    /// offering a dead action (or hiding a live one) until it was relaunched.
    /// Off on any failure, so a blip hides the action rather than offering one
    /// the server would 404.
    func forwardConfig(now: Date = Date()) async -> ForwardConfig {
        if let cached = forwardConfigCache, now.timeIntervalSince(cached.at) < 60 {
            return cached.config
        }
        guard let config: ForwardConfig = try? await get("/api/forwards/config") else {
            return .off
        }
        forwardConfigCache = (config, now)
        return config
    }

    func createForward(_ request: ForwardRequest) async throws -> [ForwardOutcome] {
        let response: ForwardResponse = try await post("/api/forwards", body: request)
        return response.outcomes
    }
}
