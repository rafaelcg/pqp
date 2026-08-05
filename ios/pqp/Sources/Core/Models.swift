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

struct MessageReaction: Codable, Hashable, Sendable {
    let emoji: String
    var count: Int
    var me: Bool
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

    /// Client-only. A message sent optimistically has not been acknowledged by
    /// the server yet; the `nonce` echo on `message-broadcast` replaces it.
    var isPending: Bool = false
    /// Client-only. The correlation id sent with `message-create` — the only
    /// way to match a broadcast back to the row we drew ahead of it.
    var pendingNonce: String?

    enum CodingKeys: String, CodingKey {
        case id, channelId, authorId, authorName, authorTag, authorAvatarUrl
        case body, createdAt, editedAt, reactions, replyTo, attachments, embeds
        case blocked, pinnedAt, isWebhook, webhookEmbeds
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
        if participants.isEmpty { return "Empty conversation" }
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
