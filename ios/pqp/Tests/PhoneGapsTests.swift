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
}
