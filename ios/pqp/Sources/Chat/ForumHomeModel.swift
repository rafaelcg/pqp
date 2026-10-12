import Foundation
import Observation

/// One forum's list on screen: the pages, the filters, the tags, and the live
/// frames that move them. The rules for where a card goes live in `ForumList`;
/// this object fetches, holds and hands frames to them.
///
/// THE SOCKET SLOT. A connection has one primary channel slot and one thread
/// slot. The forum takes the primary slot (`join-channel` on the forum id is
/// what delivers `forum-post-upsert`), and an open post takes the thread slot
/// (`ChatView` with a forum post joins with `thread-join`), so the list behind
/// an open post keeps receiving frames and is current when the reader comes
/// back to it. That is also how the post on screen hears that it was closed
/// or resolved: the upsert arrives through the forum.
@MainActor
@Observable
final class ForumHomeModel {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    let forum: Channel
    let server: Server

    private(set) var state = ForumListState()
    private(set) var filters: ForumFilters
    private(set) var tags: [ForumTag] = []
    private(set) var settings: ForumSettings = .defaults
    /// Off until asked, which only hides "Novo post": a forum is readable
    /// and repliable whatever the flag says.
    private(set) var config: ForumConfig = .off
    private(set) var permissions: PermissionsSnapshot?
    private(set) var phase: Phase = .loading
    /// Page 1 read again for a filter change: the old list stays, dimmed.
    private(set) var isRefreshing = false
    private(set) var isLoadingMore = false
    private(set) var loadMoreFailed = false
    /// The list is scrolled to its top. Coming back to the top is one of the
    /// two moments the queue applies (the other is the pill).
    var isAtTop = true {
        didSet {
            if isAtTop, !oldValue, !state.queued.isEmpty { flush() }
        }
    }
    /// The post pushed on top of the list, if any. Its replies are read as
    /// they land, so its card never lights up as unread.
    var openPostId: String?

    @ObservationIgnored private weak var session: SessionStore?
    @ObservationIgnored private let handlerKey = "forum-home-\(UUID().uuidString)"
    /// Bumped by every page-1 read; an answer for an older number is dropped.
    @ObservationIgnored private var generation = 0
    /// The forum cursor from the FIRST read of this visit. Every later read
    /// comes after this screen marked the forum read, so its value would be
    /// "now" and every "Novo" badge would vanish on a filter change.
    @ObservationIgnored private var visitPreviousReadAt: Date??
    @ObservationIgnored private var started = false
    @ObservationIgnored private let filterStore: ForumFilterStore
    @ObservationIgnored private var hasSavedFilters: Bool

    init(forum: Channel, server: Server, filterStore: ForumFilterStore = ForumFilterStore()) {
        self.forum = forum
        self.server = server
        self.filterStore = filterStore
        let saved = filterStore.load(forumId: forum.id)
        self.filters = saved ?? ForumFilters()
        self.hasSavedFilters = saved != nil
    }

    // MARK: - Who is looking

    var viewerId: String? { session?.currentUser?.id }

    /// MANAGE_MESSAGES or MANAGE_CHANNELS on this forum: pin, close, delete,
    /// staff-only tags. The server is the gate; this only decides what is offered.
    var isStaff: Bool {
        guard let permissions else { return server.role == "owner" || server.role == "admin" }
        return permissions.can(PermissionBit.manageMessages, channelId: forum.id)
            || permissions.can(PermissionBit.manageChannels, channelId: forum.id)
    }

    var canPost: Bool { config.enabled }

    func tag(id: String) -> ForumTag? { tags.first { $0.id == id } }

    /// The tags somebody may put on a post: staff-only ones only for staff.
    var composerTags: [ForumTag] { isStaff ? tags : tags.filter { !$0.moderated } }

    func viewer(for postId: String) -> ForumPostViewer? { state.viewer[postId] }

    func unreadState(for post: ForumPostSummary) -> ForumUnreadState {
        ForumList.unreadState(
            post: post, viewer: state.viewer[post.id], viewerId: viewerId,
            forumPreviousReadAt: state.forumPreviousReadAt
        )
    }

    var queuedCount: Int { state.queued.count }

    // MARK: - Lifecycle

    /// Once per screen. The handler holds this model weakly and removes itself
    /// once the model is gone, so it stays registered while a post is pushed
    /// on top (the list keeps up) and does not outlive the screen.
    func start(session: SessionStore) async {
        self.session = session
        guard !started else {
            await resume()
            return
        }
        started = true
        let key = handlerKey
        session.eventHandlers[key] = { [weak self, weak session] event in
            guard let self else {
                session?.eventHandlers.removeValue(forKey: key)
                return
            }
            self.apply(event)
        }
        await session.realtime.join(channelId: forum.id)
        await loadEverything()
    }

    /// Coming back to the list from somewhere that took the primary slot
    /// (or after a long time away): join again and merge a fresh page 1.
    func resume() async {
        guard let session else { return }
        await session.realtime.join(channelId: forum.id)
        await refreshFirstPage()
    }

    private func loadEverything() async {
        guard let session else { return }
        async let configAnswer = session.api.forumConfig(serverId: server.id)
        async let tagsAnswer = try? session.api.forumTags(forumId: forum.id)
        async let settingsAnswer = try? session.api.forumSettings(forumId: forum.id)
        async let permissionsAnswer = try? session.api.fetchMemberPermissions(serverId: server.id)
        if let settings = await settingsAnswer {
            self.settings = settings
            // The forum's own order applies until this person picks one.
            if !hasSavedFilters { filters.sort = settings.defaultSort }
        }
        await load()
        if let tags = await tagsAnswer { self.tags = tags }
        config = await configAnswer
        if let permissions = await permissionsAnswer { self.permissions = permissions }
        // Visiting the forum is reading it: the sidebar's pip clears, and the
        // next visit measures "Novo" from here.
        try? await session.api.markRead(channelId: forum.id)
    }

    /// Page 1 for the current filters, replacing the list.
    func load() async {
        guard let session else { return }
        generation += 1
        let request = generation
        if state.isEmpty { phase = .loading } else { isRefreshing = true }
        loadMoreFailed = false
        do {
            let page = try await session.api.forumPosts(forumId: forum.id, filters: filters)
            guard request == generation else { return }
            var next = ForumList.fromPage(page)
            next.forumPreviousReadAt = rememberPreviousRead(page.forumPreviousReadAt)
            // A count this read did not carry keeps the last known one.
            if next.counts == nil { next.counts = state.counts }
            state = next
            phase = .ready
        } catch {
            guard request == generation else { return }
            // A list already on screen keeps it; only a first read fails loud.
            if state.isEmpty {
                phase = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
            }
        }
        isRefreshing = false
    }

    /// Page 1 merged into what is on screen (a reconnect, a return).
    func refreshFirstPage() async {
        guard let session, phase == .ready else { return }
        generation += 1
        let request = generation
        guard let page = try? await session.api.forumPosts(forumId: forum.id, filters: filters),
              request == generation else { return }
        var next = ForumList.refreshFirstPage(state, page: page)
        next.forumPreviousReadAt = rememberPreviousRead(page.forumPreviousReadAt)
        if next.counts == nil { next.counts = state.counts }
        state = next
    }

    private func rememberPreviousRead(_ answer: Date?) -> Date? {
        if let visitPreviousReadAt { return visitPreviousReadAt }
        visitPreviousReadAt = .some(answer)
        return answer
    }

    func loadMore() async {
        guard let session, let cursor = state.nextCursor, !isLoadingMore, phase == .ready else { return }
        isLoadingMore = true
        loadMoreFailed = false
        let request = generation
        do {
            let page = try await session.api.forumPosts(forumId: forum.id, filters: filters, cursor: cursor)
            if request == generation { state = ForumList.append(state, page: page) }
        } catch {
            if request == generation { loadMoreFailed = true }
        }
        isLoadingMore = false
    }

    // MARK: - Filters

    func setFilters(_ next: ForumFilters) {
        guard next != filters else { return }
        let queryOnly = next.sort == filters.sort && next.status == filters.status
            && next.mine == filters.mine && next.tagIds == filters.tagIds
        filters = next
        if !queryOnly {
            filterStore.save(next, forumId: forum.id)
            hasSavedFilters = true
        }
        Task { await load() }
    }

    func toggleTag(_ id: String) {
        var next = filters
        if let index = next.tagIds.firstIndex(of: id) {
            next.tagIds.remove(at: index)
        } else {
            next.tagIds.append(id)
        }
        setFilters(next)
    }

    func clearFilters() {
        var next = filters
        next.status = nil
        next.mine = false
        next.tagIds = []
        next.query = ""
        setFilters(next)
    }

    // MARK: - Live

    func apply(_ event: RealtimeEvent) {
        switch event {
        case .forumPostUpsert(let forumId, let post) where forumId == forum.id:
            let ctx = ForumUpsertContext(
                filters: filters, viewerId: viewerId, hold: !isAtTop, openPostId: openPostId
            )
            state = ForumList.upsert(state, post: post, ctx: ctx)
        case .forumPostRemoved(let forumId, let postId) where forumId == forum.id:
            state = ForumList.remove(state, postId: postId)
        case .ready:
            // The socket came back after a gap; whatever moved meanwhile was
            // never delivered. The client re-asserts the join by itself.
            Task { await refreshFirstPage() }
        case .permissionsUpdate(let serverId, _) where serverId == server.id:
            Task {
                if let fresh = try? await session?.api.fetchMemberPermissions(serverId: server.id) {
                    permissions = fresh
                }
            }
        default:
            break
        }
    }

    /// The pill was pressed (or the reader is back at the top).
    func flush() {
        state = ForumList.flushQueue(state, filters: filters, viewerId: viewerId, openPostId: openPostId)
    }

    // MARK: - From the screens on top

    /// The reader opened a post: its card is read now.
    func markOpened(postId: String) {
        state = ForumList.markRead(state, postId: postId, now: Date())
    }

    /// A post changed under this account's own hand (a PATCH answered).
    func replaced(_ post: ForumPostSummary) {
        let ctx = ForumUpsertContext(filters: filters, viewerId: viewerId, hold: false, openPostId: openPostId)
        state = ForumList.upsert(state, post: post, ctx: ctx)
    }

    /// A post this account just published: on top now, not when the frame lands.
    func published(_ post: ForumPostSummary, viewer: ForumPostViewer?) {
        let ctx = ForumUpsertContext(filters: filters, viewerId: viewerId, hold: false, openPostId: post.id)
        state = ForumList.upsert(state, post: post, ctx: ctx)
        if let viewer { state.viewer[post.id] = viewer }
    }

    func removed(postId: String) {
        state = ForumList.remove(state, postId: postId)
    }

    /// Where the pinned count stands, for "2 de 3" in a post's menu.
    var pinnedCount: Int { state.pinned.count }
}
