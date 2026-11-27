import XCTest
@testable import pqp

// Round 2 of #1781 (the independent QA): the ordering rule for opening a song
// after the wall's push, where a public jam lives, and a part that was deleted
// before its answer arrived.

final class JamSongOpenRuleTests: XCTestCase {
    /// The song is the second push of a link. It is pushed once the stack is
    /// idle, and when it is not on top after its transition it is pushed once
    /// more, and never again.
    func testASongThatDidNotAppearIsPushedOnceMoreAndNoMore() {
        XCTAssertTrue(JamSongOpenRule.shouldRetry(appeared: false, attempts: 0))
        XCTAssertFalse(JamSongOpenRule.shouldRetry(appeared: false, attempts: 1), "a second drop is not retried for ever")
        XCTAssertFalse(JamSongOpenRule.shouldRetry(appeared: true, attempts: 0), "a song that is on top is left alone")
        XCTAssertFalse(JamSongOpenRule.shouldRetry(appeared: true, attempts: 1))
        XCTAssertEqual(JamSongOpenRule.retries, 1)
    }
}

final class JamPublicBaseTests: XCTestCase {
    private let id = "11111111-1111-4111-8111-111111111111"

    func testTheHostedAppSendsPeopleToTheJamSite() {
        XCTAssertEqual(JamPublicBase.songURL(songId: id, tagged: false, origin: nil)?.absoluteString, "https://jam.pqp.gg/m/\(id)")
        XCTAssertEqual(JamPublicBase.songURL(songId: id, tagged: true, origin: nil)?.absoluteString, "https://jam.pqp.gg/m/\(id)?ref=share")
        XCTAssertEqual(
            JamPublicBase.songURL(songId: id, tagged: false, origin: "https://www.pqp.gg")?.absoluteString,
            "https://jam.pqp.gg/m/\(id)"
        )
    }

    /// Any other deployment answers on its own origin, the web's rule: the host is
    /// the app's configured one, never one written into a screen.
    func testAnotherDeploymentUsesItsOwnOrigin() {
        XCTAssertEqual(
            JamPublicBase.songURL(songId: id, tagged: false, origin: "http://localhost:5173")?.absoluteString,
            "http://localhost:5173/jam/m/\(id)"
        )
        XCTAssertEqual(
            JamPublicBase.songURL(songId: id, tagged: true, origin: "https://chat.example.org")?.absoluteString,
            "https://chat.example.org/jam/m/\(id)?ref=share"
        )
    }

    func testTheDefaultOriginIsTheBuildsOwn() {
        XCTAssertEqual(
            JamPublicBase.songURL(songId: id, tagged: false)?.absoluteString,
            JamPublicBase.songURL(songId: id, tagged: false, origin: BauShare.currentWebOrigin)?.absoluteString
        )
    }
}

private func staleDetail(without ids: Set<String>) -> String {
    let tracks = [
        requestTrackJSON("t0", instrument: "guitar", inMix: true, author: "u1"),
        requestTrackJSON("t1", instrument: "bass", inMix: false),
        requestTrackJSON("t2", instrument: "drums", inMix: false),
    ].enumerated().filter { !ids.contains("t\($0.offset)") }.map(\.element)
    return """
    {"song":\(requestSongJSON()),"tracks":[\(tracks.joined(separator: ","))],
     "viewer":{"isAuthor":true,"canModerate":false,"addableInstruments":["guitar"],"votedTrackIds":[]}}
    """
}

@MainActor
final class JamStalePartTests: XCTestCase {
    private var keep: SessionStore?

    private func open(
        method: String
    ) async throws -> (JamSongModel, LockedBox<Int>) {
        let log = LockedBox<[Sent]>([])
        let reads = LockedBox(0)
        let current = LockedBox(staleDetail(without: []))
        let base = publicRoute(
            log: log, inbox: LockedBox(inboxJSON([("t1", "bass"), ("t2", "drums")])),
            notices: LockedBox(noticesJSON([]))
        )
        JamStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let verb = request.httpMethod ?? "GET"
            if verb == "GET", path.hasSuffix("/api/jam/config") { return (0, 200, Data(#"{"enabled":true,"uploads":true}"#.utf8)) }
            if verb == "GET", path == "/api/jam-songs/s1" {
                reads.value += 1
                return (0, 200, Data(current.value.utf8))
            }
            if verb == method, path == "/api/jam-tracks/t1" {
                // The part was taken back by its sender before this answer got there.
                current.value = staleDetail(without: ["t1"])
                return (0, 404, Data(#"{"error":"Not found"}"#.utf8))
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
        return (model, reads)
    }

    func testAnAcceptOnAPartThatNoLongerExistsSaysSoAndLeavesNoGhost() async throws {
        let (model, reads) = try await open(method: "PATCH")
        let before = reads.value
        await model.accept(try XCTUnwrap(model.requestTracks.first { $0.id == "t1" }))
        XCTAssertEqual(model.answer?.kind, .gone)
        XCTAssertTrue(model.answer?.text().contains("no longer exists") == true)
        XCTAssertNil(model.requestError, "it is an answer of its own, so it survives the block going away")
        XCTAssertGreaterThan(reads.value, before, "the whole song was read again")
        XCTAssertFalse(model.tracks.contains { $0.id == "t1" }, "no ghost chip, lane or other take")
        XCTAssertFalse(model.otherTakes.contains { $0.id == "t1" })
        XCTAssertEqual(model.requestTracks.map(\.id), ["t2"])
        XCTAssertFalse(model.settledTracks.contains { $0.id == "t1" })
        model.stop()
    }

    func testADeclineOnAPartThatNoLongerExistsSaysSoToo() async throws {
        let (model, _) = try await open(method: "DELETE")
        await model.decline(try XCTUnwrap(model.requestTracks.first { $0.id == "t1" }))
        XCTAssertEqual(model.answer?.kind, .gone)
        XCTAssertFalse(model.tracks.contains { $0.id == "t1" })
        XCTAssertEqual(model.requestTracks.map(\.id), ["t2"], "no ghost row left in the block")
        model.stop()
    }
}
