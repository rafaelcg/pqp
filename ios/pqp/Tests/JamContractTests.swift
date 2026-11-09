import XCTest
@testable import pqp

/// The wire contract (`packages/shared/src/jam.ts`), decoded as the server
/// sends it: ISO dates with milliseconds, an instrument a newer server
/// invented, the seven frames, and a frame this build must drop rather than
/// guess at.
final class JamContractTests: XCTestCase {
    static let songJSON = """
    {"id":"11111111-1111-4111-8111-111111111111","channelId":"22222222-2222-4222-8222-222222222222",
     "serverId":"33333333-3333-4333-8333-333333333333","title":"In Bloom","artist":"Nirvana",
     "joinMode":"wanted","wantedInstruments":["vocals","accordion"],"authorId":"44444444-4444-4444-8444-444444444444",
     "authorName":"rafa","authorAvatarUrl":null,"createdAt":"2026-11-09T22:00:00.123Z",
     "updatedAt":"2026-11-09T22:05:00.456Z","trackCount":3,"instruments":["guitar","bass"],
     "contributorCount":2,"mixDurationMs":10500}
    """

    static func trackJSON(id: String = "55555555-5555-4555-8555-555555555555", extra: String = "") -> String {
        """
        {"id":"\(id)","songId":"11111111-1111-4111-8111-111111111111","authorId":"44444444-4444-4444-8444-444444444444",
         "authorName":"rafa","authorAvatarUrl":null,"instrument":"synth","label":null,
         "audioUrl":"https://example.test/a.m4a","audioContentType":"audio/mp4","audioBytes":1234,
         "videoUrl":null,"videoContentType":null,"videoBytes":null,"mediaExpiresAt":"2026-11-10T10:00:00.000Z",
         "offsetMs":-500,"trimStartMs":120,"trimEndMs":200,"durationMs":10000,"gain":1.5,
         "peaks":[0,0.5,1],"inMix":true,"voteCount":2,"createdAt":"2026-11-09T22:01:00.000Z"\(extra)}
        """
    }

    private func decode<T: Decodable>(_ json: String, as type: T.Type = T.self) throws -> T {
        try Coding.decoder.decode(T.self, from: Data(json.utf8))
    }

    func testASongDecodesWithMillisecondDatesAndUnknownInstrumentsAsOther() throws {
        let song: JamSongSummary = try decode(Self.songJSON)
        XCTAssertEqual(song.title, "In Bloom")
        XCTAssertEqual(song.joinMode, .wanted)
        XCTAssertEqual(song.wantedInstruments, [.vocals, .other], "a newer server's instrument reads as other")
        XCTAssertEqual(song.instruments, [.guitar, .bass])
        XCTAssertEqual(song.mixDurationMs, 10500)
        XCTAssertGreaterThan(song.updatedAt, song.createdAt)
    }

    func testATrackKeepsANegativeOffsetAndBothTrims() throws {
        let track: JamTrack = try decode(Self.trackJSON())
        XCTAssertEqual(track.instrument, .other)
        XCTAssertEqual(track.offsetMs, -500)
        XCTAssertEqual(track.trimStartMs, 120)
        XCTAssertEqual(track.trimEndMs, 200)
        // The contract's `jamTrackPlayedMs` and `jamTrackEndMs`.
        XCTAssertEqual(track.playedMs, 9680)
        XCTAssertEqual(track.endMs, 9180)
        XCTAssertFalse(track.hasVideo)
    }

    func testAnUnknownJoinModeReadsAsTheRestrictiveOne() throws {
        let json = Self.songJSON.replacingOccurrences(of: "\"wanted\"", with: "\"invite-only\"")
        let song: JamSongSummary = try decode(json)
        XCTAssertEqual(song.joinMode, .closed)
    }

    func testTheDetailAndTheViewerDecode() throws {
        let json = """
        {"song":\(Self.songJSON),"tracks":[\(Self.trackJSON())],
         "viewer":{"isAuthor":true,"canModerate":false,"addableInstruments":["guitar"],
                   "votedTrackIds":["55555555-5555-4555-8555-555555555555"]}}
        """
        let detail: JamSongDetail = try decode(json)
        XCTAssertEqual(detail.tracks.count, 1)
        XCTAssertTrue(detail.viewer.isAuthor)
        XCTAssertEqual(detail.viewer.votedTrackIds, ["55555555-5555-4555-8555-555555555555"])
    }

    func testTheConfigIsOffWhenTheKeyIsMissing() throws {
        let off: JamConfig = try decode("{}")
        XCTAssertEqual(off, .off)
        let on: JamConfig = try decode("{\"enabled\":true,\"uploads\":false}")
        XCTAssertTrue(on.enabled)
        XCTAssertFalse(on.uploads)
    }

    // MARK: Frames

    private func frame(_ type: String, _ body: String) -> JamFrame? {
        JamFrame.parse(Data("{\"type\":\"\(type)\",\"channelId\":\"22222222-2222-4222-8222-222222222222\",\(body)}".utf8))
    }

    func testAllSevenFramesParse() throws {
        let song = Self.songJSON
        let track = Self.trackJSON()
        let tid = "55555555-5555-4555-8555-555555555555"
        XCTAssertNotNil(frame("jam-song-created", "\"song\":\(song)"))
        XCTAssertNotNil(frame("jam-song-updated", "\"song\":\(song)"))
        XCTAssertNotNil(frame("jam-song-deleted", "\"songId\":\"11111111-1111-4111-8111-111111111111\""))
        XCTAssertNotNil(frame("jam-track-added", "\"song\":\(song),\"track\":\(track)"))
        XCTAssertNotNil(frame("jam-track-updated", "\"song\":\(song),\"track\":\(track)"))
        XCTAssertNotNil(frame("jam-track-deleted", "\"song\":\(song),\"trackId\":\"\(tid)\""))
        let votes = frame("jam-track-votes", "\"songId\":\"11111111-1111-4111-8111-111111111111\",\"trackId\":\"\(tid)\",\"voteCount\":7")
        guard case .trackVotes(_, _, _, let count)? = votes else { return XCTFail("votes frame") }
        XCTAssertEqual(count, 7)
        XCTAssertEqual(JamFrame.types.count, 7)
    }

    func testAFrameMissingItsPayloadIsDroppedNotGuessed() {
        XCTAssertNil(frame("jam-track-added", "\"song\":\(Self.songJSON)"))
        XCTAssertNil(frame("jam-song-deleted", "\"x\":1"))
        XCTAssertNil(frame("jam-something-new", "\"songId\":\"a\""))
    }

    func testEveryFrameTypeIsOneTheRealtimeClientRoutes() {
        // The socket sends these exact strings (`JAM_FRAME_TYPES`).
        XCTAssertEqual(JamFrame.types, [
            "jam-song-created", "jam-song-updated", "jam-song-deleted", "jam-track-added",
            "jam-track-updated", "jam-track-deleted", "jam-track-votes",
        ])
    }

    func testAChannelOfTypeJamIsNeverListedOnItsOwn() throws {
        let channel = try Coding.decoder.decode(Channel.self, from: Data("""
        {"id":"c1","serverId":"s1","kind":"server","name":"jam","type":"jam","position":0,"isPrivate":false}
        """.utf8))
        XCTAssertTrue(channel.isJam)
        // Hidden unless the server's flag draws it: an unflagged server must
        // look exactly as it did before jam existed.
        XCTAssertFalse(channel.isListed)
        XCTAssertFalse(channel.opensAsChat)
    }

    func testTheListHidesAJamChannelUntilTheFlagIsOn() throws {
        let jam = try Coding.decoder.decode(Channel.self, from: Data("""
        {"id":"j","serverId":"s1","kind":"server","name":"jam","type":"jam","position":1,"isPrivate":false,"parentId":"cat"}
        """.utf8))
        let category = try Coding.decoder.decode(Channel.self, from: Data("""
        {"id":"cat","serverId":"s1","kind":"server","name":"Canais","type":"category","position":0,"isPrivate":false}
        """.utf8))
        XCTAssertEqual(ChannelListView.children(of: category, in: [jam]).map(\.id), [])
        XCTAssertEqual(ChannelListView.children(of: category, in: [jam], jamEnabled: true).map(\.id), ["j"])
    }
}
