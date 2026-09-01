import Foundation

// The Baú (Community Home) on the wire: `packages/shared/src/community-home.ts`.
//
// SAME TWO RULES AS `CommunityModels.swift`. Every `?` mirrors a `.nullable()`
// there, and decoding is lenient in the way `Message.thread` is: these
// payloads travel with a feature flag on the other end of a version skew, and
// the cost of a field this build has never heard of must be one missing
// accessory rather than a dropped card.
//
// What the phone reads is a deliberate subset: no drafts, no schedule, no
// media minting. Staff post from the web. Liking and commenting are the only
// verbs here, which is also what the product says the Baú is for.

/// `GET /api/community-home/config`.
///
/// Defaulted to off in every field so an older server (no route at all, a 404)
/// and a response this client does not fully understand both read as "there
/// is no Baú here", which is the honest state of production until the
/// Community Home branch (PR #176) lands.
struct CommunityHomeConfig: Codable, Sendable, Hashable {
    var enabled: Bool
    var vipEnabled: Bool
    var mediaEnabled: Bool

    static let off = CommunityHomeConfig(enabled: false, vipEnabled: false, mediaEnabled: false)

    init(enabled: Bool, vipEnabled: Bool, mediaEnabled: Bool) {
        self.enabled = enabled
        self.vipEnabled = vipEnabled
        self.mediaEnabled = mediaEnabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        vipEnabled = try c.decodeIfPresent(Bool.self, forKey: .vipEnabled) ?? false
        mediaEnabled = try c.decodeIfPresent(Bool.self, forKey: .mediaEnabled) ?? false
    }
}

/// One post's media, as the viewer may see it. `url` is a presigned GET for
/// storage-backed kinds and nil for YouTube; a locked viewer gets no media at
/// all (the whole object is nil on the post), never a media with the URL
/// stripped, so nothing here has to guess at a lock.
struct CommunityHomeMedia: Codable, Sendable, Hashable {
    /// `image` / `video` / `youtube` / `file`.
    let kind: String
    let name: String
    let contentType: String?
    let byteSize: Int?
    let url: String?
    let youtubeUrl: String?

    var isImage: Bool { kind == "image" }
    var isVideo: Bool { kind == "video" }
    var isYoutube: Bool { kind == "youtube" }
    var isFile: Bool { kind == "file" }
    var isGif: Bool { contentType?.lowercased() == "image/gif" }

    /// What a tap opens: the object for storage kinds, the watch page for YouTube.
    var openURL: URL? {
        URL(string: (isYoutube ? youtubeUrl : url) ?? "")
    }

    init(kind: String, name: String = "", contentType: String? = nil, byteSize: Int? = nil,
         url: String? = nil, youtubeUrl: String? = nil) {
        self.kind = kind
        self.name = name
        self.contentType = contentType
        self.byteSize = byteSize
        self.url = url
        self.youtubeUrl = youtubeUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        contentType = try c.decodeIfPresent(String.self, forKey: .contentType)
        byteSize = try c.decodeIfPresent(Int.self, forKey: .byteSize)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        youtubeUrl = try c.decodeIfPresent(String.self, forKey: .youtubeUrl)
    }
}

struct CommunityHomeComment: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let author: PublicUser
    let body: String
    let createdAt: Date
}

struct CommunityHomePost: Codable, Identifiable, Sendable, Hashable {
    let id: String
    let serverId: String
    let author: PublicUser
    /// `owner` / `staff`, or nil. Never `vip` this pass.
    let authorBadge: String?
    let title: String?
    /// Nil on a members-only post the viewer cannot unlock: the API strips it,
    /// and this client must not rebuild a body from the teaser.
    let body: String?
    let teaser: String?
    /// `free` / `members`.
    let visibility: String
    let commentsEnabled: Bool
    let media: CommunityHomeMedia?
    /// True when body and media were stripped for this viewer.
    let locked: Bool
    var likeCount: Int
    var likedByMe: Bool
    var commentCount: Int
    /// The two newest comments, or none at all on a locked post.
    var commentTeaser: [CommunityHomeComment]
    let publishedAt: Date?
    let createdAt: Date

    var isMembersOnly: Bool { visibility == "members" }

    /// The date on the card: when it went up, or when it was written.
    var shownAt: Date { publishedAt ?? createdAt }

    enum CodingKeys: String, CodingKey {
        case id, serverId, author, authorBadge, title, body, teaser, visibility
        case commentsEnabled, media, locked, likeCount, likedByMe, commentCount
        case commentTeaser, publishedAt, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        serverId = try c.decode(String.self, forKey: .serverId)
        author = try c.decode(PublicUser.self, forKey: .author)
        authorBadge = try c.decodeIfPresent(String.self, forKey: .authorBadge)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        body = try c.decodeIfPresent(String.self, forKey: .body)
        teaser = try c.decodeIfPresent(String.self, forKey: .teaser)
        visibility = try c.decodeIfPresent(String.self, forKey: .visibility) ?? "free"
        commentsEnabled = try c.decodeIfPresent(Bool.self, forKey: .commentsEnabled) ?? true
        media = try c.decodeIfPresent(CommunityHomeMedia.self, forKey: .media)
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        likeCount = try c.decodeIfPresent(Int.self, forKey: .likeCount) ?? 0
        likedByMe = try c.decodeIfPresent(Bool.self, forKey: .likedByMe) ?? false
        commentCount = try c.decodeIfPresent(Int.self, forKey: .commentCount) ?? 0
        commentTeaser = try c.decodeIfPresent([CommunityHomeComment].self, forKey: .commentTeaser) ?? []
        publishedAt = try c.decodeIfPresent(Date.self, forKey: .publishedAt)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
    }
}

struct CommunityHomePostsResponse: Codable, Sendable { let posts: [CommunityHomePost] }
struct CommunityHomeCommentsResponse: Codable, Sendable { let comments: [CommunityHomeComment] }
struct CommunityHomeCommentResponse: Codable, Sendable { let comment: CommunityHomeComment }
struct CommunityHomeLikeResponse: Codable, Sendable { let liked: Bool; let likeCount: Int }

/// YouTube links, the one media kind that is a URL rather than an object.
///
/// `videoId` is a port of `parseYoutubeVideoId` in shared: watch, youtu.be,
/// shorts, embed and live, eleven characters of id, anything else nil. The
/// thumbnail is the public one every video has; there is no API key involved
/// and no embed on the phone, a tap opens the watch page.
enum YoutubeLinks {
    static func videoId(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let components = URLComponents(string: trimmed) else { return nil }
        guard var host = components.host?.lowercased() else { return nil }
        if host.hasPrefix("www.") { host.removeFirst(4) }
        let parts = components.path.split(separator: "/").map(String.init)

        if host == "youtu.be" {
            return parts.first.flatMap(validId)
        }
        if host == "youtube.com" || host == "m.youtube.com" || host == "music.youtube.com" {
            if components.path == "/watch" {
                return components.queryItems?.first(where: { $0.name == "v" })?.value.flatMap(validId)
            }
            if parts.count >= 2, ["shorts", "embed", "live"].contains(parts[0]) {
                return validId(parts[1])
            }
        }
        return nil
    }

    static func thumbnailURL(_ raw: String?) -> URL? {
        videoId(raw).flatMap { URL(string: "https://i.ytimg.com/vi/\($0)/hqdefault.jpg") }
    }

    private static func validId(_ candidate: String) -> String? {
        candidate.wholeMatch(of: /^[\w-]{11}$/) != nil ? candidate : nil
    }
}
