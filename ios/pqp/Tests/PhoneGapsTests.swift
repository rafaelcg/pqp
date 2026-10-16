import XCTest
@testable import pqp

/// The phone's four gaps against the web: unread on the server list
/// (`unread-hydration.ts`, `railServerIndicator`), a folded section that hides a
/// mention, the server list following another device (`server-order-saver.ts`),
/// and "Mandar um oi" (`newlyAcceptedFriends`).
final class PhoneGapsTests: XCTestCase {
    private func entry(_ id: String, _ count: Int, _ mentions: Int = 0) -> UnreadEntry {
        UnreadEntry(channelId: id, count: count, mentions: mentions)
    }

    private func server(_ id: String) throws -> Server {
        let json = """
        {"id":"\(id)","name":"S \(id)","ownerId":"o","createdAt":"2026-10-15T12:00:00.000Z",
         "messageRetentionDays":null,"ssoEmailDomain":null,"iconUrl":null,"bannerUrl":null,
         "isCommunity":false,"showOnProfile":true,"communityHomeEnabled":false}
        """
        return try Coding.decoder.decode(Server.self, from: Data(json.utf8))
    }

    // MARK: - Unread totals

    func testTotalsSumTheRowsAndLeaveMutedChannelsOut() {
        let rows = [entry("a", 3, 1), entry("b", 2, 0), entry("muted", 9, 4)]
        let totals = ServerUnread.totals(from: rows) { $0 == "muted" }
        XCTAssertEqual(totals, ServerUnreadTotals(count: 5, mentions: 1))
        XCTAssertEqual(ServerUnread.totals(from: [], isMuted: { _ in false }), .none)
    }

    func testAMentionAloneIsUnread() {
        // A forum row can carry a mention with no unread count.
        let totals = ServerUnread.totals(from: [entry("a", 0, 1)]) { _ in false }
        XCTAssertTrue(totals.isUnread)
        XCTAssertFalse(ServerUnreadTotals.none.isUnread)
    }

    func testTheIndicatorIsNothingForAMutedServerAndAPillForAnyUnread() {
        XCTAssertEqual(ServerUnread.indicator(nil, muted: false), .none)
        XCTAssertEqual(ServerUnread.indicator(.none, muted: false), .none)
        XCTAssertEqual(ServerUnread.indicator(ServerUnreadTotals(count: 4, mentions: 0), muted: true), .none)
        XCTAssertEqual(
            ServerUnread.indicator(ServerUnreadTotals(count: 4, mentions: 0), muted: false),
            ServerUnread.Indicator(showsPill: true, mentions: 0)
        )
        XCTAssertEqual(
            ServerUnread.indicator(ServerUnreadTotals(count: 4, mentions: 2), muted: false),
            ServerUnread.Indicator(showsPill: true, mentions: 2)
        )
        XCTAssertEqual(
            ServerUnread.indicator(ServerUnreadTotals(count: 0, mentions: 1), muted: false),
            ServerUnread.Indicator(showsPill: true, mentions: 1), "a mention alone lights the tile"
        )
    }

    func testALiveFrameAddsOneAndOneMentionWhenItNamesYou() {
        let first = ServerUnread.applyingActivity(nil, mention: false)
        XCTAssertEqual(first, ServerUnreadTotals(count: 1, mentions: 0))
        let second = ServerUnread.applyingActivity(first, mention: true)
        XCTAssertEqual(second, ServerUnreadTotals(count: 2, mentions: 1))
    }

    // MARK: - Which servers are asked about

    func testHydrationSkipsTheOpenAndMutedServersAndStopsAtTheCap() throws {
        var servers: [Server] = []
        for index in 0..<20 {
            servers.append(try server(String(format: "00000000-0000-4000-8000-%012d", index)))
        }
        let open = servers[0].id
        let muted = servers[1].id
        let ids = ServerUnread.serversToHydrate(servers, skipping: open) { $0.id == muted }
        XCTAssertEqual(ids.count, ServerUnread.maxServersHydrated)
        XCTAssertFalse(ids.contains(open))
        XCTAssertFalse(ids.contains(muted))
        XCTAssertEqual(ids.first, servers[2].id, "list order is kept")
    }

    func testAPassIsNotRepeatedWithinAMinuteUnlessForced() {
        let now = Date()
        XCTAssertTrue(ServerUnread.needsPass(last: nil, now: now))
        XCTAssertFalse(ServerUnread.needsPass(last: now.addingTimeInterval(-10), now: now))
        XCTAssertTrue(ServerUnread.needsPass(last: now.addingTimeInterval(-61), now: now))
        XCTAssertTrue(ServerUnread.needsPass(last: now.addingTimeInterval(-1), now: now, force: true))
    }

    func testAServerIsMutedByTheAccountsOwnPreference() {
        var prefs = UserPreferences()
        XCTAssertFalse(ServerUnread.isServerMuted("s1", preferences: prefs))
        prefs.notifications = NotificationPreferences(desktop: nil, default: nil, servers: ["s1": "none", "s2": "all"], channels: nil)
        XCTAssertTrue(ServerUnread.isServerMuted("s1", preferences: prefs))
        XCTAssertFalse(ServerUnread.isServerMuted("s2", preferences: prefs))
    }

    @MainActor
    func testTheStoreDropsZeroAndEqualWrites() {
        let session = SessionStore()
        session.noteServerUnread("s1", ServerUnreadTotals(count: 2, mentions: 0))
        XCTAssertEqual(session.serverUnread["s1"], ServerUnreadTotals(count: 2, mentions: 0))
        session.noteServerUnread("s1", .none)
        XCTAssertNil(session.serverUnread["s1"], "a server with nothing unread is absent")
    }

    @MainActor
    func testAHubReadThatBeganBeforeAListPublishedIsOlderThanIt() {
        let session = SessionStore()
        let began = session.listPublishCount
        session.noteServerUnreadFromList("s1", .none)
        XCTAssertTrue(session.listPublished("s1", since: began), "the list was newer, even though it is closed now")
        XCTAssertFalse(session.listPublished("s2", since: began))
        XCTAssertFalse(session.listPublished("s1", since: session.listPublishCount), "a read that began after it is newer")
    }

    // MARK: - Removals against a server list read

    private struct Row: Identifiable { let id: String }

    @MainActor
    func testAListReadThatBeganBeforeARemovalDoesNotBringTheServerBack() {
        let session = SessionStore()
        let began = session.removedRevision
        session.applyAccountFrame(.serverRemoved(serverId: "gone", reason: .kicked))
        let kept = session.reconcileFetched([Row(id: "gone"), Row(id: "stay")], startedAt: began)
        XCTAssertEqual(kept.map(\.id), ["stay"])
        XCTAssertNotNil(session.removedServers["gone"], "the marker stays: screens of it still close")
    }

    @MainActor
    func testAListReadAfterARemovalThatStillHasTheServerMeansRejoined() {
        let session = SessionStore()
        session.applyAccountFrame(.serverRemoved(serverId: "back", reason: .kicked))
        let began = session.removedRevision
        let kept = session.reconcileFetched([Row(id: "back")], startedAt: began)
        XCTAssertEqual(kept.map(\.id), ["back"])
        XCTAssertNil(session.removedServers["back"], "a stale marker would close the screens of a server they are back in")
    }

    @MainActor
    func testARepeatedStatusFrameStillBumpsTheRevision() {
        let session = SessionStore()
        session.applyAccountFrame(.ownStatus("dnd"))
        let first = session.remoteOwnStatusRevision
        session.applyAccountFrame(.ownStatus("dnd"))
        XCTAssertEqual(session.remoteOwnStatus, "dnd")
        XCTAssertEqual(session.remoteOwnStatusRevision, first + 1)
    }

    // MARK: - The status menu

    func testTheLatestFailedChoiceFallsBackToTheLastConfirmedStatus() {
        var menu = OwnStatusMenu("online")
        let first = menu.choose("dnd")
        let second = menu.choose("dnd")
        menu.failed(first)
        XCTAssertEqual(menu.shown, "dnd", "an older write failing leaves the newer choice alone")
        menu.succeeded(second, status: "dnd")
        XCTAssertEqual(menu.shown, "dnd")
        XCTAssertEqual(menu.confirmed, "dnd")
    }

    func testAFailureNeverRestoresAnUnconfirmedNeighbour() {
        var menu = OwnStatusMenu("online")
        let a = menu.choose("dnd")
        menu.remote("invisible")
        XCTAssertEqual(menu.shown, "dnd", "a frame does not flick the menu mid-choice")
        let b = menu.choose("online")
        menu.failed(a)
        menu.failed(b)
        XCTAssertEqual(menu.shown, "invisible", "back to what the server confirmed, not to choice A")
    }

    func testAnOlderWriteSucceedingAfterANewerOneFailedShowsWhatTheServerHolds() {
        var menu = OwnStatusMenu("online")
        let dnd = menu.choose("dnd")
        let online = menu.choose("online")
        menu.failed(online)
        XCTAssertEqual(menu.shown, "online", "the older write is still in the air, so nothing is settled yet")
        menu.succeeded(dnd, status: "dnd")
        XCTAssertEqual(menu.shown, "dnd")
        XCTAssertEqual(menu.confirmed, "dnd")
    }

    func testAnOlderWriteAnsweringAfterANewerOneSucceededChangesNothing() {
        var menu = OwnStatusMenu("online")
        let dnd = menu.choose("dnd")
        let online = menu.choose("online")
        menu.succeeded(online, status: "online")
        menu.succeeded(dnd, status: "dnd")
        XCTAssertEqual(menu.confirmed, "online")
        XCTAssertEqual(menu.shown, "online")
    }

    func testARemoteStatusShowsAtOnceWhenNothingIsInTheAir() {
        var menu = OwnStatusMenu("online")
        menu.remote("dnd")
        XCTAssertEqual(menu.shown, "dnd")
        menu.remote("dnd")
        XCTAssertEqual(menu.shown, "dnd")
    }

    // MARK: - A folded section that hides a mention

    private func channel(_ id: String) throws -> Channel {
        let json = #"{"id":"\#(id)","serverId":"s","kind":"server","name":"c","type":"text","position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null}"#
        return try JSONDecoder().decode(Channel.self, from: Data(json.utf8))
    }

    func testAFoldedSectionCountsTheMentionsInsideAndNotTheMutedOnes() throws {
        let a = try channel("11111111-2222-4333-8444-555555555555")
        let b = try channel("22222222-2222-4333-8444-555555555555")
        let muted = try channel("33333333-2222-4333-8444-555555555555")
        let unread = [
            a.id: entry(a.id, 3, 2),
            b.id: entry(b.id, 1, 1),
            muted.id: entry(muted.id, 5, 5),
        ]
        let summary = ChannelSectionSummary.make(channels: [a, b, muted], unread: unread) { $0.id == muted.id }
        XCTAssertEqual(summary.mentions, 3)
        XCTAssertTrue(summary.hasUnread)

        let chatter = ChannelSectionSummary.make(channels: [a], unread: [a.id: entry(a.id, 3, 0)]) { _ in false }
        XCTAssertEqual(chatter.mentions, 0, "plain unread stays the white dot")
        XCTAssertTrue(chatter.hasUnread)
    }

    // MARK: - The server list follows another device

    func testTheEchoOfOurOwnSaveIsIgnored() {
        XCTAssertEqual(ServerOrder.remoteAction(origin: "mine", ownOrigin: "mine", saving: false), .ignore)
        XCTAssertEqual(ServerOrder.remoteAction(origin: "mine", ownOrigin: "mine", saving: true), .ignore)
    }

    func testAFrameFromAnotherDeviceIsAppliedUnlessASaveIsInTheAir() {
        XCTAssertEqual(ServerOrder.remoteAction(origin: "theirs", ownOrigin: "mine", saving: false), .apply)
        XCTAssertEqual(ServerOrder.remoteAction(origin: nil, ownOrigin: "mine", saving: false), .apply)
        XCTAssertEqual(ServerOrder.remoteAction(origin: "", ownOrigin: "mine", saving: false), .apply)
        XCTAssertEqual(ServerOrder.remoteAction(origin: "theirs", ownOrigin: "mine", saving: true), .resyncAfterSave)
    }

    // MARK: - Mandar um oi

    private func friend(_ id: String) -> Friend {
        Friend(id: id, displayName: "F\(id)", username: nil, tag: nil, avatarUrl: nil, status: "online", friendsSince: Date())
    }

    private func request(_ id: String) -> FriendRequestEntry {
        FriendRequestEntry(id: id, displayName: "R\(id)", username: nil, tag: nil, avatarUrl: nil, requestedAt: Date())
    }

    func testSomebodyWhoAcceptedOurRequestIsNews() {
        let before = FriendsResponse(friends: [friend("a")], incoming: [], outgoing: [request("b")])
        let after = FriendsResponse(friends: [friend("a"), friend("b")], incoming: [], outgoing: [])
        XCTAssertEqual(FriendsDigest.newlyAccepted(before: before, after: after).map(\.id), ["b"])
    }

    func testSomebodyWeAcceptedOurselvesIsNotNews() {
        let before = FriendsResponse(friends: [], incoming: [request("c")], outgoing: [])
        let after = FriendsResponse(friends: [friend("c")], incoming: [], outgoing: [])
        XCTAssertTrue(FriendsDigest.newlyAccepted(before: before, after: after).isEmpty)
    }

    func testTheFirstSnapshotIsABaselineNeverNews() {
        let after = FriendsResponse(friends: [friend("a"), friend("b")], incoming: [], outgoing: [])
        XCTAssertTrue(FriendsDigest.newlyAccepted(before: nil, after: after).isEmpty)
    }

    func testAnUnchangedListIsNotNews() {
        let same = FriendsResponse(friends: [friend("a")], incoming: [], outgoing: [])
        XCTAssertTrue(FriendsDigest.newlyAccepted(before: same, after: same).isEmpty)
    }

    // MARK: - Removed from a server

    @MainActor
    func testARemovedServerLeavesTheListWithItsSentence() throws {
        let model = HomeModel()
        let kept = try server("00000000-0000-4000-8000-000000000001")
        let gone = try server("00000000-0000-4000-8000-000000000002")
        model.servers = [kept, gone]
        model.dropRemovedServer(gone.id, reason: .banned)
        XCTAssertEqual(model.servers.map(\.id), [kept.id])
        XCTAssertEqual(model.removalNotice, ServerRemovedCopy.sentence(.banned, server: gone.name))
        XCTAssertTrue(model.removalNotice?.contains(gone.name) == true)
        XCTAssertNil(model.error, "its own slot: a re-read of the hub clears `error`")
    }

    @MainActor
    func testAServerThePhoneDoesNotHoldHasNothingToSay() throws {
        let model = HomeModel()
        model.servers = [try server("00000000-0000-4000-8000-000000000001")]
        model.dropRemovedServer("00000000-0000-4000-8000-0000000000ff", reason: .kicked)
        XCTAssertEqual(model.servers.count, 1)
        XCTAssertNil(model.removalNotice)
    }

    func testEveryRemovalHasASentenceThatNamesTheServer() {
        for reason: ServerRemovedReason in [.kicked, .banned, .deleted] {
            XCTAssertTrue(ServerRemovedCopy.sentence(reason, server: "QG").contains("QG"), "\(reason)")
        }
    }
}
