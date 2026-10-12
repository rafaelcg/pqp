import Foundation
import SwiftUI

// STORIES: a photo, a short video or a text card that lives for 24 hours,
// posted to servers the author is in, to their friends, or both.
//
// Wire shapes from `packages/shared/src/stories.ts`. Every `?` here mirrors a
// `.nullable()` or `.default()` there, and decoding is lenient where the
// contract says a client must survive what it does not know: a sticker of a
// type this build cannot draw is nil, not a failed story.

// MARK: - Limits and pacing

enum StoryLimits {
    static let ttlHours = 24
    static let maxVideoMs = 30_000
    static let maxBytes = 25 * 1024 * 1024
    static let imageMaxEdge: CGFloat = 1440
    static let captionMax = 200
    static let textMax = 280
    static let replyMax = 2000
    static let maxServerAudiences = 10
    static let idsMax = 20
    static let viewsBatchMax = 50
    static let photoDisplayMs = 5_000
    static let callDisplayMs = 8_000

    /// Text cards stay longer the longer they are: 5 s plus 50 ms a character,
    /// capped at 10 s. `storyTextDisplayMs` in the contract.
    static func textDisplayMs(_ text: String) -> Int {
        min(10_000, 5_000 + 50 * text.count)
    }
}

// MARK: - Config

/// `GET /api/stories/config[?serverId=]`. Always 200 on a server that has
/// stories at all; an older API's 404 reads as everything off.
struct StoriesConfig: Codable, Hashable, Sendable {
    var enabled: Bool
    var friendsEnabled: Bool
    var mediaEnabled: Bool
    var videoEnabled: Bool
    var maxVideoMs: Int
    var maxBytes: Int

    static let off = StoriesConfig(
        enabled: false, friendsEnabled: false, mediaEnabled: false,
        videoEnabled: false, maxVideoMs: StoryLimits.maxVideoMs, maxBytes: StoryLimits.maxBytes
    )
}

// MARK: - People, stickers, the story

struct StoryAuthor: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let displayName: String
    let avatarUrl: String?
    var handle: String? = nil

    /// "Bia Souza" → "Bia", for the label under a ring.
    var firstName: String {
        displayName.split(separator: " ").first.map(String.init) ?? displayName
    }
}

/// "Chama pra call": the only sticker type today. Phase 2 adds more; a type
/// this build does not know decodes as nil and draws nothing.
struct StoryCallSticker: Codable, Hashable, Sendable {
    let type: String
    let serverId: String
    let channelId: String
}

/// The call sticker as it is right now, read from the roster at serve time.
struct StoryCallLive: Codable, Hashable, Sendable {
    let serverId: String
    let channelId: String
    let channelName: String
    let participants: [StoryAuthor]
    let count: Int
    /// `live`, `ended` or `full`.
    let state: String
    let joinable: Bool
}

/// Where a story is seen: a server the viewer is in, or Amigos.
enum StoryAudience: Codable, Hashable, Sendable {
    case server(id: String, name: String)
    case friends

    private enum CodingKeys: String, CodingKey { case kind, serverId, serverName }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "server":
            self = .server(
                id: try c.decode(String.self, forKey: .serverId),
                name: try c.decode(String.self, forKey: .serverName)
            )
        default:
            self = .friends
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .server(let id, let name):
            try c.encode("server", forKey: .kind)
            try c.encode(id, forKey: .serverId)
            try c.encode(name, forKey: .serverName)
        case .friends:
            try c.encode("friends", forKey: .kind)
        }
    }

    var serverId: String? {
        if case .server(let id, _) = self { return id }
        return nil
    }
}

struct StoryMedia: Codable, Hashable, Sendable {
    let url: String
    let posterUrl: String?
    let contentType: String
    let width: Int
    let height: Int
    let durationMs: Int?

    var isVideo: Bool { contentType.hasPrefix("video/") }
}

struct StoryViewerState: Codable, Hashable, Sendable {
    var seen: Bool
    var reaction: String?
    var canReply: Bool
    /// `replies_off` or `dm_closed`.
    var replyBlockedReason: String?
    var canModerate: [String]
    var canSaveToBau: [String]

    private enum CodingKeys: String, CodingKey {
        case seen, reaction, canReply, replyBlockedReason, canModerate, canSaveToBau
    }

    init(seen: Bool, reaction: String?, canReply: Bool, replyBlockedReason: String?,
         canModerate: [String], canSaveToBau: [String]) {
        self.seen = seen
        self.reaction = reaction
        self.canReply = canReply
        self.replyBlockedReason = replyBlockedReason
        self.canModerate = canModerate
        self.canSaveToBau = canSaveToBau
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seen = try c.decodeIfPresent(Bool.self, forKey: .seen) ?? false
        reaction = (try? c.decodeIfPresent(String.self, forKey: .reaction)) ?? nil
        canReply = try c.decodeIfPresent(Bool.self, forKey: .canReply) ?? false
        replyBlockedReason = (try? c.decodeIfPresent(String.self, forKey: .replyBlockedReason)) ?? nil
        canModerate = (try? c.decodeIfPresent([String].self, forKey: .canModerate)) ?? []
        canSaveToBau = (try? c.decodeIfPresent([String].self, forKey: .canSaveToBau)) ?? []
    }
}

struct StoryOwnState: Codable, Hashable, Sendable {
    /// `pending`, `processing` (a video waiting for its frames) or `live`.
    let status: String
    var viewCount: Int
    var reactionCount: Int
    var replyCount: Int
    let repliesEnabled: Bool
}

struct Story: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let author: StoryAuthor
    /// `image`, `video` or `text`.
    let kind: String
    let caption: String?
    let text: String?
    let background: String?
    let media: StoryMedia?
    let sticker: StoryCallSticker?
    let call: StoryCallLive?
    let publishedAt: Date?
    let expiresAt: Date?
    let audiences: [StoryAudience]
    var viewer: StoryViewerState
    var own: StoryOwnState?

    private enum CodingKeys: String, CodingKey {
        case id, author, kind, caption, text, background, media, sticker, call
        case publishedAt, expiresAt, audiences, viewer, own
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        author = try c.decode(StoryAuthor.self, forKey: .author)
        kind = try c.decode(String.self, forKey: .kind)
        caption = try c.decodeIfPresent(String.self, forKey: .caption)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        background = try c.decodeIfPresent(String.self, forKey: .background)
        media = (try? c.decodeIfPresent(StoryMedia.self, forKey: .media)) ?? nil
        // Only the call sticker is drawn today; anything else is no sticker.
        let sticker = (try? c.decodeIfPresent(StoryCallSticker.self, forKey: .sticker)) ?? nil
        self.sticker = sticker?.type == "call" ? sticker : nil
        call = (try? c.decodeIfPresent(StoryCallLive.self, forKey: .call)) ?? nil
        publishedAt = try c.decodeIfPresent(Date.self, forKey: .publishedAt)
        expiresAt = try c.decodeIfPresent(Date.self, forKey: .expiresAt)
        audiences = (try? c.decodeIfPresent([StoryAudience].self, forKey: .audiences)) ?? []
        viewer = try c.decode(StoryViewerState.self, forKey: .viewer)
        own = (try? c.decodeIfPresent(StoryOwnState.self, forKey: .own)) ?? nil
    }

    var isText: Bool { kind == "text" }
    var isVideo: Bool { kind == "video" }
    var isMine: Bool { own != nil }

    /// How long it stays on screen: the video's own length, a text card by
    /// its length, a call sticker 8 s, a photo 5 s.
    var displayMs: Int {
        if isVideo, let duration = media?.durationMs { return max(1_000, duration) }
        if isText { return StoryLimits.textDisplayMs(text ?? "") }
        if sticker != nil { return StoryLimits.callDisplayMs }
        return StoryLimits.photoDisplayMs
    }
}

struct StoriesResponse: Codable, Sendable { let stories: [Story] }

// MARK: - The strip

struct StoryStripItem: Codable, Hashable, Identifiable, Sendable {
    let author: StoryAuthor
    let storyIds: [String]
    let latestAt: Date
    let expiresAt: Date
    var unseen: Bool
    let hasCall: Bool

    var id: String { author.id }
}

struct StoryStrip: Codable, Hashable, Sendable {
    var enabled: Bool
    var canPost: Bool
    var own: StoryStripItem?
    var items: [StoryStripItem]
    var firstRunHint: Bool

    static let off = StoryStrip(enabled: false, canPost: false, own: nil, items: [], firstRunHint: false)

    init(enabled: Bool, canPost: Bool, own: StoryStripItem?, items: [StoryStripItem], firstRunHint: Bool) {
        self.enabled = enabled
        self.canPost = canPost
        self.own = own
        self.items = items
        self.firstRunHint = firstRunHint
    }

    private enum CodingKeys: String, CodingKey { case enabled, canPost, own, items, firstRunHint }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        canPost = try c.decodeIfPresent(Bool.self, forKey: .canPost) ?? false
        own = try c.decodeIfPresent(StoryStripItem.self, forKey: .own)
        items = try c.decodeIfPresent([StoryStripItem].self, forKey: .items) ?? []
        firstRunHint = try c.decodeIfPresent(Bool.self, forKey: .firstRunHint) ?? false
    }
}

// MARK: - Composer

struct StoryAudienceOptions: Codable, Hashable, Sendable {
    struct ServerOption: Codable, Hashable, Identifiable, Sendable {
        let serverId: String
        let serverName: String
        let iconUrl: String?
        let memberCount: Int
        let canPost: Bool
        /// `no_permission`, `timed_out` or `account_too_new`.
        let blockedReason: String?
        var id: String { serverId }
    }
    struct FriendsOption: Codable, Hashable, Sendable {
        let enabled: Bool
        let canPost: Bool
    }
    let servers: [ServerOption]
    let friends: FriendsOption
}

struct StoryMediaInput: Codable, Hashable, Sendable {
    let contentType: String
    let byteSize: Int
    let width: Int
    let height: Int
    var durationMs: Int? = nil
}

struct StoryAudienceTargets: Codable, Hashable, Sendable {
    var serverIds: [String]
    var friends: Bool
}

/// `POST /api/stories`. Optional keys are left out of the JSON, which is what
/// the server's `superRefine` expects (a text story must not carry `media`).
struct CreateStoryRequest: Encodable, Sendable {
    /// Made once per story the person means to post and sent again on a
    /// retry: a second create with it answers the first story (with a fresh
    /// upload URL) instead of posting a second one.
    var requestId: String? = nil
    let kind: String
    var caption: String? = nil
    var text: String? = nil
    var background: String? = nil
    var sticker: StoryCallSticker? = nil
    var repliesEnabled: Bool = true
    let audiences: StoryAudienceTargets
    var media: StoryMediaInput? = nil
}

struct StoryUpload: Codable, Hashable, Sendable {
    let url: String
    let method: String
    let headers: [String: String]
}

struct CreateStoryResponse: Codable, Sendable {
    let story: Story
    let upload: StoryUpload?
}

struct PublishStoryResponse: Codable, Sendable { let story: Story }

// MARK: - Viewers, quote, notices

struct StoryViewerRow: Codable, Hashable, Identifiable, Sendable {
    let user: StoryAuthor
    let viewedAt: Date
    let reaction: String?
    let replied: Bool
    var id: String { user.id }
}

struct StoryViewersPage: Codable, Sendable {
    let viewers: [StoryViewerRow]
    let nextCursor: String?
    let viewCount: Int
    let reactionCount: Int
}

/// `GET /api/stories/:storyId/card`: what a DM quote draws. Expired or
/// removed carries no picture and no text at all.
struct StoryCard: Codable, Hashable, Sendable {
    let storyId: String
    /// `live`, `expired` or `removed`.
    let state: String
    let authorId: String
    let kind: String?
    let posterUrl: String?
    let caption: String?
    let text: String?
    let background: String?
    let expiresAt: Date?

    var isLive: Bool { state == "live" }
}

struct StoryReplyResponse: Codable, Sendable {
    let conversationId: String
    let messageId: String
}

struct StoryNotice: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let kind: String
    let storyId: String?
    let serverId: String?
    let serverName: String?
    let reason: String?
    let createdAt: Date
}

struct StoryNoticesResponse: Codable, Sendable { let notices: [StoryNotice] }

/// `stories-update`, content-free: refetch the strip it names.
struct StoriesUpdate: Hashable, Sendable {
    /// `server`, `friends` or `own`.
    let scope: String
    let serverId: String?
    let removedStoryIds: [String]
}

// MARK: - Pure rules

enum StoryRules {
    /// The house reactions, in the contract's order, with what they draw.
    static let reactions: [(key: String, glyph: String)] = [
        ("gg", "GG"), ("fire", "🔥"), ("joy", "😂"), ("wow", "😮"), ("skull", "💀"), ("clap", "👏"),
    ]

    static func glyph(for reaction: String) -> String {
        reactions.first { $0.key == reaction }?.glyph ?? reaction
    }

    /// The text card palette. Each key is chosen for at least 4.5:1 with
    /// white text (`STORY_BACKGROUNDS`).
    static let backgrounds = ["lime", "night", "ember", "grape", "sand", "ink"]

    static func backgroundColors(_ key: String?) -> [Color] {
        switch key {
        case "lime": [Color(red: 0.22, green: 0.42, blue: 0.08), Color(red: 0.12, green: 0.27, blue: 0.05)]
        case "night": [Color(red: 0.10, green: 0.16, blue: 0.42), Color(red: 0.05, green: 0.07, blue: 0.22)]
        case "ember": [Color(red: 0.66, green: 0.20, blue: 0.10), Color(red: 0.38, green: 0.08, blue: 0.06)]
        case "grape": [Color(red: 0.40, green: 0.16, blue: 0.56), Color(red: 0.20, green: 0.07, blue: 0.32)]
        case "sand": [Color(red: 0.52, green: 0.38, blue: 0.16), Color(red: 0.32, green: 0.22, blue: 0.08)]
        default: [Color(red: 0.12, green: 0.14, blue: 0.17), Color(red: 0.03, green: 0.04, blue: 0.06)]
        }
    }

    /// A ring is gone once its newest story expires. Expiry sends no frame,
    /// so every client drops rings itself.
    static func dropExpired(_ strip: StoryStrip, now: Date = Date()) -> StoryStrip {
        var next = strip
        next.items = strip.items.filter { $0.expiresAt > now }
        if let own = strip.own, own.expiresAt <= now { next.own = nil }
        return next
    }

    /// When the next ring runs out, so the strip can redraw then.
    static func nextExpiry(_ strip: StoryStrip, now: Date = Date()) -> Date? {
        ([strip.own].compactMap { $0 } + strip.items)
            .map(\.expiresAt)
            .filter { $0 > now }
            .min()
    }

    /// Whether the strip draws at all: only with a story on the air, or for
    /// somebody who can post (their own bubble leads), and never with the
    /// flag off. With nothing live and nobody posting, it costs no space.
    static func showsStrip(_ strip: StoryStrip) -> Bool {
        strip.enabled && (strip.own != nil || !strip.items.isEmpty)
    }

    /// "2 h", "12 min", "agora".
    static func age(since date: Date, now: Date = Date()) -> String {
        let minutes = max(0, Int(now.timeIntervalSince(date) / 60))
        if minutes < 1 { return String(localized: "now") }
        if minutes < 60 { return String(localized: "\(minutes) min") }
        return String(localized: "\(minutes / 60) h")
    }

    /// "21 h" / "40 min" left before it disappears.
    static func left(until date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let minutes = max(0, Int(date.timeIntervalSince(now) / 60))
        if minutes < 60 { return String(localized: "\(minutes) min") }
        return String(localized: "\(minutes / 60) h")
    }

    /// The line where the reply box would be when it is not offered.
    static func replyBlockedLine(_ reason: String?, name: String) -> String? {
        switch reason {
        case "replies_off": String(localized: "\(name) turned replies off")
        case "dm_closed": String(localized: "\(name) doesn't take direct messages")
        default: nil
        }
    }

    /// Why a server is greyed in "Quem vê".
    static func blockedLine(_ reason: String?) -> String? {
        switch reason {
        case "no_permission": String(localized: "Staff only allow stories for some roles")
        case "timed_out": String(localized: "You're timed out here")
        case "account_too_new": String(localized: "Your account is too new to post here")
        default: nil
        }
    }

    /// A video the composer refuses before uploading, with the reason, or nil.
    static func videoProblem(durationMs: Int, byteSize: Int, maxVideoMs: Int = StoryLimits.maxVideoMs) -> String? {
        if durationMs > maxVideoMs {
            let seconds = Int((Double(durationMs) / 1000).rounded(.up))
            return String(localized: "This video is \(seconds) s. The limit is 30 s.")
        }
        if byteSize > StoryLimits.maxBytes {
            return String(localized: "File too big. Up to 25 MB.")
        }
        return nil
    }

    /// The new strip after the viewer watched these stories: their rings
    /// turn seen when every story in them was seen. Applied when the viewer
    /// closes, so the change is seen.
    static func markingSeen(_ strip: StoryStrip, seenIds: Set<String>) -> StoryStrip {
        var next = strip
        next.items = strip.items.map { item in
            var item = item
            if item.unseen, item.storyIds.allSatisfy(seenIds.contains) { item.unseen = false }
            return item
        }
        return next
    }
}

// MARK: - Playback (the viewer's position)

/// Where the viewer is: which person, which of their stories. Pure, so tap
/// right/left and the swipe between people are tests.
struct StoryPlayback: Equatable, Sendable {
    /// One entry per person, each their story ids in play order.
    let people: [[String]]
    private(set) var person: Int
    private(set) var index: Int

    init(people: [[String]], startPerson: Int = 0) {
        self.people = people.filter { !$0.isEmpty }
        self.person = min(max(0, startPerson), max(0, self.people.count - 1))
        self.index = 0
    }

    var currentId: String? {
        guard people.indices.contains(person), people[person].indices.contains(index) else { return nil }
        return people[person][index]
    }

    var countInPerson: Int { people.indices.contains(person) ? people[person].count : 0 }

    /// Tap right, or the clock ran out. False at the very end (close).
    mutating func next() -> Bool {
        if index + 1 < countInPerson {
            index += 1
            return true
        }
        return nextPerson()
    }

    /// Tap left. At the very first story it stays put (restart).
    mutating func previous() {
        if index > 0 {
            index -= 1
        } else if person > 0 {
            person -= 1
            index = 0
        }
    }

    /// Swipe to the next person. False when there is nobody after.
    mutating func nextPerson() -> Bool {
        guard person + 1 < people.count else { return false }
        person += 1
        index = 0
        return true
    }

    /// Swipe to the previous person. False when there is nobody before.
    mutating func previousPerson() -> Bool {
        guard person > 0 else { return false }
        person -= 1
        index = 0
        return true
    }

    /// The ids worth fetching next: the rest of this person and the next
    /// person's first.
    var prefetchIds: [String] {
        var ids: [String] = []
        if people.indices.contains(person) { ids += people[person] }
        if people.indices.contains(person + 1), let first = people[person + 1].first { ids.append(first) }
        return ids
    }
}
