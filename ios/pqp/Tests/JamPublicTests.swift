import XCTest
@testable import pqp

// TAKE NOTICES ON THE PHONE (docs/JAM_PUBLIC.md, "Telling the starter"): the two
// live frames and the durable list as the server writes them, the push path that
// opens a song, the rules that decide which card is drawn and what it says, the
// store that holds the starter's inbox, and the starter's answer on an open song,
// driven for real against a stubbed network.

let songId = "11111111-1111-4111-8111-111111111111"
private let otherSongId = "99999999-9999-4999-8999-999999999999"

// MARK: - The wire

final class JamPublicWireTests: XCTestCase {
    private func frame(_ json: String) -> JamPublicFrame? { JamPublicFrame.parse(Data(json.utf8)) }

    func testTheStartersNudgeCarriesTheInstrumentAndWhetherAutoAcceptPutItIn() {
        let parsed = frame("""
        {"type":"jam-public-notice","kind":"take","songId":"\(songId)","title":"Lua cheia","trackId":null,
         "reason":null,"admitted":false,"instrument":"bass"}
        """)
        XCTAssertEqual(parsed, .notice(JamPublicNoticeFrame(
            kind: .take, songId: songId, title: "Lua cheia", admitted: false, instrument: .bass
        )))
    }

    func testAnOlderServersTakeFrameHasNoInstrumentAndAnAdmittedOneSaysSo() {
        guard case .notice(let old)? = frame(#"{"type":"jam-public-notice","kind":"take","songId":"\#(songId)","title":"x"}"#) else {
            return XCTFail("the frame still parses")
        }
        XCTAssertNil(old.instrument, "additive: null from a server that predates it")
        XCTAssertFalse(old.admitted)
        guard case .notice(let admitted)? = frame(#"{"type":"jam-public-notice","kind":"take","songId":"\#(songId)","title":"x","admitted":true}"#) else {
            return XCTFail("admitted parses")
        }
        XCTAssertTrue(admitted.admitted)
    }

    /// The schema reads an unknown kind as `consent` (`.catch`): this build must
    /// never read one as a take, which is a question it would put to a starter.
    func testAKindFromANewerServerIsNeverATake() {
        guard case .notice(let notice)? = frame(#"{"type":"jam-public-notice","kind":"brand-new","songId":"\#(songId)","title":"x"}"#) else {
            return XCTFail("parses")
        }
        XCTAssertEqual(notice.kind, .consent)
    }

    func testTheSendersDecisionIsItsOwnFrame() {
        XCTAssertEqual(
            frame(#"{"type":"jam-take-decision","decision":"accepted","songId":"\#(songId)","title":"Lua cheia","instrument":"drums"}"#),
            .decision(JamTakeDecisionFrame(decision: .accepted, songId: songId, title: "Lua cheia", instrument: .drums))
        )
        XCTAssertEqual(
            frame(#"{"type":"jam-take-decision","decision":"refused","songId":"\#(songId)","title":"x","instrument":"theremin"}"#),
            .decision(JamTakeDecisionFrame(decision: .refused, songId: songId, title: "x", instrument: .other)),
            "an instrument a newer server invented reads as other"
        )
    }

    func testAFrameThisBuildCannotReadIsDroppedNotGuessed() {
        XCTAssertNil(frame(#"{"type":"jam-take-decision","decision":"maybe","songId":"\#(songId)","title":"x","instrument":"bass"}"#))
        XCTAssertNil(frame(#"{"type":"jam-take-decision","decision":"accepted","title":"x","instrument":"bass"}"#), "no song")
        XCTAssertNil(frame(#"{"type":"jam-take-decision","decision":"accepted","songId":"","title":"x","instrument":"bass"}"#))
        XCTAssertNil(frame(#"{"type":"jam-something-new","songId":"\#(songId)"}"#))
    }

    func testTheTwoTypesAreTheOnesTheServerSends() {
        XCTAssertEqual(JamPublicFrame.types, ["jam-public-notice", "jam-take-decision"])
    }

    func testTheSocketRoutesBothFramesToTheStoreNotToAChannel() async throws {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(#"{"type":"jam-public-notice","kind":"take","songId":"\#(songId)","title":"Lua","instrument":"bass"}"#.utf8))
        await client.ingest(Data(#"{"type":"jam-take-decision","decision":"refused","songId":"\#(songId)","title":"Lua","instrument":"bass"}"#.utf8))
        await client.ingest(Data(#"{"type":"jam-take-decision","decision":"nope","songId":"\#(songId)","title":"Lua","instrument":"bass"}"#.utf8))
        var iterator = stream.makeAsyncIterator()
        guard case .jamPublic(.notice(let notice))? = await iterator.next() else { return XCTFail("the starter's nudge") }
        XCTAssertEqual(notice.kind, .take)
        guard case .jamPublic(.decision(let decision))? = await iterator.next() else { return XCTFail("the sender's decision") }
        XCTAssertEqual(decision.decision, .refused)
        // The third was dropped: the stream has nothing more.
        await client.ingest(Data(#"{"type":"jam-take-decision","decision":"accepted","songId":"\#(songId)","title":"Z","instrument":"keys"}"#.utf8))
        guard case .jamPublic(.decision(let next))? = await iterator.next() else { return XCTFail("the next one") }
        XCTAssertEqual(next.title, "Z", "the unreadable frame left nothing behind")
    }

    func testTheDurableListDecodesLeniently() throws {
        let json = """
        {"notices":[
          {"id":"a","kind":"take","songId":"\(songId)","title":"Lua cheia","instruments":["bass","drums"],"count":2,
           "createdAt":"2026-11-27T10:00:00.123Z","updatedAt":"2026-11-27T10:05:00.000Z"},
          {"id":"b","kind":"something-new","songId":"\(songId)","title":"x","instruments":["theremin"],"count":0,
           "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z"},
          {"kind":"take"},
          {"id":"c","kind":"accepted","songId":"\(songId)","title":"Y","instruments":["keys"],"count":1,
           "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z"}
        ]}
        """
        let answer = try Coding.decoder.decode(JamTakeNoticesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(answer.notices.map(\.id), ["a", "b", "c"], "a row this build cannot read costs the row, not the list")
        XCTAssertEqual(answer.notices[0].kind, .take)
        XCTAssertEqual(answer.notices[0].instruments, [.bass, .drums])
        XCTAssertEqual(answer.notices[0].count, 2)
        XCTAssertEqual(answer.notices[1].kind, .take, "an unknown kind reads as take, the schema's `.catch`")
        XCTAssertEqual(answer.notices[1].instruments, [.other])
        XCTAssertEqual(answer.notices[1].count, 1, "a count is at least one")
        XCTAssertEqual(answer.notices[2].kind, .accepted)
    }

    func testTheInboxCarriesTheTrackTheStarterAuditions() throws {
        let json = """
        {"takes":[{"songId":"\(songId)","songTitle":"Lua cheia","track":\(JamContractTests.trackJSON(id: "t-1"))},{"nope":1}]}
        """
        let answer = try Coding.decoder.decode(JamPublicInboxResponse.self, from: Data(json.utf8))
        XCTAssertEqual(answer.takes.map(\.id), ["t-1"])
        XCTAssertEqual(answer.takes[0].songTitle, "Lua cheia")
        XCTAssertEqual(answer.takes[0].track.audioUrl, "https://example.test/a.m4a")
    }

    func testTheConfigIsOffUnlessItSaysOn() throws {
        XCTAssertFalse(try Coding.decoder.decode(JamPublicConfig.self, from: Data("{}".utf8)).enabled)
        XCTAssertTrue(try Coding.decoder.decode(JamPublicConfig.self, from: Data(#"{"enabled":true,"publishing":"open","uploads":true}"#.utf8)).enabled)
    }
}

// MARK: - The push path

final class JamPublicRoutingTests: XCTestCase {
    /// The exact string `sendJamTakePush` puts on the notification (`/app/jam/<songId>`).
    func testTheTakeNoticePushPathOpensTheSong() {
        XCTAssertEqual(DeepLink.target(path: "/app/jam/\(songId)"), .publicJam(songId: songId))
        XCTAssertEqual(DeepLink.target(path: "/jam/\(songId)/"), .publicJam(songId: songId))
        XCTAssertEqual(
            DeepLink.target(path: "/app/jam/\(songId.uppercased())"), .publicJam(songId: songId),
            "the web lowercases the id too"
        )
    }

    func testTheCustomSchemeAndTheUniversalLinkReadItToo() {
        XCTAssertEqual(DeepLink.target(url: URL(string: "pqp://jam/\(songId)")!), .publicJam(songId: songId))
        XCTAssertEqual(
            DeepLink.target(url: URL(string: "https://pqp.gg/app/jam/\(songId)?ref=share")!), .publicJam(songId: songId),
            "a share link's tag is not part of the path"
        )
    }

    /// `/app/jam/new` and `/app/jam/mine` are the web's own screens; anything that
    /// is not an id is not a song.
    func testOnlyARealIdIsASong() {
        XCTAssertNil(DeepLink.target(path: "/app/jam/new"))
        XCTAssertNil(DeepLink.target(path: "/app/jam/mine"))
        XCTAssertNil(DeepLink.target(path: "/app/jam/not-a-uuid"))
        XCTAssertNil(DeepLink.target(path: "/app/jam"))
        XCTAssertNil(DeepLink.target(path: "/app/jam/\(songId)/extra"))
    }

    func testTheOtherSongLinksAreUntouched() {
        XCTAssertEqual(
            DeepLink.target(path: "/app/server/s/channel/c/song/\(songId)"),
            .jamSong(serverId: "s", channelId: "c", songId: songId)
        )
        XCTAssertEqual(DeepLink.target(path: "/app/server/s/channel/c"), .channel(serverId: "s", channelId: "c"))
    }

    func testASongIsNotAChatABannerCouldSitOver() {
        XCTAssertTrue(PushPresentation.shouldInterrupt(path: "/app/jam/\(songId)", visibleChannelId: "c"))
    }

    func testAPublicJamTheDeviceCannotOpenSaysItOpensOnTheWeb() {
        XCTAssertTrue(JamSongLinkMessage.publicOnWeb.contains("pqp.gg"))
        XCTAssertNotEqual(JamSongLinkMessage.publicOnWeb, JamSongLinkMessage.unavailable)
        XCTAssertTrue(JamSongLinkMessage.isUnreadable(APIError.decoding("channelId")))
        XCTAssertFalse(JamSongLinkMessage.isUnreadable(APIError.transport("offline")))
    }
}

// MARK: - The rules

final class JamPublicRulesTests: XCTestCase {
    private func item(_ track: String, song: String = songId, instrument: JamInstrument = .bass) -> JamPublicInboxItem {
        JamPublicInboxItem(
            songId: song, songTitle: "T",
            track: JamTrack(id: track, songId: song, authorId: "a", authorName: "Bia", instrument: instrument, inMix: false)
        )
    }

    func testWhatWaitsOnASongIsCountedPerSong() {
        let inbox = [item("1"), item("2"), item("3", song: otherSongId)]
        XCTAssertEqual(JamWaiting.count(in: inbox, songId: songId), 2)
        XCTAssertEqual(JamWaiting.tracks(in: inbox, songId: songId).map(\.id), ["1", "2"])
        XCTAssertEqual(JamWaiting.counts(in: inbox), [songId: 2, otherSongId: 1])
        XCTAssertEqual(JamWaiting.count(in: [], songId: songId), 0)
    }

    func testTheWallsRowOpensTheSongOnlyWhenEveryWaitingPartIsOnOne() {
        XCTAssertEqual(JamWaiting.soleSong(in: [item("1"), item("2")]), songId)
        XCTAssertNil(JamWaiting.soleSong(in: [item("1"), item("3", song: otherSongId)]))
        XCTAssertNil(JamWaiting.soleSong(in: []))
    }

    func testAWallCountsOnlyWhatItCanOpen() {
        let inbox = [item("1"), item("3", song: otherSongId)]
        XCTAssertEqual(JamWaiting.onWall(inbox, songIds: [songId]).map(\.id), ["1"])
    }

    func testOneCardAtATimeNewestFirstWithTheRestCounted() {
        let a = JamTakeNotice(id: "a", kind: .take, songId: songId, title: "A")
        let b = JamTakeNotice(id: "b", kind: .accepted, songId: songId, title: "B")
        let c = JamTakeNotice(id: "c", kind: .refused, songId: songId, title: "C")
        XCTAssertEqual(JamNoticeQueue.of([a, b, c]), JamNoticeQueue(card: a, more: 2))
        XCTAssertEqual(JamNoticeQueue.of([a]), JamNoticeQueue(card: a, more: 0))
        XCTAssertEqual(JamNoticeQueue.of([]), JamNoticeQueue(card: nil, more: 0))
    }

    func testTheCardSaysTheSongAndTheInstrumentNeverWhoSentIt() {
        let one = JamNoticeText.spoken(JamTakeNotice(id: "a", kind: .take, songId: songId, title: "Lua cheia", instruments: [.bass]))
        XCTAssertEqual(one, "A bass part arrived in \"Lua cheia\".")
        let burst = JamNoticeText.spoken(JamTakeNotice(id: "a", kind: .take, songId: songId, title: "Lua", instruments: [.bass, .drums], count: 3))
        XCTAssertEqual(burst, "3 parts are waiting for your answer in \"Lua\" (bass and drums).")
        XCTAssertEqual(
            JamNoticeText.spoken(JamTakeNotice(id: "a", kind: .accepted, songId: songId, title: "Lua", instruments: [.drums])),
            "Your drums part is in \"Lua\"."
        )
        XCTAssertEqual(
            JamNoticeText.spoken(JamTakeNotice(id: "a", kind: .refused, songId: songId, title: "Lua", instruments: [.drums])),
            "Your drums part in \"Lua\" did not make it in."
        )
        XCTAssertEqual(
            JamNoticeText.spoken(JamTakeNotice(id: "a", kind: .refused, songId: songId, title: "Lua", instruments: [.drums, .keys], count: 2)),
            "2 of your parts in \"Lua\" did not make it in."
        )
    }

    /// A title is a stranger's text inside the app's sentence: isolated for
    /// drawing, never a control for VoiceOver.
    func testATitleWithABidiOverrideCannotReorderTheSentence() {
        let hostile = JamTakeNotice(id: "a", kind: .take, songId: songId, title: "\u{202E}abc", instruments: [.bass])
        XCTAssertFalse(JamNoticeText.spoken(hostile).unicodeScalars.contains { (0x202A...0x202E).contains($0.value) })
        XCTAssertTrue(JamNoticeText.card(hostile).contains("\u{2068}abc\u{2069}"), "isolated when drawn")
    }

    func testAnAnswerIsSaidWithTheInstrumentAndThePersonAndUndoLastsEightSeconds() {
        let accepted = JamAnswer(kind: .accepted, trackId: "t", instrument: .bass, name: "Bia")
        XCTAssertTrue(accepted.text().contains("bass"))
        XCTAssertTrue(accepted.text().contains("Bia"))
        XCTAssertEqual(accepted.visibleFor, 8)
        let undone = JamAnswer(kind: .undone, trackId: "t", instrument: .bass, name: "Bia")
        XCTAssertEqual(undone.visibleFor, 5)
        XCTAssertTrue(undone.text().contains("still waiting"))
        let refused = JamAnswer(kind: .refused, trackId: "t", instrument: .bass, name: nil)
        XCTAssertTrue(refused.text().contains("is told"), "the refusal says the sender is told")
        XCTAssertFalse(refused.text().isEmpty)
    }
}

// MARK: - A stubbed network

private struct PublicTestToken: TokenProviding {
    func currentToken() async -> String? { "stub" }
    func refreshedToken() async -> TokenRefresh { .token("stub") }
}

struct Sent: @unchecked Sendable {
    let method: String
    let path: String
    let json: [String: Any]?
}

func sentBody(_ request: URLRequest) -> [String: Any]? {
    var data = request.httpBody
    if data == nil, let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            collected.append(buffer, count: n)
        }
        data = collected
    }
    return data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
}

@MainActor
func makePublicSession() -> SessionStore {
    let api = APIClient(tokenProvider: PublicTestToken(), protocolClasses: [JamStubURLProtocol.self])
    return SessionStore(authMode: .devBypass, tokenProvider: PublicTestToken(), api: api)
}

func inboxJSON(_ tracks: [(id: String, instrument: String)], song: String = "s1") -> String {
    let rows = tracks.map { entry in
        """
        {"songId":"\(song)","songTitle":"Lua cheia","track":{"id":"\(entry.id)","songId":"\(song)","authorId":"u2",
         "authorName":"Bia","authorAvatarUrl":null,"instrument":"\(entry.instrument)","label":null,
         "audioUrl":"https://example.invalid/\(entry.id).m4a","audioContentType":"audio/mp4","audioBytes":10,
         "videoUrl":null,"videoContentType":null,"mediaExpiresAt":"2026-11-30T10:00:00.000Z",
         "offsetMs":0,"trimStartMs":0,"trimEndMs":0,"durationMs":8000,"gain":1,"peaks":[0.5],"inMix":false,
         "voteCount":0,"createdAt":"2026-11-27T10:00:00.000Z"}}
        """
    }
    return "{\"takes\":[\(rows.joined(separator: ","))]}"
}

func noticesJSON(_ items: [(id: String, kind: String, song: String)]) -> String {
    let rows = items.map {
        """
        {"id":"\($0.id)","kind":"\($0.kind)","songId":"\($0.song)","title":"Lua cheia","instruments":["bass"],"count":1,
         "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"2026-11-27T10:00:00.000Z"}
        """
    }
    return "{\"notices\":[\(rows.joined(separator: ","))]}"
}

/// A server: config, inbox and notices are the test's, everything else answers `{}`.
func publicRoute(
    log: LockedBox<[Sent]>,
    enabled: LockedBox<Bool> = LockedBox(true),
    inbox: LockedBox<String> = LockedBox(inboxJSON([])),
    notices: LockedBox<String> = LockedBox(noticesJSON([])),
    inboxStatus: LockedBox<Int> = LockedBox(200)
) -> @Sendable (URLRequest) -> (TimeInterval, Int, Data) {
    { request in
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        log.value.append(Sent(method: method, path: path, json: sentBody(request)))
        switch (method, path) {
        case ("GET", "/api/jam-public/config"):
            return (0, 200, Data("{\"enabled\":\(enabled.value),\"publishing\":\"open\",\"uploads\":true}".utf8))
        case ("GET", "/api/jam-public/inbox"):
            return (0, inboxStatus.value, Data(inbox.value.utf8))
        case ("GET", "/api/jam-public/notices"):
            return (0, 200, Data(notices.value.utf8))
        case ("POST", "/api/jam-public/notices/ack"):
            return (0, 200, Data("{\"ok\":true}".utf8))
        default:
            return (0, 200, Data("{}".utf8))
        }
    }
}

// MARK: - The store

@MainActor
final class JamPublicStoreTests: XCTestCase {
    private var keep: SessionStore?

    private func store(_ handler: @escaping @Sendable (URLRequest) -> (TimeInterval, Int, Data)) -> JamPublicStore {
        JamStubURLProtocol.handler = handler
        let session = makePublicSession()
        keep = session
        return session.jamPublic
    }

    func testOffAsksNothingElseAndHoldsNothing() async {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(log: log, enabled: LockedBox(false)))
        await store.refresh()
        XCTAssertTrue(store.loaded)
        XCTAssertFalse(store.enabled)
        XCTAssertTrue(store.inbox.isEmpty)
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertEqual(log.value.map(\.path), ["/api/jam-public/config"], "invisible without the flag: nothing else is asked")
    }

    func testOnReadsTheInboxAndTheNoticesTogether() async {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(
            log: log,
            inbox: LockedBox(inboxJSON([("t1", "bass")])),
            notices: LockedBox(noticesJSON([("n1", "take", "s1")]))
        ))
        await store.refresh()
        XCTAssertTrue(store.enabled)
        XCTAssertEqual(store.inbox.map(\.id), ["t1"])
        XCTAssertEqual(store.cards.map(\.id), ["n1"])
    }

    /// `jam_take_notices` is the server's to state: off, `/notices` is an empty
    /// list. The inbox, which is the state, still marks the wall and the song.
    func testTheNoticesFlagOffLeavesNoCardsButTheInboxStillMarks() async {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(log: log, inbox: LockedBox(inboxJSON([("t1", "bass")]))))
        await store.refresh()
        XCTAssertTrue(store.cards.isEmpty)
        XCTAssertEqual(JamWaiting.count(in: store.inbox, songId: "s1"), 1)
    }

    func testAFailedReadKeepsWhatWasHeld() async {
        let log = LockedBox<[Sent]>([])
        let inbox = LockedBox(inboxJSON([("t1", "bass")]))
        let status = LockedBox(200)
        let store = store(publicRoute(log: log, inbox: inbox, inboxStatus: status))
        await store.refresh()
        XCTAssertEqual(store.inbox.count, 1)
        status.value = 500
        await store.refresh()
        XCTAssertEqual(store.inbox.count, 1, "a lost connection never empties the list")
    }

    func testAnAnswerTheNextAccountOutlivedIsDropped() async throws {
        let log = LockedBox<[Sent]>([])
        let slow = LockedBox(true)
        let handler = publicRoute(log: log, inbox: LockedBox(inboxJSON([("t1", "bass")])))
        let store = store { request in
            if request.url?.path == "/api/jam-public/inbox", slow.value { return (0.3, 200, Data(inboxJSON([("t1", "bass")]).utf8)) }
            return handler(request)
        }
        let read = Task { await store.refresh() }
        try await Task.sleep(for: .milliseconds(100))
        store.clear()
        await read.value
        XCTAssertTrue(store.inbox.isEmpty, "the last account's inbox does not land in the next one's store")
        XCTAssertFalse(store.loaded)
    }

    func testATapOrAnXSpendsTheItemAtOnceAndTellsTheServer() async throws {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(
            log: log,
            inbox: LockedBox(inboxJSON([("t1", "bass")])),
            notices: LockedBox(noticesJSON([("n1", "take", "s1"), ("n2", "accepted", "s2")]))
        ))
        await store.refresh()
        store.ack("n1")
        XCTAssertEqual(store.cards.map(\.id), ["n2"], "it leaves at once")
        try await Task.sleep(for: .milliseconds(150))
        let acks = log.value.filter { $0.path == "/api/jam-public/notices/ack" }
        XCTAssertEqual(acks.count, 1)
        XCTAssertEqual(acks.first?.json?["id"] as? String, "n1")
    }

    func testTheLastTakeAnsweredTakesTheStartersCardWithIt() async {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(
            log: log,
            inbox: LockedBox(inboxJSON([("t1", "bass"), ("t2", "drums")])),
            notices: LockedBox(noticesJSON([("n1", "take", "s1"), ("n2", "accepted", "s1")]))
        ))
        await store.refresh()
        store.dropInboxTake(trackId: "t1")
        XCTAssertEqual(store.cards.map(\.id), ["n1", "n2"], "one part still waits on the song")
        store.dropInboxTake(trackId: "t2")
        XCTAssertEqual(store.cards.map(\.id), ["n2"], "answering the last empties the starter's item; the sender's own stays")
        XCTAssertTrue(store.inbox.isEmpty)
    }

    /// A starter the server wrote no item for (the notices switch is off) is
    /// still told, once, by a local card that is never sent back.
    func testALiveTakeWithNoItemBecomesALocalCardThatIsNeverAcked() async throws {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(log: log, inbox: LockedBox(inboxJSON([("t1", "bass")]))))
        store.apply(.notice(JamPublicNoticeFrame(kind: .take, songId: "s1", title: "Lua cheia", admitted: false, instrument: .bass)))
        try await waitUntil { store.liveTake != nil }
        XCTAssertEqual(store.cards.first?.songId, "s1")
        XCTAssertEqual(store.cards.first?.instruments, [.bass])
        store.ack(store.cards[0].id)
        XCTAssertNil(store.liveTake)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(log.value.filter { $0.path.hasSuffix("/ack") }.isEmpty, "nothing on the server to spend")
    }

    func testALiveTakeTheServerAlreadyCardedIsNotToldTwice() async throws {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(
            log: log,
            inbox: LockedBox(inboxJSON([("t1", "bass")])),
            notices: LockedBox(noticesJSON([("n1", "take", "s1")]))
        ))
        store.apply(.notice(JamPublicNoticeFrame(kind: .take, songId: "s1", title: "Lua cheia", admitted: false, instrument: .bass)))
        try await waitUntil { store.loaded && !store.cards.isEmpty }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(store.liveTake)
        XCTAssertEqual(store.cards.map(\.id), ["n1"])
    }

    func testATakeAutoAcceptAlreadyPutInTellsNobody() async throws {
        let log = LockedBox<[Sent]>([])
        let store = store(publicRoute(log: log))
        store.apply(.notice(JamPublicNoticeFrame(kind: .take, songId: "s1", title: "x", admitted: true, instrument: .bass)))
        try await waitUntil { store.loaded }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(store.liveTake)
    }

    func testTheSendersDecisionReadsAgainAndTheCardIsTheServers() async throws {
        let log = LockedBox<[Sent]>([])
        let notices = LockedBox(noticesJSON([]))
        let store = store(publicRoute(log: log, notices: notices))
        await store.refresh()
        XCTAssertTrue(store.cards.isEmpty)
        notices.value = noticesJSON([("n9", "accepted", "s1")])
        store.apply(.decision(JamTakeDecisionFrame(decision: .accepted, songId: "s1", title: "Lua cheia", instrument: .bass)))
        try await waitUntil { !store.cards.isEmpty }
        XCTAssertEqual(store.cards.map(\.kind), [.accepted])
    }

    func testASocketThatCameBackReadsAgain() async throws {
        let log = LockedBox<[Sent]>([])
        let inbox = LockedBox(inboxJSON([]))
        let store = store(publicRoute(log: log, inbox: inbox))
        await store.refresh()
        inbox.value = inboxJSON([("t1", "bass")])
        store.reconnected()
        try await waitUntil { store.inbox.count == 1 }
    }

    /// A read asked for while one is out is not lost: the answer that is out was
    /// produced before whatever asked.
    func testARefreshAskedForDuringARefreshReadsOnceMore() async throws {
        let log = LockedBox<[Sent]>([])
        let inbox = LockedBox(inboxJSON([]))
        let handler = publicRoute(log: log, inbox: inbox)
        let store = store { request in
            if request.url?.path == "/api/jam-public/inbox" { return (0.2, 200, Data(inbox.value.utf8)) }
            return handler(request)
        }
        let first = Task { await store.refresh() }
        try await Task.sleep(for: .milliseconds(80))
        inbox.value = inboxJSON([("t1", "bass")])
        await store.refresh()
        await first.value
        XCTAssertEqual(store.inbox.map(\.id), ["t1"])
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: Double = 3) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out waiting") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

// MARK: - The starter's answer on an open song

func requestSongJSON(updated: String = "2026-11-27T10:05:00.000Z") -> String {
    """
    {"id":"s1","channelId":"chan-1","serverId":"srv-1","title":"Lua cheia","artist":null,
     "joinMode":"wanted","wantedInstruments":["bass","drums"],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
     "createdAt":"2026-11-27T10:00:00.000Z","updatedAt":"\(updated)","trackCount":2,"instruments":["guitar"],
     "contributorCount":2,"mixDurationMs":8000}
    """
}

func requestTrackJSON(_ id: String, instrument: String, inMix: Bool, author: String = "u2") -> String {
    """
    {"id":"\(id)","songId":"s1","authorId":"\(author)","authorName":"Bia","authorAvatarUrl":null,
     "instrument":"\(instrument)","label":null,"audioUrl":"https://example.invalid/\(id).m4a","audioContentType":"audio/mp4",
     "audioBytes":10,"videoUrl":null,"videoContentType":null,"mediaExpiresAt":"2026-11-30T10:00:00.000Z",
     "offsetMs":0,"trimStartMs":0,"trimEndMs":0,"durationMs":8000,"gain":1,"peaks":[0.5],"inMix":\(inMix),
     "voteCount":0,"createdAt":"2026-11-27T10:0\(id.hasSuffix("2") ? 2 : 1):00.000Z"}
    """
}

let requestDetail = """
{"song":\(requestSongJSON()),"tracks":[\(requestTrackJSON("t0", instrument: "guitar", inMix: true, author: "u1")),\(requestTrackJSON("t1", instrument: "bass", inMix: false)),\(requestTrackJSON("t2", instrument: "drums", inMix: false))],
 "viewer":{"isAuthor":true,"canModerate":false,"addableInstruments":["guitar"],"votedTrackIds":[]}}
"""

let requestChannel: Channel = try! Coding.decoder.decode(Channel.self, from: Data("""
{"id":"chan-1","serverId":"srv-1","kind":"server","name":"jam","type":"jam","position":0,"isPrivate":false}
""".utf8))
let requestServer = Server(id: "srv-1", name: "S", ownerId: "u1", role: "owner", createdAt: Date())

@MainActor
final class JamRequestAnswerTests: XCTestCase {
    private var keep: SessionStore?

    private func open(
        log: LockedBox<[Sent]>,
        inbox: [(id: String, instrument: String)] = [("t1", "bass"), ("t2", "drums")],
        writes: @escaping @Sendable (URLRequest) -> (Int, String) = { _ in (200, "{}") }
    ) async throws -> JamSongModel {
        let base = publicRoute(log: log, inbox: LockedBox(inboxJSON(inbox)), notices: LockedBox(noticesJSON([("n1", "take", "s1")])))
        JamStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            if method == "GET", path.hasSuffix("/api/jam/config") { return (0, 200, Data(#"{"enabled":true,"uploads":true}"#.utf8)) }
            if method == "GET", path == "/api/jam-songs/s1" {
                log.value.append(Sent(method: method, path: path, json: nil))
                return (0, 200, Data(requestDetail.utf8))
            }
            if method == "PATCH" || method == "DELETE", path.hasPrefix("/api/jam-tracks/") {
                log.value.append(Sent(method: method, path: path, json: sentBody(request)))
                let (status, body) = writes(request)
                return (0, status, Data(body.utf8))
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
        return model
    }

    private func updatedAnswer(track: String, instrument: String, inMix: Bool) -> String {
        "{\"track\":\(requestTrackJSON(track, instrument: instrument, inMix: inMix)),\"song\":\(requestSongJSON(updated: "2026-11-27T10:09:00.000Z"))}"
    }

    func testAWaitingPartIsAQuestionNotATakeToVoteOn() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log)
        XCTAssertEqual(model.requestTracks.map(\.id), ["t1", "t2"], "bass then drums, the band's order")
        XCTAssertTrue(model.otherTakes.isEmpty, "they are not 'Other takes'")
        XCTAssertEqual(model.settledTracks.map(\.id), ["t0"], "and not a chip until they are accepted")
        model.stop()
    }

    func testAnotherSongsWaitingPartsAreNotThisOnes() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log, inbox: [])
        XCTAssertTrue(model.requestTracks.isEmpty)
        XCTAssertEqual(model.otherTakes.map(\.id).sorted(), ["t1", "t2"], "with no inbox they are alternates as before")
        model.stop()
    }

    func testAcceptPutsItInTheMixAndOffersUndo() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log) { _ in (200, "{\"track\":\(requestTrackJSON("t1", instrument: "bass", inMix: true)),\"song\":\(requestSongJSON(updated: "2026-11-27T10:09:00.000Z"))}") }
        let request = try XCTUnwrap(model.requestTracks.first)
        await model.accept(request)
        let patch = try XCTUnwrap(log.value.last { $0.method == "PATCH" })
        XCTAssertEqual(patch.path, "/api/jam-tracks/t1")
        XCTAssertEqual(patch.json?["inMix"] as? Bool, true)
        XCTAssertEqual(model.answer?.kind, .accepted)
        XCTAssertEqual(model.answer?.instrument, .bass)
        XCTAssertEqual(model.requestTracks.map(\.id), ["t2"], "it left the waiting list at once")
        XCTAssertTrue(model.tracks.first { $0.id == "t1" }?.inMix == true)
        XCTAssertEqual(keep?.jamPublic.inbox.map(\.id), ["t2"])
        XCTAssertNil(model.requestError)
        model.stop()
    }

    func testUndoTakesTheSameTakeOutOfTheMixAgain() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log) { request in
            let inMix = (sentBody(request)?["inMix"] as? Bool) ?? false
            return (200, "{\"track\":\(requestTrackJSON("t1", instrument: "bass", inMix: inMix)),\"song\":\(requestSongJSON(updated: "2026-11-27T10:09:00.000Z"))}")
        }
        await model.accept(try XCTUnwrap(model.requestTracks.first))
        let accepted = try XCTUnwrap(model.answer)
        await model.undoAccept(accepted)
        let patches = log.value.filter { $0.method == "PATCH" }
        XCTAssertEqual(patches.map { $0.json?["inMix"] as? Bool }, [true, false])
        XCTAssertEqual(model.answer?.kind, .undone)
        XCTAssertTrue(model.tracks.first { $0.id == "t1" }?.inMix == false)
        model.stop()
    }

    func testOnlyAnAcceptedAnswerCanBeUndone() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log)
        await model.undoAccept(JamAnswer(kind: .refused, trackId: "t1", instrument: .bass, name: "Bia"))
        XCTAssertTrue(log.value.filter { $0.method == "PATCH" }.isEmpty, "a declined take is deleted; there is nothing to bring back")
        model.stop()
    }

    func testDeclineDeletesTheTakeAndHasNoUndo() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log)
        await model.decline(try XCTUnwrap(model.requestTracks.first))
        let delete = try XCTUnwrap(log.value.last { $0.method == "DELETE" })
        XCTAssertEqual(delete.path, "/api/jam-tracks/t1")
        XCTAssertEqual(model.answer?.kind, .refused)
        XCTAssertFalse(model.tracks.contains { $0.id == "t1" })
        XCTAssertEqual(keep?.jamPublic.inbox.map(\.id), ["t2"])
        model.stop()
    }

    /// An error is next to the action that caused it, and the part stays asked.
    func testARefusedAcceptSaysWhyAndLeavesThePartWaiting() async throws {
        let log = LockedBox<[Sent]>([])
        let model = try await open(log: log) { _ in (403, #"{"error":"Only the starter can do that."}"#) }
        await model.accept(try XCTUnwrap(model.requestTracks.first))
        XCTAssertEqual(model.requestError, "Only the starter can do that.")
        XCTAssertNil(model.answer)
        XCTAssertEqual(model.requestTracks.count, 2, "nothing was put in")
        XCTAssertNil(model.requestBusy, "and the buttons are back")
        model.stop()
    }

    func testANewAnswerClearsTheLastErrorAndTwoAnswersNeverOverlap() async throws {
        let log = LockedBox<[Sent]>([])
        let fail = LockedBox(true)
        let model = try await open(log: log) { _ in
            fail.value
                ? (500, #"{"error":"boom"}"#)
                : (200, "{\"track\":\(requestTrackJSON("t1", instrument: "bass", inMix: true)),\"song\":\(requestSongJSON(updated: "2026-11-27T10:09:00.000Z"))}")
        }
        let request = try XCTUnwrap(model.requestTracks.first)
        await model.accept(request)
        XCTAssertNotNil(model.requestError)
        fail.value = false
        await model.accept(request)
        XCTAssertNil(model.requestError)
        XCTAssertEqual(model.answer?.kind, .accepted)
        model.stop()
    }
}
