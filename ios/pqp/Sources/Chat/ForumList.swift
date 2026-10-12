import Foundation

// The forum list as the phone holds it, and every change a live frame can
// make to it. Free of SwiftUI so the rules are tested rather than eyeballed.
// A port of the web's `client/src/lib/forum-list.ts` (forum PR 3b): the two
// clients read the same frames and must agree on where a card goes.
//
// THE RULE THIS FILE EXISTS FOR: a list never reorders under the reader. A new
// post or a bump that arrives while the reader is scrolled down is QUEUED, and
// the screen says so with a pill ("3 posts com novidade"). Only at the top
// does a change apply in place. An edit (title, tags, status) never moves a
// card, held or not.
//
// A bump moves a card only under `activity`, and only while the post still
// passes the filters on screen: under `created` the order is the creation
// order and a reply cannot change it.

/// What narrows the list, and its order. Persisted per forum on this device,
/// except the search, which is a moment and not a setting.
struct ForumFilters: Codable, Equatable, Sendable {
    var sort: ForumSort = .activity
    var status: ForumStatusFilter?
    var mine = false
    /// AND: a post must carry every one of these.
    var tagIds: [String] = []
    /// The title search, trimmed. Empty is no search.
    var query = ""

    /// Anything that narrows (sort is an order, not a filter).
    var isNarrowing: Bool {
        status != nil || mine || !tagIds.isEmpty || !trimmedQuery.isEmpty
    }

    var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private enum CodingKeys: String, CodingKey { case sort, status, mine, tagIds }

    init(sort: ForumSort = .activity, status: ForumStatusFilter? = nil, mine: Bool = false, tagIds: [String] = [], query: String = "") {
        self.sort = sort
        self.status = status
        self.mine = mine
        self.tagIds = tagIds
        self.query = query
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sort = (try? c.decodeIfPresent(ForumSort.self, forKey: .sort)) ?? .activity
        status = (try? c.decodeIfPresent(ForumStatusFilter.self, forKey: .status)) ?? nil
        mine = (try? c.decodeIfPresent(Bool.self, forKey: .mine)) ?? false
        tagIds = (try? c.decodeIfPresent([String].self, forKey: .tagIds)) ?? []
        query = ""
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sort, forKey: .sort)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encode(mine, forKey: .mine)
        try c.encode(tagIds, forKey: .tagIds)
    }
}

/// Filters and sort, remembered per forum on this device. UserDefaults, not
/// the account: how somebody narrows a list on a phone is about this screen.
struct ForumFilterStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(_ forumId: String) -> String { "pqp.forum.filters.\(forumId)" }

    /// Nil when nothing was saved, so the forum's own default sort applies.
    func load(forumId: String) -> ForumFilters? {
        guard let data = defaults.data(forKey: key(forumId)) else { return nil }
        return try? JSONDecoder().decode(ForumFilters.self, from: data)
    }

    func save(_ filters: ForumFilters, forumId: String) {
        guard let data = try? JSONEncoder().encode(filters) else { return }
        defaults.set(data, forKey: key(forumId))
    }
}

struct ForumListState: Equatable, Sendable {
    var pinned: [ForumPostSummary] = []
    var posts: [ForumPostSummary] = []
    var viewer: [String: ForumPostViewer] = [:]
    var nextCursor: String?
    var counts: ForumCounts?
    var forumPreviousReadAt: Date?
    /// Live changes held while the reader is busy, newest last, one per post.
    var queued: [ForumPostSummary] = []

    var isEmpty: Bool { pinned.isEmpty && posts.isEmpty }

    func post(id: String) -> ForumPostSummary? {
        pinned.first { $0.id == id } ?? posts.first { $0.id == id }
    }
}

struct ForumUpsertContext {
    var filters: ForumFilters
    var viewerId: String?
    /// The reader is scrolled down: queue, do not move.
    var hold: Bool
    /// The post open on screen, whose replies the reader watches land.
    var openPostId: String?
}

/// Two unread levels (UX §2.3): `new` is a post the viewer never opened, by
/// somebody else, created after their last visit to the forum; `unread` is
/// one they opened that has had replies since.
enum ForumUnreadState: Equatable {
    case new
    case unread(count: Int)
    case read
}

enum ForumList {
    // MARK: Pages

    /// Page 1 replaces everything, the queue included (it is now on screen).
    static func fromPage(_ page: ForumPostListResponse) -> ForumListState {
        let pinnedIds = Set(page.pinned.map(\.id))
        var viewer: [String: ForumPostViewer] = [:]
        for one in page.viewer { viewer[one.postId] = one }
        return ForumListState(
            pinned: page.pinned,
            posts: page.posts.filter { !pinnedIds.contains($0.id) },
            viewer: viewer,
            nextCursor: page.nextCursor,
            counts: page.counts,
            forumPreviousReadAt: page.forumPreviousReadAt,
            queued: []
        )
    }

    /// A later page, deduplicated by id: a keyset page read after a bump moved
    /// a card up can hand back a post already on screen.
    static func append(_ state: ForumListState, page: ForumPostListResponse) -> ForumListState {
        var next = state
        let seen = Set(state.pinned.map(\.id) + state.posts.map(\.id))
        next.posts += page.posts.filter { !seen.contains($0.id) }
        for one in page.viewer { next.viewer[one.postId] = one }
        next.nextCursor = page.nextCursor
        return next
    }

    /// Page 1 read again (a reconnect, coming back to the list), MERGED into
    /// what the reader has: the fresh page replaces the top, the pages below
    /// it stay with the cursor that continues them, the queue stays queued.
    static func refreshFirstPage(_ state: ForumListState, page: ForumPostListResponse) -> ForumListState {
        var fresh = fromPage(page)
        let shown = Set(fresh.pinned.map(\.id) + fresh.posts.map(\.id))
        let tail = state.posts.filter { !shown.contains($0.id) }
        let keepsTail = !tail.isEmpty && state.posts.count > page.posts.count
        if keepsTail {
            fresh.posts += tail
            fresh.nextCursor = state.nextCursor
        }
        fresh.viewer = state.viewer.merging(fresh.viewer) { _, new in new }
        fresh.queued = state.queued.filter { !shown.contains($0.id) }
        return fresh
    }

    // MARK: Search and filters

    /// Lowercased with accents folded: "Notebook não liga" matches "notebook nao".
    static func fold(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Every word of the query appears in the title, in any order.
    static func titleMatches(_ title: String, query: String) -> Bool {
        let words = fold(query).split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let folded = fold(title)
        return words.allSatisfy { folded.contains($0) }
    }

    /// The same filter the server applies, for a post a frame just handed us.
    static func passes(_ post: ForumPostSummary, filters: ForumFilters, viewerId: String?) -> Bool {
        if filters.status == .open && post.resolvedAt != nil { return false }
        if filters.status == .resolved && post.resolvedAt == nil { return false }
        if filters.mine && (viewerId == nil || post.authorId != viewerId) { return false }
        if filters.tagIds.contains(where: { !post.tagIds.contains($0) }) { return false }
        let query = filters.trimmedQuery
        if !query.isEmpty && !titleMatches(post.title, query: query) { return false }
        return true
    }

    /// Newest first, then id descending: the server's keyset order.
    static func sortsBefore(_ a: ForumPostSummary, _ b: ForumPostSummary, sort: ForumSort) -> Bool {
        let ka = sort == .activity ? a.lastActivityAt : a.createdAt
        let kb = sort == .activity ? b.lastActivityAt : b.createdAt
        if ka != kb { return ka > kb }
        return a.id > b.id
    }

    // MARK: Live frames

    private static func replace(_ list: [ForumPostSummary], with post: ForumPostSummary) -> [ForumPostSummary] {
        list.map { $0.id == post.id ? post : $0 }
    }

    private static func without(_ list: [ForumPostSummary], _ id: String) -> [ForumPostSummary] {
        list.filter { $0.id != id }
    }

    /// Where a post the list did not hold belongs, or nil when it sorts past
    /// the loaded pages (the next page brings it).
    private static func insertSorted(
        _ list: [ForumPostSummary], _ post: ForumPostSummary, sort: ForumSort, complete: Bool
    ) -> [ForumPostSummary]? {
        guard let index = list.firstIndex(where: { sortsBefore(post, $0, sort: sort) }) else {
            return complete ? list + [post] : nil
        }
        var next = list
        next.insert(post, at: index)
        return next
    }

    /// Frames carry no viewer state, so this is a local estimate until the
    /// next read: a bump of a post the reader opened before counts its new
    /// replies, and the post the reader has open counts nothing.
    private static func nextViewer(
        previous: ForumPostSummary?, post: ForumPostSummary, viewer: ForumPostViewer?, ctx: ForumUpsertContext
    ) -> ForumPostViewer? {
        if ctx.openPostId == post.id {
            return ForumPostViewer(
                postId: post.id, lastReadAt: post.lastActivityAt, newReplyCount: 0,
                following: viewer?.following ?? false
            )
        }
        guard var viewer, let previous, viewer.lastReadAt != nil else { return viewer }
        let added = post.replyCount - previous.replyCount
        guard added > 0 else { return viewer }
        viewer.newReplyCount = min(ForumLimits.unreadCap, viewer.newReplyCount + added)
        return viewer
    }

    private static func adjustCounts(
        _ counts: ForumCounts?, previous: ForumPostSummary?, post: ForumPostSummary, isNew: Bool
    ) -> ForumCounts? {
        guard let counts else { return nil }
        var posts = counts.posts
        var open = counts.open
        if isNew {
            posts += 1
            if post.resolvedAt == nil { open += 1 }
        } else if let previous {
            let wasOpen = previous.resolvedAt == nil
            let isOpen = post.resolvedAt == nil
            if wasOpen && !isOpen { open = max(0, open - 1) }
            if !wasOpen && isOpen { open += 1 }
        }
        return ForumCounts(posts: posts, open: open)
    }

    /// One `forum-post-upsert`: edits apply in place, moves and arrivals queue
    /// while the reader is busy, a bump moves a card only under `activity` and
    /// only when it still passes the filters.
    static func upsert(_ state: ForumListState, post: ForumPostSummary, ctx: ForumUpsertContext) -> ForumListState {
        let filters = ctx.filters
        let previous = state.pinned.first { $0.id == post.id }
            ?? state.posts.first { $0.id == post.id }
            ?? state.queued.first { $0.id == post.id }
        var viewer = state.viewer
        if let updated = nextViewer(previous: previous, post: post, viewer: state.viewer[post.id], ctx: ctx) {
            viewer[post.id] = updated
        }
        // A post the list never held, with no replies and newer than anything
        // it did hold, is a new post; anything else unknown is an old post
        // bumped or edited beyond the loaded pages.
        let newestCreated = (state.pinned + state.posts).map(\.createdAt).max()
        let brandNew = previous == nil && post.replyCount == 0
            && (newestCreated.map { post.createdAt > $0 } ?? true)
        let counts = adjustCounts(state.counts, previous: previous, post: post, isNew: brandNew)

        // Pins sit above every filter and only vanish under a search.
        let wasPinned = state.pinned.contains { $0.id == post.id }
        if post.pinnedAt != nil && filters.trimmedQuery.isEmpty {
            var next = state
            next.pinned = wasPinned ? replace(state.pinned, with: post) : state.pinned + [post]
            next.posts = without(state.posts, post.id)
            next.queued = without(state.queued, post.id)
            next.viewer = viewer
            next.counts = counts
            return next
        }
        var base = state
        if wasPinned { base.pinned = without(state.pinned, post.id) }
        base.viewer = viewer
        base.counts = counts

        let passes = passes(post, filters: filters, viewerId: ctx.viewerId)

        if let index = base.posts.firstIndex(where: { $0.id == post.id }) {
            let old = base.posts[index]
            if !passes {
                // It left the filter. Under the reader's hand it stays put,
                // updated, until they let go.
                base.posts = ctx.hold ? replace(base.posts, with: post) : without(base.posts, post.id)
                return base
            }
            let moved = filters.sort == .activity && post.lastActivityAt > old.lastActivityAt
            if !moved || index == 0 {
                base.posts = replace(base.posts, with: post)
                return base
            }
            if ctx.hold {
                // The words update now; the move waits for the pill.
                base.posts = replace(base.posts, with: post)
                base.queued = without(base.queued, post.id) + [post]
                return base
            }
            let rest = without(base.posts, post.id)
            base.posts = insertSorted(rest, post, sort: filters.sort, complete: true) ?? rest
            return base
        }

        if !passes {
            base.queued = without(base.queued, post.id)
            return base
        }
        if filters.sort == .created && !brandNew {
            // A reply cannot move a post under "Mais novos", and an old post
            // the pages have not reached yet arrives with them.
            return base
        }
        guard let placed = insertSorted(base.posts, post, sort: filters.sort, complete: base.nextCursor == nil) else {
            base.queued = without(base.queued, post.id)
            return base
        }
        if ctx.hold {
            base.queued = without(base.queued, post.id) + [post]
            return base
        }
        base.posts = placed
        return base
    }

    /// One `forum-post-removed`: gone from every list, the queue included.
    static func remove(_ state: ForumListState, postId: String) -> ForumListState {
        // A post still in the queue was counted when it arrived, so it is
        // uncounted when it goes too.
        let previous = state.post(id: postId) ?? state.queued.first { $0.id == postId }
        guard previous != nil else { return state }
        var next = state
        if let previous, let counts = state.counts {
            next.counts = ForumCounts(
                posts: max(0, counts.posts - 1),
                open: previous.resolvedAt == nil ? max(0, counts.open - 1) : counts.open
            )
        }
        next.pinned = without(state.pinned, postId)
        next.posts = without(state.posts, postId)
        next.queued = without(state.queued, postId)
        next.viewer.removeValue(forKey: postId)
        return next
    }

    /// The pill was pressed (or the reader is back at the top): apply the queue.
    static func flushQueue(_ state: ForumListState, filters: ForumFilters, viewerId: String?, openPostId: String? = nil) -> ForumListState {
        let ctx = ForumUpsertContext(filters: filters, viewerId: viewerId, hold: false, openPostId: openPostId)
        // Queued posts were counted when they were queued; applying them is
        // not a second arrival.
        var next = state
        next.queued = []
        next.counts = nil
        for post in state.queued {
            let onScreen = next.posts.contains { $0.id == post.id }
            if onScreen && filters.sort == .activity {
                // Its words were already updated in place when it was queued,
                // so an upsert would see no bump: the move is what was held.
                let rest = without(next.posts, post.id)
                next.posts = passes(post, filters: filters, viewerId: viewerId)
                    ? (insertSorted(rest, post, sort: .activity, complete: true) ?? rest)
                    : rest
                continue
            }
            next = upsert(next, post: post, ctx: ctx)
        }
        next.counts = state.counts
        // A card that left the filter while held stayed put; letting go is
        // when it leaves.
        next.posts = next.posts.filter { passes($0, filters: filters, viewerId: viewerId) }
        return next
    }

    /// The reader opened a post: read locally, never earlier than its own
    /// last activity (a phone clock behind the server's would leave it bold).
    static func markRead(_ state: ForumListState, postId: String, now: Date) -> ForumListState {
        var next = state
        let at = state.post(id: postId).map { max($0.lastActivityAt, now) } ?? now
        next.viewer[postId] = ForumPostViewer(
            postId: postId, lastReadAt: at, newReplyCount: 0,
            following: state.viewer[postId]?.following ?? false
        )
        return next
    }

    /// One post replaced wherever it is drawn (an optimistic edit or its rollback).
    static func patch(_ state: ForumListState, post: ForumPostSummary) -> ForumListState {
        var next = state
        next.pinned = replace(state.pinned, with: post)
        next.posts = replace(state.posts, with: post)
        return next
    }

    static func unreadState(
        post: ForumPostSummary, viewer: ForumPostViewer?, viewerId: String?, forumPreviousReadAt: Date?
    ) -> ForumUnreadState {
        let mine = viewerId != nil && post.authorId == viewerId
        guard let viewer, let lastReadAt = viewer.lastReadAt else {
            if mine { return .read }
            if let forumPreviousReadAt, post.createdAt <= forumPreviousReadAt { return .read }
            return .new
        }
        if viewer.newReplyCount > 0 || post.lastActivityAt > lastReadAt {
            return .unread(count: viewer.newReplyCount)
        }
        return .read
    }
}

// MARK: - Where a post opens

/// Where a post opens (UX §2.4 #26), the twin of the web's
/// `client/src/lib/forum-landing.ts`: on the question for a first visit, on
/// the first reply the reader has not seen for a later one, and never on the
/// newest reply just because that is where a history page ends.
enum ForumLanding {
    /// Older pages read at most before landing. A page is 50 messages.
    static let maxPages = 20

    enum Target: Equatable {
        /// The title and the opening message: a first visit.
        case top
        /// The "Novas" divider sits above this message.
        case firstUnread(messageId: String)
        /// Read before and nothing new: where the conversation is now.
        case bottom
    }

    /// True while the landing point is above the loaded window: a first visit
    /// needs the very first message, a revisit needs a message at or before
    /// the cursor so the first unread one is on screen with its divider.
    static func needsOlder(hasMore: Bool, oldest: Date?, previousReadAt: Date?) -> Bool {
        guard hasMore else { return false }
        guard let previousReadAt else { return true }
        guard let oldest else { return true }
        return oldest > previousReadAt
    }

    /// The first message after the cursor that somebody else wrote. The
    /// reader's own replies are not news to them.
    static func firstUnread(in messages: [Message], previousReadAt: Date, viewerId: String?) -> Message? {
        messages.first { $0.createdAt > previousReadAt && $0.authorId != viewerId && !$0.isPending }
    }

    /// Replies after the cursor by others, for the "N novas" pill.
    static func unreadCount(in messages: [Message], previousReadAt: Date?, viewerId: String?) -> Int {
        guard let previousReadAt else { return 0 }
        return messages.filter { $0.createdAt > previousReadAt && $0.authorId != viewerId && !$0.isPending }.count
    }

    static func target(messages: [Message], previousReadAt: Date?, viewerId: String?) -> Target {
        guard let previousReadAt else { return .top }
        if let first = firstUnread(in: messages, previousReadAt: previousReadAt, viewerId: viewerId) {
            // The opening message unread means the reader never saw the
            // question either: the question is where to start.
            return first.id == messages.first?.id ? .top : .firstUnread(messageId: first.id)
        }
        return .bottom
    }
}
