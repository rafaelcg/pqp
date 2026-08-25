import Foundation

// Mirrors the zod schemas in packages/shared/src. Field names and optionality
// are copied from there deliberately — every `?` here corresponds to a
// `.nullable()` or an absent key on the wire, and guessing one wrong fails the
// whole decode rather than the one field.

struct CurrentUser: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let clerkId: String
    let displayName: String
    let username: String?
    /// A String, not an Int — "0042" has to keep its leading zeros.
    let discriminator: String?
    let tag: String?
    let avatarUrl: String?
    var dmPrivacy: String?
    /// `"pending" | "passed" | "blocked"`. Only ever sent to the account's own
    /// owner. Absent means the API predates the gate — which reads as *passed*,
    /// matching the web client; a gate the server does not enforce must not be
    /// invented client-side, because its `POST /api/me/age-check` would 404.
    var ageGate: String?
    /// The account's public handle — `pqp.gg/@rafa` — or nil when it has never
    /// claimed one, which is most accounts.
    ///
    /// On this shape and deliberately NOT on `PublicUser`: a handle is a URL its
    /// owner chose to publish, nothing in the app needs somebody else's to render
    /// a row, and the public *profile* page is where one is read about anybody
    /// else — keyed BY the handle.
    var handle: String?
    /// When the handle last moved, so Settings can say when it may move again.
    /// A String rather than a Date because it is only ever fed back to
    /// `HandleRules`, and a decode failure here must not cost the whole account.
    var handleChangedAt: String?

    /// `handleChangedAt` as the cooldown arithmetic wants it. Parsed here rather
    /// than at the field so an unrecognised stamp reads as "no cooldown" — which
    /// is the safe direction: the server refuses a rename inside the window
    /// regardless, and its sentence is what gets shown.
    var handleChangedDate: Date? {
        guard let handleChangedAt else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return withFraction.date(from: handleChangedAt) ?? plain.date(from: handleChangedAt)
    }
}

struct PublicUser: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let username: String?
    let tag: String?
    let avatarUrl: String?
}

struct Server: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let ownerId: String
    /// Genuinely optional — the key is absent (not null) outside `/api/servers`.
    let role: String?
    let createdAt: Date
    let messageRetentionDays: Int?
    let ssoEmailDomain: String?
    /// The server's two pictures, or nil where it set none. Root-relative
    /// `/api/servers/:id/icon?v=…` — the API does not know its own public origin
    /// (see `serverIconPath` in shared), so `Avatar.resolve` completes them.
    ///
    /// Both routes are served WITHOUT auth, before the Bearer is even resolved,
    /// which is what lets `AsyncImage` fetch them directly.
    let iconUrl: String?
    let bannerUrl: String?
    /// Whether this server is listed in the public directory.
    ///
    /// On the member's own list rather than only in the directory because it is
    /// what decides whether the rail offers "show this on my profile" at all — a
    /// private server is never chipped onto anybody's card, so offering the
    /// switch there would be offering a no-op.
    let isCommunity: Bool
    /// This membership's badge opt-out, TRUE by default. Meaningless unless
    /// `isCommunity`.
    var showOnProfile: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, ownerId, role, createdAt, messageRetentionDays
        case ssoEmailDomain, iconUrl, bannerUrl, isCommunity, showOnProfile
    }

    /// Hand-written for the four fields the communities wave added.
    ///
    /// `isCommunity` and `showOnProfile` are non-optional on the wire but
    /// DEFAULTED here, which is the same leniency `Message.thread` gets and for
    /// the same reason: this app talks to a deployment that may be a version
    /// behind, and a server that predates communities must still appear in the
    /// rail rather than failing the whole `/api/servers` decode. It is also what
    /// lets a cache written by an older build still load.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId) ?? ""
        role = try c.decodeIfPresent(String.self, forKey: .role)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        messageRetentionDays = try c.decodeIfPresent(Int.self, forKey: .messageRetentionDays)
        ssoEmailDomain = try c.decodeIfPresent(String.self, forKey: .ssoEmailDomain)
        iconUrl = try c.decodeIfPresent(String.self, forKey: .iconUrl)
        bannerUrl = try c.decodeIfPresent(String.self, forKey: .bannerUrl)
        isCommunity = try c.decodeIfPresent(Bool.self, forKey: .isCommunity) ?? false
        showOnProfile = try c.decodeIfPresent(Bool.self, forKey: .showOnProfile) ?? true
    }

    /// For tests and previews; never for anything the server sent.
    init(
        id: String,
        name: String,
        ownerId: String,
        role: String?,
        createdAt: Date,
        messageRetentionDays: Int? = nil,
        ssoEmailDomain: String? = nil,
        iconUrl: String? = nil,
        bannerUrl: String? = nil,
        isCommunity: Bool = false,
        showOnProfile: Bool = true
    ) {
        self.id = id
        self.name = name
        self.ownerId = ownerId
        self.role = role
        self.createdAt = createdAt
        self.messageRetentionDays = messageRetentionDays
        self.ssoEmailDomain = ssoEmailDomain
        self.iconUrl = iconUrl
        self.bannerUrl = bannerUrl
        self.isCommunity = isCommunity
        self.showOnProfile = showOnProfile
    }
}

struct Channel: Codable, Identifiable, Hashable, Sendable {
    let id: String
    /// Null — not absent — for a DM or group conversation.
    let serverId: String?
    let kind: String
    let name: String
    let type: String
    let position: Int
    let isPrivate: Bool
    let topic: String?
    let imageUrl: String?
    let parentId: String?

    var isText: Bool { type == "text" }
    var isVoice: Bool { type == "voice" }
    var isCategory: Bool { type == "category" }
}

struct ReactionUser: Codable, Hashable, Sendable {
    let id: String
    let displayName: String
}

struct MessageReaction: Codable, Hashable, Sendable {
    let emoji: String
    var count: Int
    var me: Bool
    var users: [ReactionUser]

    init(emoji: String, count: Int, me: Bool, users: [ReactionUser] = []) {
        self.emoji = emoji
        self.count = count
        self.me = me
        self.users = users
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        emoji = try c.decode(String.self, forKey: .emoji)
        count = try c.decode(Int.self, forKey: .count)
        me = try c.decode(Bool.self, forKey: .me)
        users = try c.decodeIfPresent([ReactionUser].self, forKey: .users) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case emoji, count, me, users
    }
}

struct MessageReplyRef: Codable, Hashable, Sendable {
    let id: String
    let authorId: String?
    let authorName: String?
    let excerpt: String
    let deleted: Bool
}

struct Attachment: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let filename: String
    let contentType: String
    let byteSize: Int
    let width: Int?
    let height: Int?
    let url: String

    var isImage: Bool { contentType.hasPrefix("image/") }
    var isVideo: Bool { contentType.hasPrefix("video/") }
    var isAudio: Bool { contentType.hasPrefix("audio/") }
    /// Playable in place rather than shown or listed.
    var isPlayable: Bool { isVideo || isAudio }
    /// GIF is still `isImage` (the content type is `image/*` either way) —
    /// this narrows to the case that needs a frame decoder and an animating
    /// view instead of a single bitmap, matching how the web client decides
    /// the same thing purely from `contentType`.
    var isGif: Bool { contentType.lowercased() == "image/gif" }
}

struct Embed: Codable, Hashable, Sendable {
    let url: String
    let kind: String
    let title: String?
    let description: String?
    let siteName: String?
    let imageUrl: String?
    let imageWidth: Int?
    let imageHeight: Int?
}

struct WebhookEmbedField: Codable, Hashable, Sendable {
    let name: String
    let value: String
    let inline: Bool?
}

struct WebhookEmbedFooter: Codable, Hashable, Sendable {
    let text: String
}

struct WebhookEmbed: Codable, Hashable, Sendable {
    let title: String?
    let description: String?
    let url: String?
    /// A packed 24-bit RGB integer, not a hex string.
    let color: Int?
    let fields: [WebhookEmbedField]?
    let footer: WebhookEmbedFooter?
    /// Free-form text from an external caller — never decode this as a Date.
    let timestamp: String?
}

struct Message: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let channelId: String
    let authorId: String
    let authorName: String
    let authorTag: String?
    let authorAvatarUrl: String?
    var body: String
    let createdAt: Date
    var editedAt: Date?
    var reactions: [MessageReaction]
    let replyTo: MessageReplyRef?
    var attachments: [Attachment]
    var embeds: [Embed]
    /// Present on the wire but absent from the zod schema, so it is defaulted
    /// rather than required — see the contract notes.
    var blocked: Bool
    var pinnedAt: Date?
    let isWebhook: Bool
    var webhookEmbeds: [WebhookEmbed]
    /// The thread anchored to this message, or nil. Defaulted rather than
    /// required: `message-broadcast` for a brand-new message omits it (nothing
    /// can have a thread yet) and an older server never sends it at all.
    var thread: ThreadSummary?

    /// Client-only. A message sent optimistically has not been acknowledged by
    /// the server yet; the `nonce` echo on `message-broadcast` replaces it.
    var isPending: Bool = false
    /// Client-only. The correlation id sent with `message-create` — the only
    /// way to match a broadcast back to the row we drew ahead of it.
    var pendingNonce: String?

    enum CodingKeys: String, CodingKey {
        case id, channelId, authorId, authorName, authorTag, authorAvatarUrl
        case body, createdAt, editedAt, reactions, replyTo, attachments, embeds
        case blocked, pinnedAt, isWebhook, webhookEmbeds, thread
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        authorId = try c.decode(String.self, forKey: .authorId)
        authorName = try c.decodeIfPresent(String.self, forKey: .authorName) ?? "User"
        authorTag = try c.decodeIfPresent(String.self, forKey: .authorTag)
        authorAvatarUrl = try c.decodeIfPresent(String.self, forKey: .authorAvatarUrl)
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(Date.self, forKey: .editedAt)
        reactions = try c.decodeIfPresent([MessageReaction].self, forKey: .reactions) ?? []
        replyTo = try c.decodeIfPresent(MessageReplyRef.self, forKey: .replyTo)
        attachments = try c.decodeIfPresent([Attachment].self, forKey: .attachments) ?? []
        embeds = try c.decodeIfPresent([Embed].self, forKey: .embeds) ?? []
        blocked = try c.decodeIfPresent(Bool.self, forKey: .blocked) ?? false
        pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
        isWebhook = try c.decodeIfPresent(Bool.self, forKey: .isWebhook) ?? false
        webhookEmbeds = try c.decodeIfPresent([WebhookEmbed].self, forKey: .webhookEmbeds) ?? []
        // Lenient on purpose, unlike every other key here: a thread payload
        // this client cannot read must cost the *chip*, not the message. The
        // body is the payload; the chip is a nicety, and a strict decode here
        // would drop a whole message over a shape change on an accessory.
        thread = (try? c.decodeIfPresent(ThreadSummary.self, forKey: .thread)) ?? nil
        isPending = false
        pendingNonce = nil
    }

    /// The optimistic local echo, replaced when the broadcast comes back.
    init(pendingBody: String, channelId: String, author: CurrentUser) {
        id = "pending-\(UUID().uuidString)"
        self.channelId = channelId
        authorId = author.id
        authorName = author.displayName
        authorTag = author.tag
        authorAvatarUrl = author.avatarUrl
        body = pendingBody
        createdAt = Date()
        editedAt = nil
        reactions = []
        replyTo = nil
        attachments = []
        embeds = []
        blocked = false
        pinnedAt = nil
        isWebhook = false
        webhookEmbeds = []
        thread = nil
        isPending = true
        pendingNonce = nil
    }
}

struct UnreadEntry: Codable, Hashable, Sendable {
    let channelId: String
    let count: Int
    let mentions: Int
}

struct DmUnread: Codable, Hashable, Sendable {
    let count: Int
    let mentions: Int
}

struct DmSummary: Codable, Identifiable, Hashable, Sendable {
    let channelId: String
    let kind: String
    let participants: [PublicUser]
    let lastMessageAt: Date?
    let unread: DmUnread

    var id: String { channelId }

    /// Group conversations have no name of their own; the participants are it.
    var title: String {
        if participants.isEmpty { return String(localized: "Empty conversation") }
        return participants.map(\.displayName).joined(separator: ", ")
    }
}

struct ServerMember: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let displayName: String
    let username: String?
    let discriminator: String?
    let tag: String?
    let avatarUrl: String?
    let role: String
    /// `"online" | "idle" | "dnd" | "offline"`, resolved live by the server.
    /// `invisible` never appears here — it is reported as `offline`, and that
    /// privacy rule is the server's to enforce, not ours to reconstruct.
    var status: String?
}

// MARK: - Response envelopes

struct ServersResponse: Codable, Sendable { let servers: [Server] }
struct ChannelsResponse: Codable, Sendable { let channels: [Channel] }
struct MessagesResponse: Codable, Sendable {
    let messages: [Message]
    let hasMore: Bool
    let hasNewer: Bool
}
struct DmsResponse: Codable, Sendable { let conversations: [DmSummary] }
struct UnreadResponse: Codable, Sendable { let unread: [UnreadEntry] }
struct MembersResponse: Codable, Sendable { let members: [ServerMember] }
struct ApiErrorBody: Codable, Sendable { let error: String }

// MARK: - Invites, pins, search

struct Invite: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let code: String
    let serverId: String
    let serverName: String?
    let maxUses: Int?
    let uses: Int
    let expiresAt: Date?
    let createdAt: Date

    /// What actually gets shared. Always the web URL: it is a universal link,
    /// so a phone with the app opens the app, and everybody else lands on the
    /// web app — either way they arrive joined, no code entry anywhere.
    var shareURL: URL {
        URL(string: "https://pqp.gg/app/invite/\(code)")!
    }
}

struct SearchResult: Codable, Identifiable, Hashable, Sendable {
    let messageId: String
    let channelId: String
    let channelName: String
    let authorId: String
    let authorName: String
    /// Carries the server's highlight markers (U+0002 / U+0003) around the
    /// matched terms — stripped or styled at render time, never shown raw.
    let snippet: String
    let createdAt: Date

    var id: String { messageId }

    /// The snippet split into (text, isMatch) runs.
    var runs: [(text: String, isMatch: Bool)] {
        var result: [(String, Bool)] = []
        var current = ""
        var matching = false
        for character in snippet {
            switch character {
            case "\u{0002}":
                if !current.isEmpty { result.append((current, matching)) }
                current = ""
                matching = true
            case "\u{0003}":
                if !current.isEmpty { result.append((current, matching)) }
                current = ""
                matching = false
            default:
                current.append(character)
            }
        }
        if !current.isEmpty { result.append((current, matching)) }
        return result
    }
}

struct InvitesResponse: Codable, Sendable { let invites: [Invite] }
struct SearchResponse: Codable, Sendable {
    let results: [SearchResult]
    let hasMore: Bool
}
struct PinnedResponse: Codable, Sendable { let messages: [Message] }

struct ServerBan: Codable, Identifiable, Hashable, Sendable {
    let userId: String
    let displayName: String?
    let tag: String?
    let reason: String?
    let createdAt: Date?

    var id: String { userId }
}

struct BansResponse: Codable, Sendable { let bans: [ServerBan] }

/// `memberTimeoutSchema` — an active timeout as a moderator sees it.
struct MemberTimeout: Codable, Identifiable, Hashable, Sendable {
    let userId: String
    let displayName: String
    let tag: String?
    let issuedById: String?
    let issuedByName: String?
    let reason: String?
    let createdAt: Date
    let expiresAt: Date

    var id: String { userId }
}

/// What `POST /api/servers/:id/timeouts` answers.
///
/// `message` is the whole sentence, already written by the server, and it is the
/// same one the sanctioned person reads over their socket. A client that renders
/// nothing but this string is a correct client — see `describeTimeout` in shared.
struct IssuedTimeout: Decodable, Sendable {
    struct Timeout: Decodable, Sendable {
        let expiresAt: Date
    }
    let timeout: Timeout
    let message: String
}

/// The report reasons, exactly as `REPORT_REASONS` orders them. The raw value
/// is the wire string; the label is what a person reads.
enum ReportReason: String, CaseIterable, Identifiable, Sendable {
    case spam
    case harassment
    case hateSpeech = "hate_speech"
    case violence
    case sexualContent = "sexual_content"
    case selfHarm = "self_harm"
    case illegalContent = "illegal_content"
    case other

    var id: String { rawValue }

    var label: LocalizedStringResource {
        switch self {
        case .spam: "Spam"
        case .harassment: "Harassment"
        case .hateSpeech: "Hate speech"
        case .violence: "Violence or threats"
        case .sexualContent: "Sexual content"
        case .selfHarm: "Self-harm"
        case .illegalContent: "Illegal content"
        case .other: "Something else"
        }
    }
}

struct Gif: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let url: String
    let previewUrl: String
    let previewStillUrl: String?
    let width: Int
    let height: Int
    let title: String
}

struct GifsResponse: Codable, Sendable { let gifs: [Gif] }
struct GifConfig: Codable, Sendable { let enabled: Bool }

struct AuditEntry: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let actorName: String?
    let action: String
    let reason: String?
    let createdAt: Date
}

struct AuditResponse: Codable, Sendable {
    let entries: [AuditEntry]
    let hasMore: Bool
}

struct Webhook: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let channelId: String
    let name: String
    /// A server-relative path, not a full URL — the server has no reliable way
    /// to know its own public origin.
    let url: String
    let createdAt: Date
}

struct WebhooksResponse: Codable, Sendable { let webhooks: [Webhook] }
struct ChannelMembersResponse: Codable, Sendable { let members: [PublicUser] }

/// Per-place notification levels. Absent keys inherit from `default`, which is
/// why everything here is optional rather than defaulted client-side.
struct NotificationPreferences: Codable, Hashable, Sendable {
    var desktop: Bool?
    var `default`: String?
    var servers: [String: String]?
    var channels: [String: String]?
}

struct UserPreferences: Codable, Hashable, Sendable {
    var theme: String?
    var muteOnJoin: Bool?
    var inputVolume: Double?
    var outputVolume: Double?
    var notifications: NotificationPreferences?
    var showLinkEmbeds: Bool?
    /// Manual status: `"online" | "dnd" | "invisible"`. Absent means online.
    var status: String?
    /// When the hub's first-run checklist was put away, as an ISO instant.
    ///
    /// Shared with the web deliberately — it is the same three errands and the
    /// same account, so answering it on one device has to answer it on the other.
    /// Preferences merge one level deep server-side, so this can be patched on its
    /// own exactly the way `setStatus` patches `status`; nothing else in the blob
    /// is disturbed.
    ///
    /// Note what is NOT here: `onboardedAt`. The web gates its sign-up wizard on
    /// it, while iOS gates its intro beats on a device-local `UserDefaults` bool
    /// (`SessionStore.onboardedKey`) — so the two flows do not know about each
    /// other, and somebody who signed up on the web still sees the beats here.
    /// Worth fixing, but it is a change to the sign-in path rather than to
    /// first-run guidance, and it is not what this field is for.
    var firstRunDismissedAt: String?
}

struct PreferencesResponse: Codable, Sendable { let preferences: UserPreferences }
