import XCTest
@testable import pqp

// The Farol findings on #1781, each pinned: a failed read must not consume the
// only live frame, the flag is asked again after a reconnect, a card is spent
// by the song that opens (not by the tap that asked for it), an undo restores the
// waiting part whatever the next read does, and a search is asked again when a
// result is edited.

@MainActor
final class JamPublicFollowupTests: XCTestCase {
    private var keep: SessionStore?

    private func store(_ handler: @escaping @Sendable (URLRequest) -> (TimeInterval, Int, Data)) -> JamPublicStore {
        JamStubURLProtocol.handler = handler
        let session = makePublicSession()
        keep = session
        return session.jamPublic
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: Double = 3) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out waiting") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func testAFailedInboxReadDoesNotConsumeTheOnlyLiveTakeFrame() async throws {
        let log = LockedBox<[Sent]>([])
        let status = LockedBox(500)
        let store = store(publicRoute(
            log: log, inbox: LockedBox(inboxJSON([("t1", "bass")])), inboxStatus: status
        ))
        store.apply(.notice(JamPublicNoticeFrame(kind: .take, songId: "s1", title: "Lua cheia", admitted: false, instrument: .bass)))
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(store.liveTake, "the inbox could not be read, so nothing can be judged yet")
        status.value = 200
        store.reconnected()
        try await waitUntil { store.liveTake != nil }
        XCTAssertEqual(store.liveTake?.songId, "s1", "the next read that succeeded in full remembered the frame")
    }

    /// A read that was already out when the frame arrived was produced BEFORE it:
    /// its lists may not hold the song. It must not consume the frame; the read
    /// queued behind it, started after, does.
    func testAReadThatWasOutBeforeTheFrameCannotConsumeIt() async throws {
        let log = LockedBox<[Sent]>([])
        let inbox = LockedBox(inboxJSON([]))
        let inboxCalls = LockedBox(0)
        let base = publicRoute(log: log, inbox: inbox)
        let store = store { request in
            if request.url?.path == "/api/jam-public/inbox" {
                inboxCalls.value += 1
                // The first read is held: its answer (the lists as they were) lands late.
                let stale = inbox.value
                return (inboxCalls.value == 1 ? 0.5 : 0, 200, Data(stale.utf8))
            }
            return base(request)
        }
        let inFlight = Task { await store.refresh() }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(inboxCalls.value, 1, "the first read is out")
        // The take arrives and is in the inbox now; the read that is out will not say so.
        inbox.value = inboxJSON([("t1", "bass")])
        store.apply(.notice(JamPublicNoticeFrame(kind: .take, songId: "s1", title: "Lua cheia", admitted: false, instrument: .bass)))
        await inFlight.value
        try await waitUntil { store.liveTake != nil }
        XCTAssertEqual(store.liveTake?.songId, "s1", "the read queued after the frame judged it")
        XCTAssertGreaterThanOrEqual(inboxCalls.value, 2)
    }

    func testTheFlagIsAskedAgainAfterAReconnectAndOffClearsWhatWasHeld() async throws {
        let log = LockedBox<[Sent]>([])
        let enabled = LockedBox(true)
        let store = store(publicRoute(
            log: log, enabled: enabled,
            inbox: LockedBox(inboxJSON([("t1", "bass")])),
            notices: LockedBox(noticesJSON([("n1", "take", "s1")]))
        ))
        await store.refresh()
        XCTAssertEqual(store.inbox.count, 1)
        enabled.value = false
        store.reconnected()
        try await waitUntil { !store.enabled }
        XCTAssertTrue(store.inbox.isEmpty)
        XCTAssertTrue(store.cards.isEmpty)
    }

    func testAnOrdinaryRefreshDoesNotAskTheFlagAgain() async {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(log: log))
        await store.refresh()
        await store.refresh()
        XCTAssertEqual(log.value.filter { $0.path == "/api/jam-public/config" }.count, 1)
    }

    func testOpeningASongSpendsItsNoticesAndOnlyIts() async throws {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(
            log: log,
            inbox: LockedBox(inboxJSON([("t1", "bass")])),
            notices: LockedBox(noticesJSON([("n1", "take", "s1"), ("n2", "accepted", "s2")]))
        ))
        await store.refresh()
        store.ackNotices(forSong: "s1")
        XCTAssertEqual(store.cards.map(\.id), ["n2"])
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(log.value.filter { $0.path.hasSuffix("/ack") }.compactMap { $0.json?["id"] as? String }, ["n1"])
    }

    func testAnUndoPutsThePartBackEvenWhenTheNextInboxReadFails() async throws {
        let log = LockedBox<[Sent]>([])
        let inboxStatus = LockedBox(200)
        let inboxBody = LockedBox(inboxJSON([("t1", "bass"), ("t2", "drums")]))
        let base = publicRoute(
            log: log, inbox: inboxBody,
            notices: LockedBox(noticesJSON([("n1", "take", "s1")])), inboxStatus: inboxStatus
        )
        JamStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            if method == "GET", path.hasSuffix("/api/jam/config") { return (0, 200, Data(#"{"enabled":true,"uploads":true}"#.utf8)) }
            if method == "GET", path == "/api/jam-songs/s1" { return (0, 200, Data(requestDetail.utf8)) }
            if method == "PATCH", path.hasPrefix("/api/jam-tracks/") {
                let inMix = (sentBody(request)?["inMix"] as? Bool) ?? false
                return (0, 200, Data("{\"track\":\(requestTrackJSON("t1", instrument: "bass", inMix: inMix)),\"song\":\(requestSongJSON(updated: "2026-11-27T10:09:00.000Z"))}".utf8))
            }
            return base(request)
        }
        let session = makePublicSession()
        keep = session
        await session.jamPublic.refresh()
        let model = JamSongModel(
            song: try Coding.decoder.decode(JamSongSummary.self, from: Data(requestSongJSON().utf8)),
            channel: requestChannel, server: requestServer, audioSession: JamAudioSession(driver: FakeAudioDriver())
        )
        await model.start(session: session)
        await model.accept(try XCTUnwrap(model.requestTracks.first))
        let accepted = try XCTUnwrap(model.answer)
        inboxStatus.value = 500
        await model.undoAccept(accepted)
        XCTAssertEqual(model.requestTracks.map(\.id).sorted(), ["t1", "t2"], "the part is waiting again with no read to say so")
        model.stop()
    }
}

@MainActor
final class JamSearchEditTests: XCTestCase {
    private var keep: SessionStore?

    func testAnEditedResultAsksTheServerAgain() async throws {
        let asked = LockedBox<Int>(0)
        let found = LockedBox(true)
        let song = #"{"id":"s0","channelId":"chan-1","serverId":"srv-1","title":"Lua","artist":null,"joinMode":"open","wantedInstruments":[],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,"createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z","trackCount":1,"instruments":["guitar"],"contributorCount":1,"mixDurationMs":1000}"#
        JamStubURLProtocol.handler = { _ in
            asked.value += 1
            return (0, 200, Data("{\"songs\":[\(found.value ? song : "")],\"nextCursor\":null}".utf8))
        }
        let session = makePublicSession()
        keep = session
        let channel = try Coding.decoder.decode(Channel.self, from: Data(
            #"{"id":"chan-1","serverId":"srv-1","kind":"server","name":"jam","type":"jam","position":0,"isPrivate":false}"#.utf8
        ))
        let model = JamWallModel(channel: channel, server: Server(id: "srv-1", name: "S", ownerId: "u1", role: "owner", createdAt: Date()))
        model.attach(session: session)
        model.searchText = "lu"
        await model.runSearch()
        guard case .results(_, let first) = model.search, let edited = first.first else { return XCTFail("results") }
        XCTAssertEqual(asked.value, 1)
        found.value = false
        model.apply(.jam(.songUpdated(channelId: "chan-1", song: edited)))
        let deadline = Date().addingTimeInterval(3)
        while asked.value < 2, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(asked.value, 2, "the words were asked again")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.search, .results(words: "lu", songs: []), "a song that no longer matches is gone")
    }
}
