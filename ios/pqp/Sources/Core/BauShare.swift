import Foundation

// A Baú post pasted into chat, drawn as a card.
//
// THE SWIFT TWIN of `packages/shared/src/community-home-share.ts` (the
// permalink grammar) and `client/src/lib/community-home/share-card.ts` (which
// link in a message gets a card, and the cache around the fetch). The web and
// the server define the contract; `BauShareTests` pins the same cases the
// shared test pins, so a change on one side shows up as a red test on the
// other instead of a card that silently never appears.
//
// Everything here is free of SwiftUI and of the session, because the grammar
// is where the bugs are (a trailing full stop swallowed into the link, a
// shouted UUID that no longer matches its row) and pure functions are the only
// thing a unit test can see.

/// The post a permalink names.
struct BauPostRef: Equatable, Hashable, Sendable {
    let serverId: String
    let postId: String
}

/// A permalink found inside a message body.
struct BauPostLink: Equatable, Sendable {
    let serverId: String
    let postId: String
    /// The URL exactly as it appears in the text, minus a trailing sentence mark.
    let url: String
    /// Its origin, e.g. `https://pqp.gg`.
    let origin: String
    /// Where it sits in the scanned text.
    let range: Range<String.Index>

    var ref: BauPostRef { BauPostRef(serverId: serverId, postId: postId) }
}

/// Where a link into the Baú lands: the feed, and the post to bring into view.
struct BauFocus: Hashable, Sendable {
    let postId: String?
}

enum BauShare {
    // MARK: - Grammar

    /// Where a post lives inside the app. Always relative; callers add an origin.
    static func postPath(serverId: String, postId: String) -> String {
        "/app/server/\(serverId)/bau/\(postId)"
    }

    /// The post a `/app/server/<id>/bau/<id>` path names, or nil. Ids are
    /// lowercased so a shouted link still matches its row; one trailing slash
    /// is allowed, anything after the post id is not.
    static func parsePostPath(_ pathname: String) -> BauPostRef? {
        var parts = pathname.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // A path starts with "/", which splits to a leading "".
        guard parts.first == "" else { return nil }
        parts.removeFirst()
        if parts.count == 6, parts[5] == "" { parts.removeLast() }
        guard parts.count == 5,
              parts[0] == "app", parts[1] == "server", parts[3] == "bau",
              isUUID(parts[2]), isUUID(parts[4])
        else { return nil }
        return BauPostRef(serverId: parts[2].lowercased(), postId: parts[4].lowercased())
    }

    /// Every Baú post permalink in a message body, in order. Origin policy is
    /// the caller's: this only says the path is a Baú post. Query strings and
    /// fragments are allowed and ignored; a trailing sentence mark is not part
    /// of the link.
    static func findLinks(in text: String) -> [BauPostLink] {
        var found: [BauPostLink] = []
        for match in text.matches(of: /(?i)https?:\/\/[^\s<>()\[\]]+/) {
            var end = match.range.upperBound
            while end > match.range.lowerBound, trailingPunctuation.contains(text[text.index(before: end)]) {
                end = text.index(before: end)
            }
            let raw = String(text[match.range.lowerBound..<end])
            guard let components = URLComponents(string: raw),
                  let origin = origin(of: components),
                  let ref = parsePostPath(components.path)
            else { continue }
            found.append(BauPostLink(
                serverId: ref.serverId, postId: ref.postId,
                url: raw, origin: origin, range: match.range.lowerBound..<end
            ))
        }
        return found
    }

    /// Whether a message body is nothing but the link, so the card can stand
    /// alone in its place.
    static func bodyIsOnly(_ link: BauPostLink, in text: String) -> Bool {
        let before = text[..<link.range.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        let after = trimmingTrailingPunctuation(
            text[link.range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        )
        return before.isEmpty && after.isEmpty
    }

    // MARK: - Which link gets a card

    /// Hosts that always mean this product, on top of the origin the app talks to.
    private static let hostedAppHosts: Set<String> = ["pqp.gg", "www.pqp.gg"]

    /// The web origin of the deployment this build is pointed at. The hosted
    /// app answers on `pqp.gg` (always allowed below); a debug build pointed at
    /// the local stack is the Vite dev server.
    static var currentWebOrigin: String? {
        #if DEBUG
        return Backend.current == .hosted ? nil : "http://localhost:5173"
        #else
        return nil
        #endif
    }

    /// Is `origin` this instance? The origin the app is running against, or the
    /// hosted app. A link to somebody else's pqp would need their API and their
    /// session, so it stays a plain link and the server never sees a foreign id.
    static func isOwnInstanceOrigin(_ origin: String, currentOrigin: String?) -> Bool {
        if let currentOrigin, origin == currentOrigin { return true }
        guard let url = URL(string: origin), url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased()
        else { return false }
        return hostedAppHosts.contains(host)
    }

    struct Selection: Equatable, Sendable {
        let link: BauPostLink
        /// The message says nothing besides the link, so the card can replace it.
        let linkOnly: Bool
    }

    /// The first same-instance Baú permalink in a message body, or nil.
    static func selectCardLink(in body: String?, currentOrigin: String? = currentWebOrigin) -> Selection? {
        guard let body, !body.isEmpty else { return nil }
        for link in findLinks(in: body) where isOwnInstanceOrigin(link.origin, currentOrigin: currentOrigin) {
            return Selection(link: link, linkOnly: bodyIsOnly(link, in: body))
        }
        return nil
    }

    /// The message with the card's own link taken out, so the words the sender
    /// wrote stay and the long URL they pasted does not sit above its own card.
    /// Blank lines the removal leaves are collapsed.
    static func strippingLink(_ link: BauPostLink, from body: String) -> String {
        var text = String(body[..<link.range.lowerBound]) + String(body[link.range.upperBound...])
        text.replace(/[ \t]+\n/, with: "\n")
        text.replace(/\n{3,}/, with: "\n\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Where a tap on a same-instance permalink URL goes, or nil for any other
    /// link (which Safari keeps).
    static func inAppTarget(for url: URL, currentOrigin: String? = currentWebOrigin) -> DeepLinkTarget? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let origin = origin(of: components),
              isOwnInstanceOrigin(origin, currentOrigin: currentOrigin),
              let ref = parsePostPath(components.path)
        else { return nil }
        return .bauPost(serverId: ref.serverId, postId: ref.postId)
    }

    /// The language the server writes a card's teaser in: the app's own
    /// resolved localisation (`en` or `pt-BR`).
    static func cardLanguage(preferred: [String] = Bundle.main.preferredLocalizations) -> String {
        guard let first = preferred.first?.lowercased() else { return "en" }
        if first.hasPrefix("pt") { return "pt-BR" }
        if first.hasPrefix("es") { return "es" }
        return "en"
    }

    // MARK: - Helpers

    private static let trailingPunctuation: Set<Character> = [".", ",", ";", ":", "!", "?", "'", "\""]

    private static func trimmingTrailingPunctuation(_ text: String) -> String {
        var end = text.endIndex
        while end > text.startIndex, trailingPunctuation.contains(text[text.index(before: end)]) {
            end = text.index(before: end)
        }
        return String(text[..<end])
    }

    private static func isUUID(_ value: String) -> Bool {
        value.count == 36 && UUID(uuidString: value) != nil
    }

    /// `scheme://host[:port]`, lowercased, default ports dropped: what
    /// `URL.origin` is in a browser.
    private static func origin(of components: URLComponents) -> String? {
        guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(), !host.isEmpty
        else { return nil }
        var origin = "\(scheme)://\(host)"
        if let port = components.port, !(scheme == "http" && port == 80), !(scheme == "https" && port == 443) {
            origin += ":\(port)"
        }
        return origin
    }
}

// MARK: - The card on the wire

/// `GET /api/servers/:serverId/home/posts/:postId/card`, the `card` member.
///
/// Deliberately small: no comments, no body beyond a teaser, and for a post the
/// viewer cannot open (`locked`) only what the feed itself shows a locked
/// reader. Lenient the way the rest of the Baú models are: a media kind this
/// build has never heard of is a card without a picture, not a dropped card.
struct CommunityHomePostCard: Decodable, Sendable, Equatable {
    struct Author: Decodable, Sendable, Equatable {
        let id: String
        let displayName: String
        let avatarUrl: String?
    }

    enum MediaKind: String, Sendable {
        case image, video, youtube, twitch, tiktok, instagram, file
    }

    /// What goes in the poster slot.
    enum Poster: Equatable, Sendable {
        /// A picture to fetch (an image, or a YouTube poster).
        case image(URL)
        /// A stored video: its first frame, never autoplayed.
        case videoFrame(URL)
        /// Twitch, TikTok, Instagram: nothing we may fetch, but the lime plate
        /// with a play badge still says "video".
        case plate
        /// A text post, a file, a locked upload: no poster, a short plate.
        case none
    }

    let postId: String
    let serverId: String
    let serverName: String
    let title: String?
    let teaser: String?
    /// Nil on a locked post: who wrote a members-only post is withheld.
    let author: Author?
    let mediaKindRaw: String?
    let mediaUrl: String?
    let visibility: String
    let locked: Bool
    let pinned: Bool
    let likeCount: Int
    let commentCount: Int
    let publishedAt: String?

    var mediaKind: MediaKind? { mediaKindRaw.flatMap(MediaKind.init(rawValue:)) }

    /// Anything that plays gets the lime play badge (unless locked).
    var isPlayable: Bool {
        switch mediaKind {
        case .video, .youtube, .twitch, .tiktok, .instagram: true
        default: false
        }
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

    var poster: Poster {
        // https only (the server hands out signed R2 URLs and YouTube posters);
        // plain http is a debug build talking to the local stack.
        let url = mediaUrl.flatMap { URL(string: $0) }.flatMap { Self.isLoadable($0) ? $0 : nil }
        switch mediaKind {
        case .video:
            if let url { return .videoFrame(url) }
            return .plate
        case .image, .youtube:
            if let url { return .image(url) }
            return mediaKind == .youtube ? .plate : .none
        case .twitch, .tiktok, .instagram:
            return .plate
        case .file, nil:
            return .none
        }
    }

    enum CodingKeys: String, CodingKey {
        case postId, serverId, serverName, title, teaser, author
        case mediaKindRaw = "mediaKind"
        case mediaUrl, visibility, locked, pinned, likeCount, commentCount, publishedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        postId = try c.decode(String.self, forKey: .postId)
        serverId = try c.decode(String.self, forKey: .serverId)
        serverName = try c.decodeIfPresent(String.self, forKey: .serverName) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title)
        teaser = try c.decodeIfPresent(String.self, forKey: .teaser)
        author = try c.decodeIfPresent(Author.self, forKey: .author)
        mediaKindRaw = try c.decodeIfPresent(String.self, forKey: .mediaKindRaw)
        mediaUrl = try c.decodeIfPresent(String.self, forKey: .mediaUrl)
        visibility = try c.decodeIfPresent(String.self, forKey: .visibility) ?? "free"
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        likeCount = try c.decodeIfPresent(Int.self, forKey: .likeCount) ?? 0
        commentCount = try c.decodeIfPresent(Int.self, forKey: .commentCount) ?? 0
        publishedAt = try c.decodeIfPresent(String.self, forKey: .publishedAt)
    }

    init(
        postId: String, serverId: String, serverName: String = "", title: String? = nil,
        teaser: String? = nil, author: Author? = nil, mediaKind: String? = nil, mediaUrl: String? = nil,
        visibility: String = "free", locked: Bool = false, pinned: Bool = false,
        likeCount: Int = 0, commentCount: Int = 0, publishedAt: String? = nil
    ) {
        self.postId = postId
        self.serverId = serverId
        self.serverName = serverName
        self.title = title
        self.teaser = teaser
        self.author = author
        self.mediaKindRaw = mediaKind
        self.mediaUrl = mediaUrl
        self.visibility = visibility
        self.locked = locked
        self.pinned = pinned
        self.likeCount = likeCount
        self.commentCount = commentCount
        self.publishedAt = publishedAt
    }
}

struct CommunityHomePostCardResponse: Decodable, Sendable { let card: CommunityHomePostCard }

extension APIClient {
    /// The small card a chat message with a post's permalink is drawn as. A 404
    /// (or any error) means the viewer may not see it, and the caller keeps the
    /// plain link.
    func communityHomePostCard(serverId: String, postId: String, lang: String) async throws -> CommunityHomePostCard {
        let response: CommunityHomePostCardResponse = try await get(
            "/api/servers/\(serverId)/home/posts/\(postId)/card",
            query: [URLQueryItem(name: "lang", value: lang)]
        )
        return response.card
    }
}

// MARK: - Loading

/// What a message row knows about its card.
enum BauCardState: Equatable, Sendable {
    case loading
    case ok(CommunityHomePostCard)
    case unavailable
}

/// An in-memory cache around the card fetch: per post and language, about a
/// minute for an answer (long enough to scroll a channel back and forth, short
/// enough for a like count), half that for a refusal (or a 404 is refetched on
/// every row), and one request in flight per key however many rows ask.
actor BauCardStore {
    typealias Fetch = @Sendable (_ serverId: String, _ postId: String, _ lang: String) async throws -> CommunityHomePostCard

    static let shared = BauCardStore()

    static let okTTL: TimeInterval = 60
    static let missTTL: TimeInterval = 30
    static let capacity = 200

    private struct Entry {
        let id: Int
        var at: TimeInterval
        let task: Task<CommunityHomePostCard?, Never>
        var settled = false
        var isMiss = false
    }

    private var entries: [String: Entry] = [:]
    private var nextId = 0
    private let now: @Sendable () -> TimeInterval

    init(now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSinceReferenceDate }) {
        self.now = now
    }

    func clear() {
        entries.removeAll()
    }

    /// The card, or nil when the viewer may not see it (or the fetch failed;
    /// the short miss TTL lets the next row try again).
    func card(serverId: String, postId: String, lang: String, fetch: @escaping Fetch) async -> CommunityHomePostCard? {
        let key = "\(serverId):\(postId):\(lang)"
        if let hit = entries[key], isFresh(hit) {
            return await hit.task.value
        }
        // Only a settled entry is evicted: dropping one still in flight would
        // stop later rows coalescing with a request that keeps running.
        if entries.count >= Self.capacity {
            guard let oldest = entries.filter({ $0.value.settled }).min(by: { $0.value.at < $1.value.at })?.key else {
                // Capacity is all in-flight requests: this one is fetched
                // uncached and tied to its caller, so it cancels with the row
                // instead of adding to a pile nobody is waiting on.
                return try? await fetch(serverId, postId, lang)
            }
            entries.removeValue(forKey: oldest)
        }
        nextId += 1
        let id = nextId
        // Unstructured on purpose: a row scrolling away cancels its own
        // `.task`, and that must not cancel the fetch every other row shares.
        let task = Task<CommunityHomePostCard?, Never> { try? await fetch(serverId, postId, lang) }
        entries[key] = Entry(id: id, at: now(), task: task)
        let value = await task.value
        if entries[key]?.id == id {
            entries[key]?.settled = true
            entries[key]?.isMiss = value == nil
            entries[key]?.at = now()
        }
        return value
    }

    private func isFresh(_ entry: Entry) -> Bool {
        guard entry.settled else { return true }
        return now() - entry.at < (entry.isMiss ? Self.missTTL : Self.okTTL)
    }
}
