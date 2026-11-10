import AVFoundation
import XCTest
@testable import pqp

// What the Farol review of #1572 and the coordinator's last round asked to be
// proven: who owns the audio session, what a stopped screen may still do, what
// a late page may still change, how a track is named, the song link, the lazy
// bands, and a song whose only video is WebM. The two models are driven for
// real, against a stubbed network.

// MARK: - A stubbed network

private struct JamTestToken: TokenProviding {
    func currentToken() async -> String? { "stub" }
    func refreshedToken() async -> TokenRefresh { .token("stub") }
}

/// Answers by request. `handler` returns the delay, status and body for it.
final class JamStubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: @Sendable (URLRequest) -> (TimeInterval, Int, Data) = { _ in (0, 200, Data("{}".utf8)) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (delay, status, body) = Self.handler(request)
        let work = { [self] in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
        if delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: work)
        } else {
            work()
        }
    }

    override func stopLoading() {}
}

private func songJSON(_ id: String, updated: Int = 100, tracks: Int = 1) -> String {
    let date = { (s: Int) in "2026-11-09T22:\(String(format: "%02d", s / 60)):\(String(format: "%02d", s % 60)).000Z" }
    return """
    {"id":"\(id)","channelId":"chan-1","serverId":"srv-1","title":"Song \(id)","artist":null,
     "joinMode":"open","wantedInstruments":[],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
     "createdAt":"\(date(1))","updatedAt":"\(date(updated))","trackCount":\(tracks),"instruments":["guitar"],
     "contributorCount":1,"mixDurationMs":1000}
    """
}

private func listJSON(_ ids: [String], next: String?, updated: Int = 100) -> Data {
    let songs = ids.enumerated().map { songJSON($1, updated: updated - $0) }.joined(separator: ",")
    return Data("{\"songs\":[\(songs)],\"nextCursor\":\(next.map { "\"\($0)\"" } ?? "null")}".utf8)
}

private func trackJSON(_ id: String, song: String = "s1", url: String = "https://example.invalid/a.m4a") -> String {
    """
    {"id":"\(id)","songId":"\(song)","authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
     "instrument":"guitar","label":null,"audioUrl":"\(url)","audioContentType":"audio/mp4","audioBytes":10,
     "videoUrl":null,"videoContentType":null,"videoBytes":null,"mediaExpiresAt":"2026-11-10T10:00:00.000Z",
     "offsetMs":0,"trimStartMs":0,"trimEndMs":0,"durationMs":1000,"gain":1,"peaks":[0.5],"inMix":true,
     "voteCount":0,"createdAt":"2026-11-09T22:01:00.000Z"}
    """
}

@MainActor
private func makeSession() -> SessionStore {
    let api = APIClient(tokenProvider: JamTestToken(), protocolClasses: [JamStubURLProtocol.self])
    return SessionStore(authMode: .devBypass, tokenProvider: JamTestToken(), api: api)
}

private let channel: Channel = try! Coding.decoder.decode(Channel.self, from: Data("""
{"id":"chan-1","serverId":"srv-1","kind":"server","name":"jam","type":"jam","position":0,"isPrivate":false}
""".utf8))

private let server = Server(id: "srv-1", name: "S", ownerId: "u1", role: "owner", createdAt: Date())

// MARK: - A fake audio session

final class FakeAudioDriver: JamAudioSessionDriver {
    var category: AVAudioSession.Category
    var mode: AVAudioSession.Mode = .default
    var categoryOptions: AVAudioSession.CategoryOptions = []
    var outputLatency: TimeInterval = 0
    var log: [String] = []
    var activeFalseError: Error?
    var activeTrueError: Error?
    /// Refuses a category change when it answers an error for it.
    var categoryError: ((AVAudioSession.Category) -> Error?)?

    init(category: AVAudioSession.Category = .ambient) { self.category = category }

    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions) throws {
        if let error = categoryError?(category) { throw error }
        log.append("category:\(category.rawValue)")
        self.category = category
        self.mode = mode
        self.categoryOptions = options
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        if active, let activeTrueError { throw activeTrueError }
        if !active, let activeFalseError { throw activeFalseError }
        log.append("active:\(active)")
    }
}

private let busyError = NSError(
    domain: NSOSStatusErrorDomain, code: AVAudioSession.ErrorCode.isBusy.rawValue
)

// MARK: - The audio session: who owns it

@MainActor
final class JamAudioSessionOwnershipTests: XCTestCase {
    func testAFreeSessionIsTakenAndGivenBackWithItsOldCategory() {
        let driver = FakeAudioDriver(category: .ambient)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        XCTAssertEqual(driver.category, .playback)
        XCTAssertTrue(session.isHolding)
        XCTAssertTrue(session.ownsLockScreen)
        XCTAssertEqual(session.deactivate(), .released)
        XCTAssertEqual(driver.category, .ambient, "the rest of the app is not left on .playback")
        XCTAssertFalse(session.isHolding)
        XCTAssertEqual(driver.log, ["category:AVAudioSessionCategoryPlayback", "active:true", "active:false", "category:AVAudioSessionCategoryAmbient"])
    }

    func testASessionAnotherPlayerAlreadyHoldsIsSharedNeverReleased() {
        let driver = FakeAudioDriver(category: .playback)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        XCTAssertFalse(session.isHolding, "it was theirs before the song came")
        XCTAssertEqual(session.deactivate(), .notOurs)
        XCTAssertFalse(driver.log.contains("active:false"), "their playback is not stopped under them")
    }

    func testACallsSessionIsNeverTouched() {
        let driver = FakeAudioDriver(category: .playAndRecord)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: true)
        XCTAssertEqual(driver.log, [])
        XCTAssertFalse(session.ownsLockScreen, "the lock screen is left to the call")
        let rec = FakeAudioDriver(category: .playAndRecord)
        JamAudioSession(driver: rec).activate(callActive: false)
        XCTAssertEqual(rec.log, [], "a recording category is a call whatever the app model says")
    }

    func testACallThatTookTheSessionDuringTheSongIsLeftAlone() {
        let driver = FakeAudioDriver(category: .ambient)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        driver.category = .playAndRecord  // a call started
        driver.log = []
        XCTAssertEqual(session.deactivate(), .takenOver)
        XCTAssertEqual(driver.log, [], "no deactivate, no category restored under the call")
        XCTAssertFalse(session.isHolding)
    }

    func testABusySessionBecauseAnotherPlayerRunsIsRespectedAndNothingIsRestored() {
        let driver = FakeAudioDriver(category: .ambient)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        driver.activeFalseError = busyError
        driver.log = []
        XCTAssertEqual(session.deactivate(), .busy)
        XCTAssertEqual(driver.category, .playback, "the player that is still going keeps its category")
        XCTAssertEqual(driver.log, [])
        XCTAssertFalse(session.isHolding, "it steps aside and does not retry under them")
    }

    func testAnyOtherRefusalKeepsTheSessionSoTheNextReleaseTriesAgain() {
        let driver = FakeAudioDriver(category: .ambient)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        driver.activeFalseError = NSError(domain: NSOSStatusErrorDomain, code: -50)
        XCTAssertEqual(session.deactivate(), .stillActive)
        XCTAssertTrue(session.isHolding)
        driver.activeFalseError = nil
        XCTAssertEqual(session.deactivate(), .released)
    }

    func testARefusedCategoryChangeDoesNotLeaveTheActivatedSessionActive() {
        let driver = FakeAudioDriver(category: .ambient)
        driver.categoryError = { $0 == .playback ? NSError(domain: NSOSStatusErrorDomain, code: -50) : nil }
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        XCTAssertEqual(driver.category, .ambient, "the change was refused")
        XCTAssertTrue(session.isHolding, "but the session did get activated by this song")
        XCTAssertEqual(session.deactivate(), .released)
        XCTAssertEqual(driver.log.last, "active:false", "so it is deactivated, not left active with no song")
    }

    func testACategoryThatCouldNotBePutBackIsRetriedOnTheNextRelease() {
        let driver = FakeAudioDriver(category: .ambient)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        driver.categoryError = { $0 == .ambient ? NSError(domain: NSOSStatusErrorDomain, code: -50) : nil }
        XCTAssertEqual(session.deactivate(), .released)
        XCTAssertEqual(driver.category, .playback, "the restore was refused")
        driver.categoryError = nil
        XCTAssertEqual(session.deactivate(), .released)
        XCTAssertEqual(driver.category, .ambient, "and the next release puts it back")
        XCTAssertEqual(session.deactivate(), .notOurs, "then there is nothing left to do")
    }

    func testASessionReactivatedWhileACategoryRestoreIsPendingIsStillReleased() {
        let driver = FakeAudioDriver(category: .ambient)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        driver.categoryError = { $0 == .ambient ? NSError(domain: NSOSStatusErrorDomain, code: -50) : nil }
        XCTAssertEqual(session.deactivate(), .released)  // restore refused, pending
        // The song is played again: the leftover .playback is its own, not somebody else's.
        session.activate(callActive: false)
        XCTAssertTrue(session.isHolding)
        driver.log = []
        driver.categoryError = nil
        XCTAssertEqual(session.deactivate(), .released)
        XCTAssertEqual(driver.log, ["active:false", "category:AVAudioSessionCategoryAmbient"], "deactivated first, then the category put back")
        XCTAssertEqual(driver.category, .ambient)
    }

    func testAFailedActivationDoesNotClaimTheLockScreen() {
        let driver = FakeAudioDriver(category: .ambient)
        driver.activeTrueError = NSError(domain: NSOSStatusErrorDomain, code: -50)
        let session = JamAudioSession(driver: driver)
        session.activate(callActive: false)
        XCTAssertFalse(session.ownsLockScreen)
    }
}

// MARK: - The song screen's lifecycle and failures

@MainActor
final class JamSongModelLifecycleTests: XCTestCase {
    private func detail(tracks: [String]) -> Data {
        Data("""
        {"song":\(songJSON("s1", tracks: tracks.count)),"tracks":[\(tracks.map { trackJSON($0) }.joined(separator: ","))],
         "viewer":{"isAuthor":false,"canModerate":false,"addableInstruments":[],"votedTrackIds":[]}}
        """.utf8)
    }

    func testAFailedEngineStartReleasesTheSessionItTookAndSaysSo() async throws {
        let body = detail(tracks: [])
        JamStubURLProtocol.handler = { _ in (0, 200, body) }
        let driver = FakeAudioDriver(category: .ambient)
        let model = JamSongModel(
            song: try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON("s1").utf8)),
            channel: channel, server: server, audioSession: JamAudioSession(driver: driver)
        )
        await model.start(session: makeSession())
        model.startEngine = { _ in throw NSError(domain: "test", code: 1) }
        model.startPlayback(from: 0)
        XCTAssertFalse(model.isPlaying)
        XCTAssertNotNil(model.notice)
        XCTAssertFalse(model.audioSession.isHolding, "the session is not left active while the song is idle")
        XCTAssertEqual(driver.category, .ambient, "and the old category is back")
        XCTAssertEqual(driver.log.last, "category:AVAudioSessionCategoryAmbient")
        model.stop()
    }

    func testLeavingDuringTheFirstReadMeansNoDownloadAndNoEngineAfterwards() async throws {
        let body = detail(tracks: ["t1", "t2"])
        JamStubURLProtocol.handler = { _ in (0.3, 200, body) }
        let driver = FakeAudioDriver()
        let model = JamSongModel(
            song: try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON("s1").utf8)),
            channel: channel, server: server, audioSession: JamAudioSession(driver: driver)
        )
        let session = makeSession()
        let started = Task { await model.start(session: session) }
        try await Task.sleep(for: .milliseconds(60))
        model.stop()  // the person went back while the read was out
        await started.value
        XCTAssertEqual(model.downloadBatches, 0, "no stem is fetched for a screen that is gone")
        XCTAssertEqual(model.engine.durationMs, 0)
        model.startPlayback(from: 0)
        XCTAssertEqual(driver.log, [], "and a late play cannot take the audio session")
    }

    func testTheDetailReadFillsTheTracks() async throws {
        let body = detail(tracks: ["t1"])
        JamStubURLProtocol.handler = { _ in (0, 200, body) }
        let model = JamSongModel(
            song: try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON("s1").utf8)),
            channel: channel, server: server, audioSession: JamAudioSession(driver: FakeAudioDriver())
        )
        await model.start(session: makeSession())
        XCTAssertEqual(model.tracks.map(\.id), ["t1"])
        model.stop()
    }
}

// MARK: - The wall: pages and live frames

private func jamRoute(_ request: URLRequest, pages: @Sendable (String?) -> (TimeInterval, Data)) -> (TimeInterval, Int, Data) {
    let path = request.url?.path ?? ""
    if path.hasSuffix("/api/jam/config") { return (0, 200, Data("{\"enabled\":true,\"uploads\":true}".utf8)) }
    let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first { $0.name == "cursor" }?.value
    let (delay, body) = pages(cursor)
    return (delay, 200, body)
}

@MainActor
final class JamWallModelRaceTests: XCTestCase {
    /// The model holds its session weakly, as the app does: the test keeps it.
    private var keep: SessionStore?

    func testALatePageThatARefreshOvertookIsDroppedAndTheNewCursorStays() async throws {
        let generation = LockedBox(0)
        JamStubURLProtocol.handler = { request in
            jamRoute(request) { cursor in
                if cursor == "c1" { return (0.4, listJSON(["late"], next: nil)) }
                return generation.value == 0
                    ? (0, listJSON(["a", "b"], next: "c1"))
                    : (0, listJSON(["a", "b2"], next: "c9"))
            }
        }
        let model = JamWallModel(channel: channel, server: server)
        keep = makeSession()
        model.attach(session: keep!)
        await model.load()
        XCTAssertEqual(model.state.songs.map(\.id), ["a", "b"])
        let more = Task { await model.loadMore() }
        try await Task.sleep(for: .milliseconds(80))
        generation.value = 1
        await model.refresh()
        await more.value
        XCTAssertEqual(model.state.songs.map(\.id), ["a", "b2"], "the obsolete page did not come back")
        XCTAssertEqual(model.state.nextCursor, "c9", "and did not replace the refreshed cursor")
    }

    func testALiveSongThatArrivesWhileThePageIsOutSurvivesTheAnswer() async throws {
        let slow = LockedBox(false)
        JamStubURLProtocol.handler = { request in
            jamRoute(request) { _ in (slow.value ? 0.3 : 0, listJSON(["a"], next: nil)) }
        }
        let model = JamWallModel(channel: channel, server: server)
        keep = makeSession()
        model.attach(session: keep!)
        await model.load()
        slow.value = true
        let refresh = Task { await model.load() }
        try await Task.sleep(for: .milliseconds(80))
        let live = try Coding.decoder.decode(JamSongSummary.self, from: Data(songJSON("n", updated: 200).utf8))
        model.apply(.jam(.songCreated(channelId: "chan-1", song: live)))
        await refresh.value
        XCTAssertTrue(model.state.songs.contains { $0.id == "n" }, "the answer was produced before it; it is applied on top")
    }

    func testAFailedPageLeavesARetryAndTheWallAsItWas() async throws {
        let fail = LockedBox(false)
        JamStubURLProtocol.handler = { [self] request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/jam-songs"), request.url?.query?.contains("cursor=") == true, fail.value {
                return (0, 500, Data("{\"error\":\"boom\"}".utf8))
            }
            return jamRoute(request) { _ in (0, listJSON(["a"], next: "c1")) }
        }
        let model = JamWallModel(channel: channel, server: server)
        keep = makeSession()
        model.attach(session: keep!)
        await model.load()
        fail.value = true
        await model.loadMore()
        XCTAssertTrue(model.loadMoreFailed)
        XCTAssertEqual(model.state.songs.map(\.id), ["a"])
        fail.value = false
        await model.loadMore()
        XCTAssertFalse(model.loadMoreFailed)
    }
}

final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ value: T) { stored = value }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

// MARK: - Video players, and a song whose only video is WebM

@MainActor
final class JamVideoTests: XCTestCase {
    private func track(_ id: String, video: String?, type: String?, inMix: Bool = true) -> JamTrack {
        JamTrack(
            id: id, songId: "s", authorId: "u", authorName: "n", instrument: .guitar,
            audioUrl: "https://example.invalid/\(id).m4a", videoUrl: video, videoContentType: type,
            durationMs: 1000, peaks: [0.5], inMix: inMix
        )
    }

    func testNoMoreThanFourPlayersExistWhatTheStageDraws() {
        let sync = JamVideoSync()
        let tracks = (0..<7).map { track("t\($0)", video: "https://example.invalid/\($0).mp4", type: "video/mp4") }
        sync.load(tracks)
        XCTAssertEqual(sync.items.count, 4)
        XCTAssertEqual(Set(sync.items.keys), ["t0", "t1", "t2", "t3"])
    }

    func testWebMVideoGetsNoPlayerAndDoesNotUseUpASlot() {
        let sync = JamVideoSync()
        let tracks = [track("w", video: "https://example.invalid/w.webm", type: "video/webm")]
            + (0..<5).map { track("m\($0)", video: "https://example.invalid/\($0).mp4", type: "video/mp4") }
        sync.load(tracks)
        XCTAssertNil(sync.player(for: "w"))
        XCTAssertEqual(sync.items.count, 4)
        XCTAssertFalse(JamVideoSync.canPlay(contentType: "video/webm"))
        XCTAssertTrue(JamVideoSync.canPlay(contentType: "video/mp4"))
    }

    func testASongWhoseOnlyVideoIsWebMHasNoPosterNoPlayerAndStillAllItsAudio() {
        let webm = track("w", video: "https://example.invalid/w.webm", type: "video/webm")
        let preview = JamPreview(readAt: Date(), tracks: [webm])
        XCTAssertTrue(preview.hasVideo, "it is a video song")
        XCTAssertNil(preview.posterTrackId, "but no poster is ever asked for, so nothing loads and nothing spins")
        XCTAssertNil(preview.posterURL)
        XCTAssertFalse(preview.envelope.allSatisfy { $0 == 0 }, "the tile draws the waveform of its audio instead")
        let sync = JamVideoSync()
        sync.load([webm])
        XCTAssertTrue(sync.items.isEmpty)
        // The audio is a different file of the same track and is untouched.
        let stems = JamMixRules.stems([webm], files: ["w": URL(fileURLWithPath: "/tmp/w.m4a")])
        XCTAssertEqual(stems.map(\.id), ["w"])
        XCTAssertEqual(JamMixRules.activeTracks([webm], auditioning: [:]).map(\.id), ["w"])
    }

    func testAPosterIsOnlyAskedForAnMP4() {
        XCTAssertTrue(JamPosterCache.canPoster(contentType: "video/mp4"))
        XCTAssertFalse(JamPosterCache.canPoster(contentType: "video/webm"))
        XCTAssertFalse(JamPosterCache.canPoster(contentType: nil))
    }
}

// MARK: - Naming, links, bands

final class JamNamingAndLinksTests: XCTestCase {
    private func track(label: String?, person: String? = "Bia", _ instrument: JamInstrument = .bass) -> JamTrack {
        JamTrack(id: "t", songId: "s", authorId: "u", authorName: person, instrument: instrument, label: label)
    }

    func testATrackIsNamedInstrumentThenLabelThenPersonWithClearSeparators() {
        let t = track(label: "take 2, com pedal")
        XCTAssertEqual(JamTrackNaming.full(t), "Bass \u{00B7} take 2, com pedal \u{00B7} Bia")
        XCTAssertEqual(JamTrackNaming.caption(t), "take 2, com pedal \u{00B7} Bia")
        XCTAssertEqual(JamTrackNaming.spoken(t), "Bass, take 2, com pedal, by Bia")
    }

    func testAMissingLabelIsAbsentNotAnEmptySlotAndNeverGluedToTheName() {
        for none in [nil, "", "   "] as [String?] {
            let t = track(label: none)
            XCTAssertEqual(JamTrackNaming.full(t), "Bass \u{00B7} Bia")
            XCTAssertEqual(JamTrackNaming.caption(t), "Bia")
            XCTAssertEqual(JamTrackNaming.spoken(t), "Bass, by Bia")
        }
        XCTAssertEqual(JamTrackNaming.full(track(label: nil, person: nil)), "Bass")
        XCTAssertEqual(JamTrackNaming.spoken(track(label: "live", person: nil)), "Bass, live")
    }

    func testAnAccountNameWithASuffixIsOneNameNotALabel() {
        // The dev bypass names a second account "Dev User leo". That is the
        // person; the label slot is separate and stays empty.
        let t = track(label: nil, person: "Dev User leo", .drums)
        XCTAssertEqual(JamTrackNaming.full(t), "Drums \u{00B7} Dev User leo")
        let labelled = track(label: "bateria seca", person: "Dev User leo", .drums)
        XCTAssertEqual(JamTrackNaming.full(labelled), "Drums \u{00B7} bateria seca \u{00B7} Dev User leo")
    }

    func testAChipNamesTheWholeTrackWhenAloneAndThePeopleWhenSeveral() {
        let one = track(label: "take 2")
        XCTAssertEqual(JamTrackNaming.chip(instrument: .bass, tracks: [one]), "Bass \u{00B7} take 2 \u{00B7} Bia")
        let many = [track(label: nil, person: "Bia"), track(label: "x", person: "Duda"), track(label: nil, person: "Leo"), track(label: nil, person: "Bia")]
        XCTAssertEqual(JamTrackNaming.chip(instrument: .bass, tracks: many), "Bass \u{00B7} Bia, Duda +1")
        XCTAssertEqual(JamTrackNaming.chip(instrument: .guitar, tracks: many), "Guitar")
    }

    func testTheSongLinkIsExactlyTheWebRoute() {
        XCTAssertEqual(
            JamLinks.song(serverId: "S1", channelId: "C1", songId: "N1")?.absoluteString,
            "https://pqp.gg/app/server/S1/channel/C1/song/N1"
        )
        XCTAssertEqual(
            JamLinks.channel(serverId: "S1", channelId: "C1")?.absoluteString,
            "https://pqp.gg/app/server/S1/channel/C1"
        )
    }

    func testBandsKeepEveryTileInOneBandAndCoverEveryPlacementOnce() {
        let sizes: [JamTileSize] = [.hero, .small, .small, .wide, .small, .small, .hero, .small, .wide, .small]
        for columns in [2, 4] {
            let placements = JamMosaic.layout(sizes: sizes, columns: columns)
            let bands = JamMosaic.bands(placements)
            XCTAssertEqual(bands.flatMap { $0 }.map(\.index).sorted(), Array(0..<sizes.count))
            var nextRow = 0
            for band in bands {
                let first = band.map(\.row).min()!
                let end = band.map { $0.row + $0.rows }.max()!
                XCTAssertEqual(first, nextRow, "bands are contiguous, no gap between them")
                nextRow = end
            }
        }
        // A 2 x 2 hero and the small tiles beside it (4 columns) are one band.
        let four = JamMosaic.bands(JamMosaic.layout(sizes: [.hero, .small, .small, .small, .small], columns: 4))
        XCTAssertEqual(four.first?.count, 5)
    }
}

// MARK: - The summary that answers a tile (server #1579), and the old shape

final class JamSummaryShapesTests: XCTestCase {
    /// A summary from a server that carries the preview fields.
    private func newShape(
        peaks: String = "[0.2,0.9,0.4]", hasVideo: String = "true",
        contributors: String = #"[{"id":"u1","name":"rafa","avatarUrl":null},{"id":"u2","name":"duda","avatarUrl":"/api/avatars/u2"},{"id":"u3","name":null,"avatarUrl":null}]"#,
        missing: String = "[]", mode: String = "wanted", count: Int = 6
    ) -> JamSongSummary {
        let json = """
        {"id":"s1","channelId":"c1","serverId":"sv","title":"T","artist":null,"joinMode":"\(mode)",
         "wantedInstruments":["vocals","bass"],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
         "createdAt":"2026-11-09T22:00:00.000Z","updatedAt":"2026-11-09T22:05:00.000Z","trackCount":3,
         "instruments":["guitar"],"contributorCount":\(count),"mixDurationMs":1000,
         "previewPeaks":\(peaks),"hasVideo":\(hasVideo),"contributors":\(contributors),"missingInstruments":\(missing)}
        """
        return try! Coding.decoder.decode(JamSongSummary.self, from: Data(json.utf8))
    }

    /// A summary from a server before the change: none of the four keys.
    private func oldShape() -> JamSongSummary {
        try! Coding.decoder.decode(JamSongSummary.self, from: Data(JamContractTests.songJSON.utf8))
    }

    func testTheNewShapeDecodesAllFourFields() {
        let s = newShape()
        XCTAssertEqual(s.previewPeaks, [0.2, 0.9, 0.4])
        XCTAssertEqual(s.hasVideo, true)
        XCTAssertEqual(s.contributors?.map(\.name), ["rafa", "duda", nil])
        XCTAssertEqual(s.contributors?[1].avatarUrl, "/api/avatars/u2")
        XCTAssertEqual(s.missingInstruments, [])
        XCTAssertTrue(s.answersPreview)
    }

    func testTheOldShapeLeavesThemNilNotEmptyAndAnswersNothing() {
        let s = oldShape()
        XCTAssertNil(s.previewPeaks)
        XCTAssertNil(s.hasVideo)
        XCTAssertNil(s.contributors)
        XCTAssertNil(s.missingInstruments)
        XCTAssertFalse(s.answersPreview)
    }

    func testAnEmptyPeaksArrayIsAnAnswerAndAnAbsentOneIsNot() {
        XCTAssertTrue(newShape(peaks: "[]").answersPreview, "no stem has peaks: a real answer")
        XCTAssertFalse(oldShape().answersPreview)
    }

    func testAFieldThisBuildCannotReadFallsBackInsteadOfLosingTheSong() {
        let s = newShape(peaks: #""not an array""#)
        XCTAssertNil(s.previewPeaks)
        XCTAssertFalse(s.answersPreview)
        XCTAssertEqual(s.title, "T", "the song is still in the list")
    }

    func testAWantedSongTakesWhatIsMissingFromTheServerWhenItSaysSo() {
        XCTAssertEqual(JamNeed.of(newShape(missing: #"["vocals"]"#)), .missing([.vocals]))
        XCTAssertEqual(JamNeed.of(newShape(missing: "[]")), .ready)
    }

    func testTheOldShapeStillWorksItOutFromTheWantedList() {
        let old = JamSongSummary(
            id: "s", channelId: "c", serverId: "sv", title: "T", joinMode: .wanted,
            wantedInstruments: [.vocals, .bass], trackCount: 2, instruments: [.guitar, .bass]
        )
        XCTAssertEqual(JamNeed.of(old), .missing([.vocals]))
    }

    func testFactsComeFromTheSummaryWhenItAnswersAndThePreviewOtherwise() {
        let detail = JamPreview(readAt: Date(), tracks: [
            JamTrack(id: "t", songId: "s", authorId: "u9", authorName: "from detail", instrument: .guitar,
                     durationMs: 1000, peaks: [1, 1, 1], inMix: true)
        ])
        let fromSummary = JamTileFacts.resolve(song: newShape(), preview: detail)
        XCTAssertEqual(fromSummary.envelope, [0.2, 0.9, 0.4], "the summary wins")
        XCTAssertEqual(fromSummary.contributorNames, ["rafa", "duda"])
        XCTAssertTrue(fromSummary.hasVideo)
        XCTAssertTrue(fromSummary.isReady)

        let old = oldShape()
        let before = JamTileFacts.resolve(song: old, preview: nil)
        XCTAssertEqual(before.envelope, [])
        XCTAssertNil(before.contributorNames)
        XCTAssertFalse(before.isReady, "a placeholder waveform until the detail arrives")
        let after = JamTileFacts.resolve(song: old, preview: detail)
        XCTAssertEqual(after.contributorNames, ["from detail"])
        XCTAssertTrue(after.isReady)
        XCTAssertFalse(after.hasVideo)
    }

    func testOnlyAVideoSongThatAnswersInItsSummaryReadsTheDetail() {
        // New server: no detail for audio-only, one for a video poster.
        XCTAssertFalse(JamPreviewPolicy.needsDetail(song: newShape(hasVideo: "false"), hasCurrentPreview: false))
        XCTAssertTrue(JamPreviewPolicy.needsDetail(song: newShape(hasVideo: "true"), hasCurrentPreview: false))
        XCTAssertFalse(JamPreviewPolicy.needsDetail(song: newShape(hasVideo: "true"), hasCurrentPreview: true))
        // Old server: every tile, as before.
        XCTAssertTrue(JamPreviewPolicy.needsDetail(song: oldShape(), hasCurrentPreview: false))
        XCTAssertFalse(JamPreviewPolicy.needsDetail(song: oldShape(), hasCurrentPreview: true))
        // An empty song never does.
        let empty = JamSongSummary(id: "e", channelId: "c", serverId: "s", title: "E", trackCount: 0)
        XCTAssertFalse(JamPreviewPolicy.needsDetail(song: empty, hasCurrentPreview: false))
    }

    func testTheWhoLineCountsPeopleTheSummaryDidNotName() {
        // Four named at most, six in all.
        XCTAssertEqual(JamWho.line(song: newShape(count: 6), contributors: ["a", "b", "c", "d"]), "a, b +4")
        // Three people, one with no name (account gone): the unnamed is counted.
        XCTAssertEqual(JamWho.line(song: newShape(count: 3), contributors: ["rafa", "duda"]), "rafa, duda +1")
        XCTAssertEqual(JamWho.line(song: newShape(count: 2), contributors: ["rafa", "duda"]), "rafa, duda")
    }

    func testAFrameCarryingTheNewFieldsReplacesTheTilesFacts() {
        var state = JamWallState(songs: [newShape(peaks: "[0.1]", hasVideo: "false")])
        let updated = newShape(peaks: "[0.8,0.8]", hasVideo: "true")
        state.apply(.songUpdated(channelId: "c1", song: updated), channelId: "c1")
        XCTAssertEqual(state.songs.first?.previewPeaks, [0.8, 0.8])
        XCTAssertEqual(state.songs.first?.hasVideo, true)
    }
}

@MainActor
final class JamWallNoDetailReadsTests: XCTestCase {
    private var keep: SessionStore?

    func testTheWallReadsNoDetailForAnAudioOnlySongOnANewServerButOneForAVideoPoster() async throws {
        let detailReads = LockedBox(0)
        let songs = (0..<3).map { i in
            """
            {"id":"s\(i)","channelId":"chan-1","serverId":"srv-1","title":"T\(i)","artist":null,"joinMode":"open",
             "wantedInstruments":[],"authorId":"u1","authorName":"rafa","authorAvatarUrl":null,
             "createdAt":"2026-11-09T22:00:01.000Z","updatedAt":"2026-11-09T22:01:0\(i).000Z","trackCount":1,
             "instruments":["guitar"],"contributorCount":1,"mixDurationMs":1000,
             "previewPeaks":[0.5],"hasVideo":\(i == 1 ? "true" : "false"),
             "contributors":[{"id":"u1","name":"rafa","avatarUrl":null}],"missingInstruments":[]}
            """
        }.joined(separator: ",")
        let listBody = Data("{\"songs\":[\(songs)],\"nextCursor\":null}".utf8)
        let detailBody = Data("""
        {"song":\(songJSON("s1")),"tracks":[\(trackJSON("t1", song: "s1"))],
         "viewer":{"isAuthor":false,"canModerate":false,"addableInstruments":[],"votedTrackIds":[]}}
        """.utf8)
        JamStubURLProtocol.handler = { request in
            if (request.url?.path ?? "").contains("/api/jam-songs/") {
                detailReads.value += 1
                return (0, 200, detailBody)
            }
            return (0, 200, listBody)
        }
        keep = makeSession()
        let model = JamWallModel(channel: channel, server: server)
        model.attach(session: keep!)
        await model.load()
        XCTAssertEqual(model.state.songs.count, 3)
        for song in model.state.songs { model.requestPreview(for: song) }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(detailReads.value, 1, "only the video song asks, for its poster")
    }

    func testAnOldServerStillGetsOneDetailReadPerTile() async throws {
        let detailReads = LockedBox(0)
        let listBody = listJSON(["a", "b", "c"], next: nil)
        let detailBody = Data("""
        {"song":\(songJSON("a")),"tracks":[\(trackJSON("t1", song: "a"))],
         "viewer":{"isAuthor":false,"canModerate":false,"addableInstruments":[],"votedTrackIds":[]}}
        """.utf8)
        JamStubURLProtocol.handler = { request in
            if (request.url?.path ?? "").contains("/api/jam-songs/") {
                detailReads.value += 1
                return (0, 200, detailBody)
            }
            return (0, 200, listBody)
        }
        keep = makeSession()
        let model = JamWallModel(channel: channel, server: server)
        model.attach(session: keep!)
        await model.load()
        for song in model.state.songs { model.requestPreview(for: song) }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(detailReads.value, 3, "the fallback path is the one every server had")
    }
}
