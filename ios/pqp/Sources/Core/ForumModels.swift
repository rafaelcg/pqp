import Foundation

// Forum channels, as the wire carries them. The contract is
// `packages/shared/src/forums.ts` (forum PR 0); Swift cannot import it, so
// this is a mirror of the parts the phone reads, decoded leniently.
//
// THE MODEL, ONCE: a forum is a channel of type `forum` that holds posts, and
// a post is a thread channel under it with no root message. So a post opens
// in the ordinary `ChatView` keyed by the post's id, and everything a chat
// already does (history, reactions, attachments, reports, read cursors)
// works on it unchanged. What a post has that a chat does not (a title,
// tags, pinned, closed, resolved, an accepted answer) rides on these types.
//
// LENIENT ON PURPOSE. Every field a card can live without is read with a
// default, so a server that adds a field, or one that has not shipped the
// card extras yet, costs a detail on a card rather than the whole list. The
// fields a list cannot work without (`id`, `forumId`, `title` and the two
// dates the order keys on) are required.

/// The caps from `forums.ts`. Restated, not imported.
enum ForumLimits {
    static let maxTags = 20
    static let maxTagsPerPost = 5
    static let maxPinned = 3
    static let titleMax = 100
    static let tagNameMax = 20
    static let pageSize = 25
    static let searchMax = 100
    static let similarMax = 5
    static let unreadCap = 99
    static let bodyMax = 4000
    /// "Posts parecidos" asks once the title is at least this long.
    static let similarMinChars = 4
}

/// The `error` tokens of a forum refusal (`FORUM_ERRORS`).
enum ForumErrorCode {
    static let off = "forum_channels_off"
    static let tagRequired = "forum_tag_required"
    static let tagModerated = "forum_tag_moderated"
    static let tagUnknown = "forum_tag_unknown"
    static let pinLimit = "forum_pin_limit"
    static let answerInvalid = "forum_answer_invalid"
    static let postRejected = "forum_post_rejected"
}

enum ForumSort: String, Codable, Hashable, Sendable, CaseIterable {
    case activity
    case created
}

enum ForumStatusFilter: String, Codable, Hashable, Sendable {
    case open
    case resolved
}

struct ForumTag: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let emoji: String?
    /// "Só staff": only staff put it on or take it off a post.
    let moderated: Bool
    let position: Int
    let postCount: Int

    init(id: String, name: String, emoji: String? = nil, moderated: Bool = false, position: Int = 0, postCount: Int = 0) {
        self.id = id
        self.name = name
        self.emoji = emoji
        self.moderated = moderated
        self.position = position
        self.postCount = postCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        moderated = try c.decodeIfPresent(Bool.self, forKey: .moderated) ?? false
        position = try c.decodeIfPresent(Int.self, forKey: .position) ?? 0
        postCount = try c.decodeIfPresent(Int.self, forKey: .postCount) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, emoji, moderated, position, postCount
    }
}

struct ForumTopReaction: Codable, Hashable, Sendable {
    let emoji: String
    let count: Int
}

/// One post as every viewer of the forum sees it. Carried by the list and by
/// `forum-post-upsert`; holds nothing about the viewer (that is
/// `ForumPostViewer`).
struct ForumPostSummary: Codable, Identifiable, Hashable, Sendable {
    /// The post's own thread channel id: what `ChatView` opens.
    let id: String
    let forumId: String
    var title: String
    /// Nil once the account is gone ("Conta excluída").
    let authorId: String?
    let authorName: String?
    let authorAvatarUrl: String?
    /// A feed post: the card shows the Feed badge.
    let authorIsWebhook: Bool
    let createdAt: Date
    /// The bump: creation or the newest reply. Never moves backwards.
    var lastActivityAt: Date
    var pinnedAt: Date?
    var lockedAt: Date?
    var resolvedAt: Date?
    /// The reply marked as the answer. May point at a deleted message.
    var acceptedAnswerId: String?
    let preview: String?
    let openingDeleted: Bool
    /// `text`, `voice` or `attachment`; nil with `openingDeleted`.
    let openingKind: String?
    let attachmentCount: Int
    var replyCount: Int
    let reactionCount: Int
    let topReaction: ForumTopReaction?
    let thumbnailUrl: String?
    let thumbnailAttachmentId: String?
    let thumbnailWidth: Int?
    let thumbnailHeight: Int?
    /// In the forum's tag order.
    var tagIds: [String]

    var isPinned: Bool { pinnedAt != nil }
    var isLocked: Bool { lockedAt != nil }
    var isResolved: Bool { resolvedAt != nil }

    init(
        id: String,
        forumId: String,
        title: String,
        authorId: String? = nil,
        authorName: String? = nil,
        authorAvatarUrl: String? = nil,
        authorIsWebhook: Bool = false,
        createdAt: Date,
        lastActivityAt: Date? = nil,
        pinnedAt: Date? = nil,
        lockedAt: Date? = nil,
        resolvedAt: Date? = nil,
        acceptedAnswerId: String? = nil,
        preview: String? = nil,
        openingDeleted: Bool = false,
        openingKind: String? = "text",
        attachmentCount: Int = 0,
        replyCount: Int = 0,
        reactionCount: Int = 0,
        topReaction: ForumTopReaction? = nil,
        thumbnailUrl: String? = nil,
        thumbnailAttachmentId: String? = nil,
        thumbnailWidth: Int? = nil,
        thumbnailHeight: Int? = nil,
        tagIds: [String] = []
    ) {
        self.id = id
        self.forumId = forumId
        self.title = title
        self.authorId = authorId
        self.authorName = authorName
        self.authorAvatarUrl = authorAvatarUrl
        self.authorIsWebhook = authorIsWebhook
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt ?? createdAt
        self.pinnedAt = pinnedAt
        self.lockedAt = lockedAt
        self.resolvedAt = resolvedAt
        self.acceptedAnswerId = acceptedAnswerId
        self.preview = preview
        self.openingDeleted = openingDeleted
        self.openingKind = openingKind
        self.attachmentCount = attachmentCount
        self.replyCount = replyCount
        self.reactionCount = reactionCount
        self.topReaction = topReaction
        self.thumbnailUrl = thumbnailUrl
        self.thumbnailAttachmentId = thumbnailAttachmentId
        self.thumbnailWidth = thumbnailWidth
        self.thumbnailHeight = thumbnailHeight
        self.tagIds = tagIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        forumId = try c.decode(String.self, forKey: .forumId)
        title = try c.decode(String.self, forKey: .title)
        authorId = try c.decodeIfPresent(String.self, forKey: .authorId)
        authorName = try c.decodeIfPresent(String.self, forKey: .authorName)
        authorAvatarUrl = try c.decodeIfPresent(String.self, forKey: .authorAvatarUrl)
        authorIsWebhook = try c.decodeIfPresent(Bool.self, forKey: .authorIsWebhook) ?? false
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        lastActivityAt = try c.decodeIfPresent(Date.self, forKey: .lastActivityAt) ?? createdAt
        pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
        lockedAt = try c.decodeIfPresent(Date.self, forKey: .lockedAt)
        resolvedAt = try c.decodeIfPresent(Date.self, forKey: .resolvedAt)
        acceptedAnswerId = try c.decodeIfPresent(String.self, forKey: .acceptedAnswerId)
        preview = try c.decodeIfPresent(String.self, forKey: .preview)
        openingDeleted = try c.decodeIfPresent(Bool.self, forKey: .openingDeleted) ?? false
        openingKind = try c.decodeIfPresent(String.self, forKey: .openingKind)
        attachmentCount = try c.decodeIfPresent(Int.self, forKey: .attachmentCount) ?? 0
        replyCount = try c.decodeIfPresent(Int.self, forKey: .replyCount) ?? 0
        reactionCount = try c.decodeIfPresent(Int.self, forKey: .reactionCount) ?? 0
        // A shape this build cannot read costs the number, not the card.
        topReaction = (try? c.decodeIfPresent(ForumTopReaction.self, forKey: .topReaction)) ?? nil
        thumbnailUrl = try c.decodeIfPresent(String.self, forKey: .thumbnailUrl)
        thumbnailAttachmentId = try c.decodeIfPresent(String.self, forKey: .thumbnailAttachmentId)
        thumbnailWidth = try c.decodeIfPresent(Int.self, forKey: .thumbnailWidth)
        thumbnailHeight = try c.decodeIfPresent(Int.self, forKey: .thumbnailHeight)
        tagIds = (try? c.decodeIfPresent([String].self, forKey: .tagIds)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case id, forumId, title, authorId, authorName, authorAvatarUrl, authorIsWebhook
        case createdAt, lastActivityAt, pinnedAt, lockedAt, resolvedAt, acceptedAnswerId
        case preview, openingDeleted, openingKind, attachmentCount, replyCount
        case reactionCount, topReaction, thumbnailUrl, thumbnailAttachmentId
        case thumbnailWidth, thumbnailHeight, tagIds
    }
}

/// The per-viewer half of a post: read cursor, new replies, following. Read
/// beside the summaries, never carried by a frame.
struct ForumPostViewer: Codable, Hashable, Sendable {
    let postId: String
    /// Nil: never opened ("Novo").
    var lastReadAt: Date?
    var newReplyCount: Int
    var following: Bool

    init(postId: String, lastReadAt: Date? = nil, newReplyCount: Int = 0, following: Bool = false) {
        self.postId = postId
        self.lastReadAt = lastReadAt
        self.newReplyCount = newReplyCount
        self.following = following
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        postId = try c.decode(String.self, forKey: .postId)
        lastReadAt = try c.decodeIfPresent(Date.self, forKey: .lastReadAt)
        newReplyCount = try c.decodeIfPresent(Int.self, forKey: .newReplyCount) ?? 0
        following = try c.decodeIfPresent(Bool.self, forKey: .following) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case postId, lastReadAt, newReplyCount, following
    }
}

struct ForumCounts: Codable, Hashable, Sendable {
    let posts: Int
    let open: Int
}

/// `GET /api/channels/:forumId/posts`.
struct ForumPostListResponse: Decodable, Sendable {
    let pinned: [ForumPostSummary]
    let posts: [ForumPostSummary]
    let viewer: [ForumPostViewer]
    let nextCursor: String?
    /// The forum cursor before this visit: what "Novo" is measured against.
    let forumPreviousReadAt: Date?
    /// Page 1 only.
    let counts: ForumCounts?

    init(
        pinned: [ForumPostSummary] = [],
        posts: [ForumPostSummary] = [],
        viewer: [ForumPostViewer] = [],
        nextCursor: String? = nil,
        forumPreviousReadAt: Date? = nil,
        counts: ForumCounts? = nil
    ) {
        self.pinned = pinned
        self.posts = posts
        self.viewer = viewer
        self.nextCursor = nextCursor
        self.forumPreviousReadAt = forumPreviousReadAt
        self.counts = counts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pinned = try c.decodeIfPresent([ForumPostSummary].self, forKey: .pinned) ?? []
        posts = try c.decode([ForumPostSummary].self, forKey: .posts)
        viewer = try c.decodeIfPresent([ForumPostViewer].self, forKey: .viewer) ?? []
        nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
        forumPreviousReadAt = try c.decodeIfPresent(Date.self, forKey: .forumPreviousReadAt)
        counts = (try? c.decodeIfPresent(ForumCounts.self, forKey: .counts)) ?? nil
    }

    private enum CodingKeys: String, CodingKey {
        case pinned, posts, viewer, nextCursor, forumPreviousReadAt, counts
    }
}

/// The accepted answer, quoted under the opening message ("Solução").
struct ForumAcceptedAnswer: Codable, Hashable, Sendable {
    let messageId: String
    /// Deleted after it was marked: "A resposta marcada foi apagada."
    let deleted: Bool
    let authorId: String?
    let authorName: String?
    let excerpt: String?
    let createdAt: Date?
}

/// `GET /api/forum-posts/:postId`: the post view's header and the deep link.
struct ForumPostDetail: Decodable, Sendable {
    let post: ForumPostSummary
    let viewer: ForumPostViewer
    let acceptedAnswer: ForumAcceptedAnswer?
    /// Distinct people who wrote in the post, the author included.
    let participantCount: Int

    init(post: ForumPostSummary, viewer: ForumPostViewer, acceptedAnswer: ForumAcceptedAnswer? = nil, participantCount: Int = 1) {
        self.post = post
        self.viewer = viewer
        self.acceptedAnswer = acceptedAnswer
        self.participantCount = participantCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        post = try c.decode(ForumPostSummary.self, forKey: .post)
        viewer = try c.decodeIfPresent(ForumPostViewer.self, forKey: .viewer)
            ?? ForumPostViewer(postId: post.id)
        acceptedAnswer = (try? c.decodeIfPresent(ForumAcceptedAnswer.self, forKey: .acceptedAnswer)) ?? nil
        participantCount = try c.decodeIfPresent(Int.self, forKey: .participantCount) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case post, viewer, acceptedAnswer, participantCount
    }
}

struct ForumSettings: Codable, Hashable, Sendable {
    var requireTag: Bool
    var defaultSort: ForumSort

    static let defaults = ForumSettings(requireTag: false, defaultSort: .activity)

    init(requireTag: Bool, defaultSort: ForumSort) {
        self.requireTag = requireTag
        self.defaultSort = defaultSort
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requireTag = try c.decodeIfPresent(Bool.self, forKey: .requireTag) ?? false
        // A sort this build does not know reads as the default order.
        defaultSort = (try? c.decodeIfPresent(ForumSort.self, forKey: .defaultSort)) ?? .activity
    }

    private enum CodingKeys: String, CodingKey { case requireTag, defaultSort }
}

/// `GET /api/forum/config?serverId=`: the runtime flag for that server. Off
/// never hides a forum: reading and replying keep working, only new posts
/// pause.
struct ForumConfig: Codable, Hashable, Sendable {
    let enabled: Bool
    static let off = ForumConfig(enabled: false)
}

/// The 422 a create answers when the message path refused it: the same
/// `reason` / `retryAfterMs` / `automodMessage` a `message-rejected` carries.
struct ForumPostRejection: Decodable, Equatable, Sendable {
    let error: String
    let reason: String?
    let retryAfterMs: Int?
    let automodMessage: String?
}

/// Where a link or a push asks to land inside a server: a forum, and maybe
/// one of its posts on top of it.
struct ForumFocus: Hashable, Sendable {
    let forumId: String
    var postId: String?
}

/// What a forum create can answer besides a post.
enum ForumCreateError: Error, Equatable {
    /// The message path refused it (slow mode, AutoMod, the post bucket).
    case rejected(ForumPostRejection)
    /// Any other refusal, by its `error` token or the server's sentence.
    case refused(status: Int, error: String)
    case transport(String)
}
