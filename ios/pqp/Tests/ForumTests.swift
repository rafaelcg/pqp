import XCTest
@testable import pqp

/// Forum channels on the phone: the wire shapes (`packages/shared/src/forums.ts`),
/// the two frames, the list reducer (the twin of the web's `forum-list.ts`),
/// where a post opens, and the routing that gets a link or a push there.
final class ForumTests: XCTestCase {

    // MARK: - Fixtures

    private let forumId = "11111111-1111-4111-8111-111111111111"
    private let me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let them = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private let tagBug = "cccccccc-0000-4000-8000-000000000001"
    private let tagGames = "cccccccc-0000-4000-8000-000000000002"

    private func at(_ minutes: Double) -> Date {
        Date(timeIntervalSince1970: 1_800_000_000 + minutes * 60)
    }

    private func post(
        _ id: String,
        created: Double,
        activity: Double? = nil,
        author: String? = nil,
        replies: Int = 0,
        tags: [String] = [],
        resolved: Bool = false,
        pinned: Bool = false,
        title: String? = nil
    ) -> ForumPostSummary {
        ForumPostSummary(
            id: id,
            forumId: forumId,
            title: title ?? "Post \(id)",
            authorId: author ?? them,
            authorName: "Someone",
            createdAt: at(created),
            lastActivityAt: at(activity ?? created),
            pinnedAt: pinned ? at(created) : nil,
            resolvedAt: resolved ? at(created) : nil,
            replyCount: replies,
            tagIds: tags
        )
    }

    private func state(_ posts: [ForumPostSummary], pinned: [ForumPostSummary] = [], more: Bool = false) -> ForumListState {
        ForumList.fromPage(ForumPostListResponse(
            pinned: pinned,
            posts: posts,
            viewer: (pinned + posts).map { ForumPostViewer(postId: $0.id) },
            nextCursor: more ? "next" : nil,
            forumPreviousReadAt: nil,
            counts: ForumCounts(posts: posts.count + pinned.count, open: posts.filter { !$0.isResolved }.count)
        ))
    }

    private func ctx(_ filters: ForumFilters = ForumFilters(), hold: Bool = false, open: String? = nil) -> ForumUpsertContext {
        ForumUpsertContext(filters: filters, viewerId: me, hold: hold, openPostId: open)
    }

    private func message(_ id: String, at minutes: Double, author: String) throws -> Message {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let json = """
        {"id":"\(id)","channelId":"p","authorId":"\(author)","authorName":"x","body":"b",
         "createdAt":"\(formatter.string(from: at(minutes)))"}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }

    // MARK: - Wire

    /// The summary exactly as server-core answers it, card extras included.
    func testTheSummaryDecodesWithEveryField() throws {
        let json = """
        {"id":"\(them)","forumId":"\(forumId)","title":"Valorant fecha sozinho",
         "authorId":"\(me)","authorName":"lari","authorAvatarUrl":null,"authorIsWebhook":false,
         "createdAt":"2026-10-11T23:19:06.610Z","lastActivityAt":"2026-10-11T23:20:06.657Z",
         "pinnedAt":null,"lockedAt":"2026-10-11T23:19:07.907Z","resolvedAt":"2026-10-11T23:19:08.000Z",
         "acceptedAnswerId":"\(tagBug)","preview":"Desde ontem","openingDeleted":false,
         "openingKind":"text","attachmentCount":1,"replyCount":23,"reactionCount":16,
         "topReaction":{"emoji":"🔥","count":12},"thumbnailUrl":"https://x/y.png",
         "thumbnailAttachmentId":"\(tagGames)","thumbnailWidth":640,"thumbnailHeight":480,
         "tagIds":["\(tagBug)","\(tagGames)"]}
        """
        let post = try Coding.decoder.decode(ForumPostSummary.self, from: Data(json.utf8))
        XCTAssertEqual(post.title, "Valorant fecha sozinho")
        XCTAssertTrue(post.isLocked)
        XCTAssertTrue(post.isResolved)
        XCTAssertFalse(post.isPinned)
        XCTAssertEqual(post.acceptedAnswerId, tagBug)
        XCTAssertEqual(post.replyCount, 23)
        XCTAssertEqual(post.topReaction, ForumTopReaction(emoji: "🔥", count: 12))
        XCTAssertEqual(post.thumbnailWidth, 640)
        XCTAssertEqual(post.tagIds, [tagBug, tagGames])
        XCTAssertGreaterThan(post.lastActivityAt, post.createdAt)
    }

    /// A server without the card extras, or with a shape this build cannot
    /// read, costs a detail on the card, not the list.
    func testTheSummaryIsLenientAboutEverythingButItsIdentity() throws {
        let minimal = """
        {"id":"\(them)","forumId":"\(forumId)","title":"t","createdAt":"2026-10-11T23:19:06.610Z",
         "topReaction":"not an object","tagIds":"nope"}
        """
        let post = try Coding.decoder.decode(ForumPostSummary.self, from: Data(minimal.utf8))
        XCTAssertNil(post.authorId)
        XCTAssertEqual(post.lastActivityAt, post.createdAt)
        XCTAssertNil(post.topReaction)
        XCTAssertEqual(post.tagIds, [])
        XCTAssertEqual(post.replyCount, 0)

        let missingTitle = #"{"id":"x","forumId":"y","createdAt":"2026-10-11T23:19:06.610Z"}"#
        XCTAssertThrowsError(try Coding.decoder.decode(ForumPostSummary.self, from: Data(missingTitle.utf8)))
    }

    /// UX #18: a video post carries its signed clip in `thumbnailVideoUrl`
    /// (the picture field stays an image). An older API omits it.
    func testTheSummaryDecodesTheVideoThumbnail() throws {
        let json = """
        {"id":"\(them)","forumId":"\(forumId)","title":"clip","createdAt":"2026-10-11T23:19:06.610Z",
         "openingKind":"attachment","attachmentCount":1,"thumbnailUrl":null,
         "thumbnailVideoUrl":"https://x/clip.mp4?sig=1","tagIds":[]}
        """
        let post = try Coding.decoder.decode(ForumPostSummary.self, from: Data(json.utf8))
        XCTAssertEqual(post.thumbnailVideoUrl, "https://x/clip.mp4?sig=1")
        XCTAssertNil(post.thumbnailUrl)

        let older = #"{"id":"x","forumId":"y","title":"t","createdAt":"2026-10-11T23:19:06.610Z"}"#
        XCTAssertNil(try Coding.decoder.decode(ForumPostSummary.self, from: Data(older.utf8)).thumbnailVideoUrl)

        let explicitNull = #"{"id":"x","forumId":"y","title":"t","createdAt":"2026-10-11T23:19:06.610Z","thumbnailVideoUrl":null}"#
        XCTAssertNil(try Coding.decoder.decode(ForumPostSummary.self, from: Data(explicitNull.utf8)).thumbnailVideoUrl)
    }

    /// One picture or one clip says what it is; several say how many.
    func testThePreviewNamesASinglePictureOrClip() {
        func summary(count: Int, image: String? = nil, video: String? = nil, words: String? = nil) -> ForumPostSummary {
            ForumPostSummary(
                id: "p", forumId: forumId, title: "t", createdAt: at(0),
                preview: words, openingKind: "attachment", attachmentCount: count,
                thumbnailUrl: image, thumbnailVideoUrl: video
            )
        }
        XCTAssertEqual(ForumPostCard.previewText(for: summary(count: 1, image: "https://x/a.png")), "📷 Image")
        XCTAssertEqual(ForumPostCard.previewText(for: summary(count: 1, video: "https://x/a.mp4")), "🎬 Video")
        XCTAssertEqual(ForumPostCard.previewText(for: summary(count: 3, video: "https://x/a.mp4")), "3 attachments")
        XCTAssertEqual(ForumPostCard.previewText(for: summary(count: 1)), "1 attachment")
        // Words always win over the file label.
        XCTAssertEqual(ForumPostCard.previewText(for: summary(count: 1, video: "https://x/a.mp4", words: "olha")), "olha")
    }

    func testTheListAndTheDetailDecode() throws {
        let list = """
        {"pinned":[],"posts":[{"id":"p1","forumId":"f","title":"t","createdAt":"2026-10-11T23:19:06.610Z"}],
         "viewer":[{"postId":"p1","lastReadAt":null,"newReplyCount":0,"following":true}],
         "nextCursor":null,"forumPreviousReadAt":"2026-10-10T10:00:00.000Z","counts":{"posts":142,"open":9}}
        """
        let page = try Coding.decoder.decode(ForumPostListResponse.self, from: Data(list.utf8))
        XCTAssertEqual(page.posts.count, 1)
        XCTAssertEqual(page.viewer.first?.following, true)
        XCTAssertNil(page.viewer.first?.lastReadAt)
        XCTAssertEqual(page.counts, ForumCounts(posts: 142, open: 9))
        XCTAssertNotNil(page.forumPreviousReadAt)

        let detail = """
        {"post":{"id":"p1","forumId":"f","title":"t","createdAt":"2026-10-11T23:19:06.610Z"},
         "viewer":{"postId":"p1","lastReadAt":"2026-10-11T23:30:00.000Z","newReplyCount":3,"following":false},
         "acceptedAnswer":{"messageId":"m","deleted":false,"authorId":null,"authorName":"kaique",
           "excerpt":"Desliga e reinicia","createdAt":"2026-10-11T23:19:10.046Z"},
         "participantCount":9}
        """
        let decoded = try Coding.decoder.decode(ForumPostDetail.self, from: Data(detail.utf8))
        XCTAssertEqual(decoded.viewer.newReplyCount, 3)
        XCTAssertEqual(decoded.acceptedAnswer?.excerpt, "Desliga e reinicia")
        XCTAssertEqual(decoded.participantCount, 9)
    }

    func testSettingsReadAnUnknownSortAsTheDefault() throws {
        let settings = try Coding.decoder.decode(
            ForumSettings.self, from: Data(#"{"requireTag":true,"defaultSort":"hot"}"#.utf8)
        )
        XCTAssertTrue(settings.requireTag)
        XCTAssertEqual(settings.defaultSort, .activity)
    }

    /// `acceptedAnswerId` is tri-state on the wire: absent leaves it, null
    /// unmarks it, an id marks it.
    func testThePatchSendsOnlyWhatChangedAndANullToUnmark() throws {
        func json(_ patch: APIClient.ForumPostPatch) throws -> [String: Any] {
            let data = try Coding.encoder.encode(patch)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertEqual(try json(.init(resolved: true)).keys.sorted(), ["resolved"])
        let clear = try json(.init(acceptedAnswer: .clear))
        XCTAssertTrue(clear["acceptedAnswerId"] is NSNull)
        XCTAssertEqual(try json(.init(acceptedAnswer: .set("m1")))["acceptedAnswerId"] as? String, "m1")
    }

    // MARK: - Frames

    private final class Collected: @unchecked Sendable {
        var events: [RealtimeEvent] = []
    }

    private func events(from frames: [String]) async -> [RealtimeEvent] {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        let collected = Collected()
        let pump = Task {
            for await event in stream { collected.events.append(event) }
        }
        for frame in frames { await client.ingest(Data(frame.utf8)) }
        try? await Task.sleep(for: .milliseconds(200))
        pump.cancel()
        return collected.events
    }

    func testTheTwoForumFramesDecode() async {
        let upsert = """
        {"type":"forum-post-upsert","forumId":"\(forumId)","post":{"id":"p1","forumId":"\(forumId)",
         "title":"Novo","createdAt":"2026-10-11T23:19:06.610Z","replyCount":2}}
        """
        let removed = #"{"type":"forum-post-removed","forumId":"\#(forumId)","postId":"p9"}"#
        let got = await events(from: [upsert, removed])
        XCTAssertEqual(got.count, 2)
        guard case .forumPostUpsert(let fid, let post) = got.first else {
            return XCTFail("expected an upsert, got \(String(describing: got.first))")
        }
        XCTAssertEqual(fid, forumId)
        XCTAssertEqual(post.replyCount, 2)
        guard case .forumPostRemoved(let rfid, let postId) = got.last else {
            return XCTFail("expected a removal")
        }
        XCTAssertEqual(rfid, forumId)
        XCTAssertEqual(postId, "p9")
    }

    /// A summary this build cannot read drops the frame, not the socket.
    func testAnUnreadableUpsertIsDropped() async {
        let broken = #"{"type":"forum-post-upsert","forumId":"f","post":{"id":"p1"}}"#
        let got = await events(from: [broken])
        XCTAssertTrue(got.isEmpty)
    }

    @MainActor
    func testTheLockedRefusalHasItsOwnWords() {
        XCTAssertEqual(
            ChatModel.rejectionCopy(for: "locked"),
            String(localized: "This post is closed. Only staff can reply.")
        )
        XCTAssertNotEqual(ChatModel.rejectionCopy(for: "locked"), ChatModel.rejectionCopy(for: "something-new"))
    }

    // MARK: - Reducer: arrivals and bumps

    func testANewPostAtTheTopAppliesInPlace() {
        let start = state([post("b", created: 10), post("a", created: 5)])
        let next = ForumList.upsert(start, post: post("c", created: 20), ctx: ctx())
        XCTAssertEqual(next.posts.map(\.id), ["c", "b", "a"])
        XCTAssertEqual(next.counts, ForumCounts(posts: 3, open: 3))
        XCTAssertTrue(next.queued.isEmpty)
    }

    /// The rule the file exists for: never reorder under the reader.
    func testANewPostQueuesWhileTheReaderIsScrolledDown() {
        let start = state([post("b", created: 10), post("a", created: 5)])
        let next = ForumList.upsert(start, post: post("c", created: 20), ctx: ctx(hold: true))
        XCTAssertEqual(next.posts.map(\.id), ["b", "a"])
        XCTAssertEqual(next.queued.map(\.id), ["c"])
        let flushed = ForumList.flushQueue(next, filters: ForumFilters(), viewerId: me)
        XCTAssertEqual(flushed.posts.map(\.id), ["c", "b", "a"])
        XCTAssertTrue(flushed.queued.isEmpty)
        // Counted when it arrived, not again when it was applied.
        XCTAssertEqual(flushed.counts?.posts, 3)
    }

    func testABumpMovesACardOnlyUnderActivity() {
        let start = state([post("c", created: 30), post("b", created: 20), post("a", created: 10)])
        let bumped = post("a", created: 10, activity: 40, replies: 1)

        let activity = ForumList.upsert(start, post: bumped, ctx: ctx())
        XCTAssertEqual(activity.posts.map(\.id), ["a", "c", "b"])

        var newest = ForumFilters()
        newest.sort = .created
        let created = ForumList.upsert(start, post: bumped, ctx: ctx(newest))
        XCTAssertEqual(created.posts.map(\.id), ["c", "b", "a"])
        XCTAssertEqual(created.posts.last?.replyCount, 1, "the words still update in place")
    }

    func testABumpWhileHoldingUpdatesTheWordsAndQueuesTheMove() {
        let start = state([post("c", created: 30), post("a", created: 10, title: "old")])
        let bumped = post("a", created: 10, activity: 40, replies: 1, title: "new")
        let held = ForumList.upsert(start, post: bumped, ctx: ctx(hold: true))
        XCTAssertEqual(held.posts.map(\.id), ["c", "a"])
        XCTAssertEqual(held.posts.last?.title, "new")
        XCTAssertEqual(held.queued.map(\.id), ["a"])
        let flushed = ForumList.flushQueue(held, filters: ForumFilters(), viewerId: me)
        XCTAssertEqual(flushed.posts.map(\.id), ["a", "c"])
    }

    func testAPostThatLeavesTheFilterStaysUnderTheReadersHand() {
        var open = ForumFilters()
        open.status = .open
        let start = state([post("b", created: 20), post("a", created: 10)])
        let solved = post("a", created: 10, resolved: true)

        let held = ForumList.upsert(start, post: solved, ctx: ctx(open, hold: true))
        XCTAssertEqual(held.posts.map(\.id), ["b", "a"])
        XCTAssertEqual(held.counts?.open, 1)
        XCTAssertEqual(ForumList.flushQueue(held, filters: open, viewerId: me).posts.map(\.id), ["b"])

        let free = ForumList.upsert(start, post: solved, ctx: ctx(open))
        XCTAssertEqual(free.posts.map(\.id), ["b"])
    }

    /// An old post the loaded pages have not reached arrives with its page.
    func testAPostOlderThanTheLoadedPagesWaitsForPaging() {
        var newest = ForumFilters()
        newest.sort = .created
        let start = state([post("b", created: 20)], more: true)
        let next = ForumList.upsert(start, post: post("old", created: 1, activity: 50, replies: 3), ctx: ctx(newest))
        XCTAssertEqual(next.posts.map(\.id), ["b"])
    }

    /// A new post that fails the filters is counted once, however many
    /// frames name it, and uncounted when it goes.
    func testAFilteredOutArrivalIsCountedOnce() {
        var open = ForumFilters()
        open.status = .open
        let start = state([post("b", created: 20)])
        let solved = post("n", created: 30, resolved: true)
        let once = ForumList.upsert(start, post: solved, ctx: ctx(open))
        let twice = ForumList.upsert(once, post: solved, ctx: ctx(open))
        XCTAssertEqual(twice.posts.map(\.id), ["b"])
        XCTAssertEqual(twice.counts?.posts, 2)
        XCTAssertEqual(ForumList.remove(twice, postId: "n").counts?.posts, 1)
    }

    /// Two arrivals queued newest-first still both land under "Mais novos".
    func testTheQueueAppliesOldestFirst() {
        var newest = ForumFilters()
        newest.sort = .created
        var held = state([post("a", created: 10)])
        held = ForumList.upsert(held, post: post("c", created: 30), ctx: ctx(newest, hold: true))
        held = ForumList.upsert(held, post: post("b", created: 20), ctx: ctx(newest, hold: true))
        let flushed = ForumList.flushQueue(held, filters: newest, viewerId: me)
        XCTAssertEqual(flushed.posts.map(\.id), ["c", "b", "a"])
    }

    // MARK: - Reducer: pins, removal, pages

    func testPinsIgnoreTheFiltersButNotASearch() {
        var filters = ForumFilters()
        filters.tagIds = [tagBug]
        let start = state([])
        let pin = post("p", created: 5, tags: [], pinned: true)
        let pinned = ForumList.upsert(start, post: pin, ctx: ctx(filters))
        XCTAssertEqual(pinned.pinned.map(\.id), ["p"])

        filters.query = "anything"
        let searching = ForumList.upsert(start, post: pin, ctx: ctx(filters))
        XCTAssertTrue(searching.pinned.isEmpty)
    }

    func testUnpinningMovesThePostBackIntoTheList() {
        let start = state([post("b", created: 20)], pinned: [post("p", created: 30, pinned: true)])
        let next = ForumList.upsert(start, post: post("p", created: 30), ctx: ctx())
        XCTAssertTrue(next.pinned.isEmpty)
        XCTAssertEqual(next.posts.map(\.id), ["p", "b"])
    }

    func testARemovalLeavesEveryListAndTheCounts() {
        var start = state([post("b", created: 20), post("a", created: 10, resolved: true)])
        start = ForumList.upsert(start, post: post("c", created: 30), ctx: ctx(hold: true))
        let next = ForumList.remove(ForumList.remove(start, postId: "c"), postId: "a")
        XCTAssertEqual(next.posts.map(\.id), ["b"])
        XCTAssertTrue(next.queued.isEmpty)
        XCTAssertNil(next.viewer["a"])
        // 2 posts (1 open) + the queued arrival, then both removals.
        XCTAssertEqual(next.counts, ForumCounts(posts: 1, open: 1))
        XCTAssertEqual(ForumList.remove(next, postId: "nope"), next)
    }

    func testALaterPageIsDeduplicated() {
        let start = state([post("b", created: 20), post("a", created: 10)], more: true)
        let page = ForumPostListResponse(posts: [post("a", created: 10), post("z", created: 1)], nextCursor: nil)
        let next = ForumList.append(start, page: page)
        XCTAssertEqual(next.posts.map(\.id), ["b", "a", "z"])
        XCTAssertNil(next.nextCursor)
    }

    /// A reconnect must not throw a reader on page 3 back to the top.
    func testAFreshFirstPageKeepsThePagesBelowIt() {
        let loaded = state((0..<6).map { post("p\($0)", created: Double(60 - $0)) }, more: true)
        let fresh = ForumPostListResponse(
            posts: [post("new", created: 100), post("p0", created: 60)], nextCursor: "c2"
        )
        let next = ForumList.refreshFirstPage(loaded, page: fresh)
        XCTAssertEqual(next.posts.first?.id, "new")
        XCTAssertEqual(next.posts.count, 7)
        XCTAssertEqual(next.nextCursor, "next")
    }

    // MARK: - Filters and search

    func testTagsAreAndAndSearchFoldsAccents() {
        let both = post("x", created: 1, tags: [tagBug, tagGames], title: "Notebook não liga")
        let one = post("y", created: 1, tags: [tagBug])
        var filters = ForumFilters()
        filters.tagIds = [tagBug, tagGames]
        XCTAssertTrue(ForumList.passes(both, filters: filters, viewerId: me))
        XCTAssertFalse(ForumList.passes(one, filters: filters, viewerId: me), "a second tag narrows")

        XCTAssertTrue(ForumList.titleMatches("Notebook não liga", query: "  notebook NAO  "))
        XCTAssertTrue(ForumList.titleMatches("Notebook não liga", query: "liga notebook"))
        XCTAssertFalse(ForumList.titleMatches("Notebook não liga", query: "desliga tela"))
    }

    func testMineAndStatusFilter() {
        var filters = ForumFilters()
        filters.mine = true
        XCTAssertTrue(ForumList.passes(post("m", created: 1, author: me), filters: filters, viewerId: me))
        XCTAssertFalse(ForumList.passes(post("t", created: 1), filters: filters, viewerId: me))
        XCTAssertFalse(ForumList.passes(post("m", created: 1, author: me), filters: filters, viewerId: nil))

        filters = ForumFilters()
        filters.status = .resolved
        XCTAssertFalse(ForumList.passes(post("o", created: 1), filters: filters, viewerId: me))
        XCTAssertTrue(filters.isNarrowing)
        XCTAssertFalse(ForumFilters(sort: .created).isNarrowing, "sort is an order, not a filter")
    }

    /// Filters persist per forum; the search is a moment, not a setting.
    func testFiltersPersistWithoutTheSearch() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "forum-tests-\(UUID().uuidString)"))
        let store = ForumFilterStore(defaults: defaults)
        XCTAssertNil(store.load(forumId: "f"))
        store.save(ForumFilters(sort: .created, status: .open, mine: true, tagIds: [tagBug], query: "abc"), forumId: "f")
        let loaded = try XCTUnwrap(store.load(forumId: "f"))
        XCTAssertEqual(loaded.sort, .created)
        XCTAssertEqual(loaded.status, .open)
        XCTAssertTrue(loaded.mine)
        XCTAssertEqual(loaded.tagIds, [tagBug])
        XCTAssertEqual(loaded.query, "")
        XCTAssertNil(store.load(forumId: "other"))
    }

    // MARK: - Unread

    func testTheTwoUnreadLevels() {
        let theirs = post("t", created: 20, activity: 30, replies: 2)
        XCTAssertEqual(ForumList.unreadState(post: theirs, viewer: nil, viewerId: me, forumPreviousReadAt: nil), .new)
        XCTAssertEqual(
            ForumList.unreadState(post: theirs, viewer: nil, viewerId: me, forumPreviousReadAt: at(25)),
            .read, "older than the last visit is not news"
        )
        XCTAssertEqual(
            ForumList.unreadState(post: post("m", created: 20, author: me), viewer: nil, viewerId: me, forumPreviousReadAt: nil),
            .read, "your own post is never new to you"
        )
        let opened = ForumPostViewer(postId: "t", lastReadAt: at(25), newReplyCount: 2)
        XCTAssertEqual(ForumList.unreadState(post: theirs, viewer: opened, viewerId: me, forumPreviousReadAt: nil), .unread(count: 2))
        let caughtUp = ForumPostViewer(postId: "t", lastReadAt: at(31))
        XCTAssertEqual(ForumList.unreadState(post: theirs, viewer: caughtUp, viewerId: me, forumPreviousReadAt: nil), .read)
    }

    func testABumpCountsNewRepliesExceptOnThePostOnScreen() {
        var start = state([post("a", created: 10, replies: 1)])
        start.viewer["a"] = ForumPostViewer(postId: "a", lastReadAt: at(11), newReplyCount: 0)
        let bumped = post("a", created: 10, activity: 20, replies: 4)

        let elsewhere = ForumList.upsert(start, post: bumped, ctx: ctx())
        XCTAssertEqual(elsewhere.viewer["a"]?.newReplyCount, 3)

        let reading = ForumList.upsert(start, post: bumped, ctx: ctx(open: "a"))
        XCTAssertEqual(reading.viewer["a"]?.newReplyCount, 0)
        XCTAssertEqual(reading.viewer["a"]?.lastReadAt, at(20))
    }

    /// A phone clock behind the server's must not leave a read card bold.
    func testMarkingReadIsNeverEarlierThanTheLastActivity() {
        let start = state([post("a", created: 10, activity: 50)])
        let next = ForumList.markRead(start, postId: "a", now: at(40))
        XCTAssertEqual(next.viewer["a"]?.lastReadAt, at(50))
        XCTAssertEqual(ForumList.unreadState(post: next.posts[0], viewer: next.viewer["a"], viewerId: me, forumPreviousReadAt: nil), .read)
    }

    // MARK: - Landing

    func testAFirstVisitPagesBackToTheQuestion() {
        XCTAssertTrue(ForumLanding.needsOlder(hasMore: true, oldest: at(10), previousReadAt: nil))
        XCTAssertFalse(ForumLanding.needsOlder(hasMore: false, oldest: at(10), previousReadAt: nil))
        // A revisit only needs the cursor in the window.
        XCTAssertTrue(ForumLanding.needsOlder(hasMore: true, oldest: at(10), previousReadAt: at(5)))
        XCTAssertFalse(ForumLanding.needsOlder(hasMore: true, oldest: at(10), previousReadAt: at(15)))
    }

    func testWhereAPostOpens() throws {
        let messages = [
            try message("q", at: 0, author: them),
            try message("r1", at: 1, author: them),
            try message("mine", at: 3, author: me),
            try message("r2", at: 4, author: them),
        ]
        XCTAssertEqual(ForumLanding.target(messages: messages, previousReadAt: nil, viewerId: me), .top)
        XCTAssertEqual(
            ForumLanding.target(messages: messages, previousReadAt: at(2), viewerId: me),
            .firstUnread(messageId: "r2"), "your own reply is not news to you"
        )
        XCTAssertEqual(ForumLanding.unreadCount(in: messages, previousReadAt: at(0.5), viewerId: me), 2)
        XCTAssertEqual(ForumLanding.target(messages: messages, previousReadAt: at(9), viewerId: me), .bottom)
        XCTAssertEqual(ForumLanding.target(messages: messages, previousReadAt: at(-1), viewerId: me), .top)
    }

    // MARK: - Composer

    @MainActor
    func testTheComposerSaysWhichFieldARefusalIsAbout() {
        let slow = ForumComposerRefusal.from(
            .rejected(ForumPostRejection(error: "forum_post_rejected", reason: "slow-mode", retryAfterMs: 12_400, automodMessage: nil)),
            now: at(0)
        )
        XCTAssertTrue(slow.isSlowMode)
        XCTAssertEqual(slow.retryUntil, at(0).addingTimeInterval(12.4))
        XCTAssertEqual(slow.message, String(localized: "Slow mode. Wait \(13)s to post again."))

        let bucket = ForumComposerRefusal.from(.rejected(ForumPostRejection(
            error: "forum_post_rejected", reason: "rate-limited", retryAfterMs: 120_000, automodMessage: nil
        )))
        XCTAssertEqual(bucket.message, String(localized: "Too many posts in a short time. Try again in \(2) min."))

        let automod = ForumComposerRefusal.from(.rejected(ForumPostRejection(
            error: "forum_post_rejected", reason: "automod", retryAfterMs: nil, automodMessage: "Sem links"
        )))
        XCTAssertEqual(automod.message, "Sem links")

        XCTAssertEqual(ForumComposerRefusal.from(.refused(status: 422, error: "forum_tag_required")).field, .tags)
        XCTAssertEqual(ForumComposerRefusal.from(.transport("down")).field, .general)
    }

    func testTheDraftIsKeptPerForumAndAnEmptyOneIsForgotten() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "forum-draft-\(UUID().uuidString)"))
        let store = ForumDraftStore(accountId: me, defaults: defaults)
        store.save(ForumDraft(title: "tela azul", body: "", tagIds: [tagBug]), forumId: "f")
        XCTAssertEqual(store.load(forumId: "f")?.title, "tela azul")
        XCTAssertNil(store.load(forumId: "g"))
        XCTAssertNil(
            ForumDraftStore(accountId: them, defaults: defaults).load(forumId: "f"),
            "another account on this phone never sees the draft"
        )
        store.save(ForumDraft(), forumId: "f")
        XCTAssertNil(store.load(forumId: "f"))
    }

    func testSimilarTitlesUnderlineTheMatchedWords() {
        let marked = ForumSimilar.highlighted("Tela azul (WHEA) só no CS2", query: "tela azul jogando cs2")
        let underlined = marked.runs
            .filter { $0.underlineStyle != nil }
            .map { String(marked[$0.range].characters) }
        XCTAssertEqual(underlined, ["Tela", "azul", "CS2"])
    }

    // MARK: - Routing and the list

    func testThePostPermalinkParses() {
        XCTAssertEqual(
            DeepLink.target(path: "/app/server/s1/channel/f1/post/p1"),
            .forumPost(serverId: "s1", forumId: "f1", postId: "p1")
        )
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "pqp://server/s1/channel/f1/post/p1")!),
            .forumPost(serverId: "s1", forumId: "f1", postId: "p1")
        )
        // A push for a reply names the post as a plain channel; the shell
        // resolves it through the post route.
        XCTAssertEqual(DeepLink.target(path: "/app/server/s1/channel/p1"), .channel(serverId: "s1", channelId: "p1"))
        XCTAssertNil(DeepLink.target(path: "/app/server/s1/channel/f1/post"))
    }

    func testAPushForThePostOnScreenDoesNotBanner() {
        XCTAssertFalse(PushPresentation.shouldInterrupt(path: "/app/server/s/channel/f/post/p", visibleChannelId: "p"))
        XCTAssertTrue(PushPresentation.shouldInterrupt(path: "/app/server/s/channel/f/post/p", visibleChannelId: "other"))
    }

    func testAForumIsListedAndOpensItsOwnScreen() throws {
        let json = #"{"id":"f","serverId":"s","kind":"server","name":"ajuda","type":"forum","position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null}"#
        let forum = try Coding.decoder.decode(Channel.self, from: Data(json.utf8))
        XCTAssertTrue(forum.isForum)
        XCTAssertTrue(forum.isListed)
        XCTAssertFalse(forum.opensAsChat, "a forum carries no messages of its own")
    }
}
