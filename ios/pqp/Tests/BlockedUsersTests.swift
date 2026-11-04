import XCTest
@testable import pqp

/// What a block hides on a phone, and that it hides it at once (App Store
/// guideline 1.2): the rules are pure so they are pinned here without a screen.
@MainActor
final class BlockedUsersTests: XCTestCase {
    private let me = "00000000-0000-4000-8000-000000000001"
    private let nuisance = "00000000-0000-4000-8000-000000000002"
    private let friend = "00000000-0000-4000-8000-000000000003"

    private func message(author: String, blocked: Bool = false) throws -> Message {
        try Coding.decoder.decode(Message.self, from: Data("""
        {"id":"\(UUID().uuidString)","channelId":"c1","authorId":"\(author)","authorName":"X",
         "body":"hello","createdAt":"2026-10-15T12:00:00.000Z","blocked":\(blocked)}
        """.utf8))
    }

    private func person(_ id: String, _ name: String) -> PublicUser {
        PublicUser(id: id, displayName: name, username: name, tag: nil, avatarUrl: nil)
    }

    private func dm(_ id: String, _ people: [PublicUser], kind: String = "dm",
                    last: DmLastMessage? = nil) -> DmSummary {
        DmSummary(channelId: id, kind: kind, participants: people, lastMessageAt: Date(),
                  unread: DmUnread(count: 0, mentions: 0), lastMessage: last)
    }

    // MARK: - Messages

    /// The case the old client missed: a message from somebody blocked a moment
    /// ago, or one that arrives over the socket (never stamped per reader), is
    /// hidden because the SET says so, not because the server flagged the row.
    func testAMessageByABlockedAuthorIsHiddenWithoutTheServersFlag() throws {
        let theirs = try message(author: nuisance, blocked: false)
        XCTAssertTrue(BlockRules.hides(theirs, viewerId: me, blocked: [nuisance]))
    }

    func testAnUnblockedAuthorIsShown() throws {
        let theirs = try message(author: friend)
        XCTAssertFalse(BlockRules.hides(theirs, viewerId: me, blocked: [nuisance]))
    }

    /// Before the list has loaded, the flag the server stamps on history still works.
    func testTheServersPerMessageFlagIsStillHonoured() throws {
        let flagged = try message(author: nuisance, blocked: true)
        XCTAssertTrue(BlockRules.hides(flagged, viewerId: me, blocked: []))
    }

    func testYourOwnMessagesAreNeverHidden() throws {
        let mine = try message(author: me, blocked: true)
        XCTAssertFalse(BlockRules.hides(mine, viewerId: me, blocked: [me]))
    }

    // MARK: - Before the list has loaded

    /// A socket frame is not stamped per reader, so until the list is known it
    /// is held back: it could be a blocked person's.
    func testALiveFrameIsHeldBackUntilTheListHasLoaded() throws {
        var live = try message(author: nuisance)
        live.arrivedLive = true
        XCTAssertTrue(BlockRules.hides(live, viewerId: me, blocked: [], listLoaded: false))
        XCTAssertFalse(BlockRules.hides(live, viewerId: me, blocked: [], listLoaded: true))
        XCTAssertTrue(BlockRules.hides(live, viewerId: me, blocked: [nuisance], listLoaded: true))
    }

    /// A page from history carries the server's flag, so it needs no list.
    func testAFetchedMessageIsNotHeldBackWhileTheListLoads() throws {
        let fetched = try message(author: friend)
        XCTAssertFalse(BlockRules.hides(fetched, viewerId: me, blocked: [], listLoaded: false))
    }

    func testYourOwnLiveEchoIsNeverHeldBack() throws {
        var mine = try message(author: me)
        mine.arrivedLive = true
        XCTAssertFalse(BlockRules.hides(mine, viewerId: me, blocked: [], listLoaded: false))
    }

    // MARK: - A failed write

    /// Only an answer the server sent and meant is definite. A dropped
    /// connection or an unreadable reply may have followed a commit, so the
    /// store asks the server instead of rolling back.
    func testOnlyDefiniteRefusalsAreRolledBack() {
        XCTAssertTrue(BlockedUsers.isAmbiguous(APIError.transport("offline")))
        XCTAssertTrue(BlockedUsers.isAmbiguous(APIError.decoding("bad body")))
        XCTAssertTrue(BlockedUsers.isAmbiguous(CancellationError()))
        XCTAssertFalse(BlockedUsers.isAmbiguous(APIError.server(status: 400, message: "no")))
        XCTAssertFalse(BlockedUsers.isAmbiguous(APIError.notFound("User not found")))
        XCTAssertFalse(BlockedUsers.isAmbiguous(APIError.unauthorized))
        XCTAssertFalse(BlockedUsers.isAmbiguous(APIError.rateLimited(retryAfter: 3)))
    }

    // MARK: - The store

    func testBlockedSetDrivesVisibilityBothWays() throws {
        let store = BlockedUsers()
        let theirs = try message(author: nuisance)
        XCTAssertFalse(BlockRules.hides(theirs, viewerId: me, blocked: store.ids))
        store.seed([nuisance])
        XCTAssertTrue(BlockRules.hides(theirs, viewerId: me, blocked: store.ids))
        store.clear()
        XCTAssertFalse(BlockRules.hides(theirs, viewerId: me, blocked: store.ids))
        XCTAssertFalse(store.hasLoaded)
    }

    // MARK: - Conversations

    func testAOneToOneWithABlockedPersonLeavesTheList() {
        let list = [dm("a", [person(nuisance, "Nuisance")]), dm("b", [person(friend, "Friend")])]
        let shown = BlockRules.visible(list, blocked: [nuisance])
        XCTAssertEqual(shown.map(\.channelId), ["b"])
    }

    func testAGroupStaysButLosesABlockedPersonsPreviewLine() {
        let line = DmLastMessage(authorId: nuisance, authorName: "Nuisance", preview: "something nasty",
                                 isAttachment: false, isGif: false)
        let group = dm("g", [person(nuisance, "Nuisance"), person(friend, "Friend")], kind: "group", last: line)
        let shown = BlockRules.visible([group], blocked: [nuisance])
        XCTAssertEqual(shown.count, 1)
        XCTAssertNil(shown[0].lastMessage)
    }

    func testAGroupKeepsAFriendsPreviewLine() {
        let line = DmLastMessage(authorId: friend, authorName: "Friend", preview: "hi",
                                 isAttachment: false, isGif: false)
        let group = dm("g", [person(nuisance, "Nuisance"), person(friend, "Friend")], kind: "group", last: line)
        XCTAssertEqual(BlockRules.visible([group], blocked: [nuisance])[0].lastMessage?.preview, "hi")
    }

    func testNothingBlockedLeavesTheListUntouched() {
        let list = [dm("a", [person(nuisance, "Nuisance")])]
        XCTAssertEqual(BlockRules.visible(list, blocked: []), list)
    }

    // MARK: - Stories

    func testABlockedPersonsRingLeavesTheStripAndOwnStays() {
        func item(_ id: String) -> StoryStripItem {
            StoryStripItem(
                author: StoryAuthor(id: id, displayName: id, avatarUrl: nil),
                storyIds: [id + "-s"], latestAt: Date(timeIntervalSince1970: 0),
                expiresAt: Date(timeIntervalSince1970: 9_999_999_999), unseen: true, hasCall: false
            )
        }
        let strip = StoryStrip(enabled: true, canPost: true, own: item(me),
                               items: [item(nuisance), item(friend)], firstRunHint: false)
        let next = StoryRules.droppingBlocked(strip, blocked: [nuisance])
        XCTAssertEqual(next.items.map(\.id), [friend])
        XCTAssertEqual(next.own?.id, me)
        XCTAssertEqual(StoryRules.droppingBlocked(strip, blocked: []), strip)
    }
}
