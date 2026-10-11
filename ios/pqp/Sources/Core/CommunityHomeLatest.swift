import Foundation

// The Baú preview at the top of the channel list: the newest post as a card
// while there is something new, a slim row with a thumbnail once it has been
// seen. One request, `GET /api/servers/:id/home/latest`, which also answers the
// unread count, so it replaces `/home/unread` on this screen rather than
// adding a call. An API that predates the route answers 404 and the list falls
// back to the old row with the count from `/home/unread`.

/// One post in `GET …/home/latest`: the same card chat draws for a pasted
/// permalink, plus whether this viewer has seen it.
struct CommunityHomeLatestPost: Decodable, Sendable, Equatable, Identifiable {
    let card: CommunityHomePostCard
    /// Same rule as the unread count (`published_at > last_seen_at`, never the
    /// viewer's own post), so the card and the badge cannot disagree.
    let isNew: Bool
    /// The author's chosen cover for an uploaded video (`bau_custom_cover`).
    /// Decoded here, beside the card, so a server that sends it is used and
    /// one that does not changes nothing.
    let posterUrl: String?

    var id: String { card.postId }

    enum CodingKeys: String, CodingKey { case isNew, posterUrl }

    init(from decoder: Decoder) throws {
        // The card's fields sit at the top level of the same object.
        card = try CommunityHomePostCard(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isNew = try c.decodeIfPresent(Bool.self, forKey: .isNew) ?? false
        posterUrl = try c.decodeIfPresent(String.self, forKey: .posterUrl)
    }

    init(card: CommunityHomePostCard, isNew: Bool, posterUrl: String? = nil) {
        self.card = card
        self.isNew = isNew
        self.posterUrl = posterUrl
    }

    /// What the thumbnail shows. Never a frame pulled out of a video: that
    /// downloads video bytes just to draw a sidebar, so an uploaded video with
    /// no chosen cover is the play plate.
    var thumbnail: CommunityHomePostCard.Poster {
        if !card.locked, let raw = posterUrl, let url = URL(string: raw), Self.isLoadable(url) {
            return .image(url)
        }
        switch card.poster {
        case .videoFrame: return .plate
        default: return card.poster
        }
    }

    var publishedDate: Date? {
        guard let raw = card.publishedAt else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return withFraction.date(from: raw) ?? plain.date(from: raw)
    }

    private static func isLoadable(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https": true
        #if DEBUG
        case "http": true
        #endif
        default: false
        }
    }
}

/// `GET /api/servers/:serverId/home/latest?limit=3`.
struct CommunityHomeLatest: Decodable, Sendable, Equatable {
    let unread: Int
    let lastSeenAt: String?
    /// Newest first, published only. The pinned post is not moved to the front.
    let posts: [CommunityHomeLatestPost]

    enum CodingKeys: String, CodingKey { case unread, lastSeenAt, posts }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unread = try c.decodeIfPresent(Int.self, forKey: .unread) ?? 0
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        posts = try c.decodeIfPresent([CommunityHomeLatestPost].self, forKey: .posts) ?? []
    }

    init(unread: Int, lastSeenAt: String? = nil, posts: [CommunityHomeLatestPost]) {
        self.unread = unread
        self.lastSeenAt = lastSeenAt
        self.posts = posts
    }
}

/// What the list knows about the newest posts.
enum CommunityHomeLatestAnswer: Equatable, Sendable {
    case ok(CommunityHomeLatest)
    /// The route is not there (an older API, or the flag is off for this
    /// server): use `/home/unread` and the old row.
    case unsupported
}

extension APIClient {
    /// A 404 is `.unsupported`, not an error; anything else throws so the
    /// caller keeps what it showed.
    func communityHomeLatest(serverId: String, limit: Int = 3, lang: String) async throws -> CommunityHomeLatestAnswer {
        do {
            let latest: CommunityHomeLatest = try await get(
                "/api/servers/\(serverId)/home/latest",
                query: [
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "lang", value: lang),
                ]
            )
            return .ok(latest)
        } catch APIError.notFound {
            return .unsupported
        }
    }
}

/// Which of the Baú's shapes the channel list draws.
enum BauPreviewMode: Equatable {
    /// The route is missing: today's row with the count from `/home/unread`.
    case legacy(unread: Int)
    /// Nothing has been answered yet. Drawn as the legacy row with no count,
    /// so the list does not jump from nothing to a card.
    case loading
    /// Something new: the card with the newest post, and how many more new
    /// posts sit behind it (`next` is the first of them, when the response
    /// carried it).
    case fresh(lead: CommunityHomeLatestPost, moreNew: Int, next: CommunityHomeLatestPost?)
    /// Seen: the slim row with the newest post's thumbnail.
    case seen(CommunityHomeLatestPost)
    /// No posts at all. Staff get the invitation to post, members a quiet row.
    case empty(canPost: Bool)

    static func resolve(answer: CommunityHomeLatestAnswer?, legacyUnread: Int, canPost: Bool) -> BauPreviewMode {
        switch answer {
        case nil:
            return .loading
        case .unsupported:
            return .legacy(unread: legacyUnread)
        case .ok(let latest):
            guard let lead = latest.posts.first else { return .empty(canPost: canPost) }
            guard lead.isNew else { return .seen(lead) }
            let behind = latest.posts.dropFirst().filter(\.isNew)
            // `unread` counts every new post, `posts` only the first few; the
            // larger of the two is the honest number behind the lead.
            let moreNew = max(latest.unread - 1, behind.count)
            return .fresh(lead: lead, moreNew: moreNew, next: behind.first)
        }
    }
}
