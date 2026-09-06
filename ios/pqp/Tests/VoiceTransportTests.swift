import XCTest
@testable import pqp

/// The transport decision, pinned.
///
/// Everything here is the part of an SFU join that fails silently when it is
/// wrong: a client that builds a mesh in a LiveKit room is, to everyone else, a
/// participant who never unmutes. The rules must agree with `use-voice.ts` and
/// `docs/voice-backends.md` "One room, one transport", because the two clients
/// meet in the same call.
final class VoiceTransportTests: XCTestCase {

    // MARK: - What `welcome.transport` means

    /// A LiveKit welcome must never build peer connections.
    func testLiveKitWelcomeIsNotMesh() {
        XCTAssertEqual(VoiceTransportPlan(transport: "livekit"), .livekit)
        XCTAssertNotEqual(VoiceTransportPlan(transport: "livekit"), .mesh)
    }

    func testMeshWelcomeIsMesh() {
        XCTAssertEqual(VoiceTransportPlan(transport: "mesh"), .mesh)
    }

    /// Absent means a server that predates the field, which is mesh by
    /// definition. A refusal here would lock this app out of every self-host
    /// running an older server.
    func testAbsentTransportIsMesh() {
        XCTAssertEqual(VoiceTransportPlan(transport: nil), .mesh)
    }

    /// A transport this build has never heard of is a leave, not a guess.
    func testUnknownTransportIsUnsupported() {
        XCTAssertEqual(VoiceTransportPlan(transport: "cloudflare-sfu"), .unsupported("cloudflare-sfu"))
        XCTAssertNil(VoiceTransportPlan(transport: "cloudflare-sfu").transport)
    }

    // MARK: - What the join declares

    /// Both, in this order. `["mesh"]` alone is what got this app refused from
    /// every SFU room; omitting the field would be read as "both" by accident
    /// rather than on purpose.
    func testJoinDeclaresBothTransports() {
        let frame = joinVoiceRoomFrame(
            channelId: "33333333-3333-3333-3333-333333333333",
            declaresResume: false,
            resume: nil
        )
        XCTAssertEqual(frame["type"] as? String, "join-voice-room")
        XCTAssertEqual(frame["voiceChannelId"] as? String, "33333333-3333-3333-3333-333333333333")
        XCTAssertEqual(frame["transports"] as? [String], ["mesh", "livekit"])
        XCTAssertNil(frame["resume"])
        XCTAssertNil(frame["resumePeerId"])
        XCTAssertNil(frame["resumeToken"])
    }

    /// The resume declaration and the resume claim are separate: the first is
    /// sent on a cold join in an SFU deployment, the second only on the rejoin
    /// that has something to present.
    func testJoinCarriesResumeClaimWhenPresent() {
        let frame = joinVoiceRoomFrame(
            channelId: "33333333-3333-3333-3333-333333333333",
            declaresResume: true,
            resume: VoiceResumeClaim(peerId: "p1", token: "hmac")
        )
        XCTAssertEqual(frame["resume"] as? Bool, true)
        XCTAssertEqual(frame["resumePeerId"] as? String, "p1")
        XCTAssertEqual(frame["resumeToken"] as? String, "hmac")
    }

    /// The frame has to survive `JSONSerialization`, which is what actually
    /// sends it. A value type it refuses is a join that never leaves the phone.
    func testJoinFrameSerialises() throws {
        let frame = joinVoiceRoomFrame(
            channelId: "33333333-3333-3333-3333-333333333333",
            declaresResume: true,
            resume: VoiceResumeClaim(peerId: "p1", token: "hmac")
        )
        let data = try JSONSerialization.data(withJSONObject: frame)
        let back = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(back["transports"] as? [String], ["mesh", "livekit"])
        XCTAssertEqual(back["resume"] as? Bool, true)
    }

    /// Only an SFU deployment gets the seat held. A mesh room that held one
    /// would show a ghost of this phone for 90 seconds after every blip.
    func testResumeIsDeclaredOnlyForLiveKitDeployments() {
        XCTAssertTrue(VoiceBackendInfo(backend: "livekit").declaresResume)
        XCTAssertFalse(VoiceBackendInfo(backend: "mesh").declaresResume)
        XCTAssertFalse(VoiceBackendInfo(backend: "cloudflare-sfu").declaresResume)
    }

    // MARK: - The token request

    /// `POST /api/voice/token` takes exactly these two keys, spelled exactly
    /// so; `voiceSessionRequestSchema` is strict about both and the server
    /// answers a mismatch with a 400 that reads, to the user, like "could not
    /// reach the voice server".
    func testTokenRequestShape() throws {
        let request = VoiceSessionRequest(
            voiceChannelId: "33333333-3333-3333-3333-333333333333",
            peerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        )
        let data = try Coding.encoder.encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["voiceChannelId", "peerId"])
        XCTAssertEqual(json["voiceChannelId"] as? String, "33333333-3333-3333-3333-333333333333")
        XCTAssertEqual(json["peerId"] as? String, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    }

    /// The answer, as `voiceSessionSchema` shapes it.
    func testTokenResponseDecodes() throws {
        let json = """
        {"backend":"livekit","url":"wss://sfu.example.test","token":"jwt",
         "room":"33333333-3333-3333-3333-333333333333","identity":"p1"}
        """
        let info = try Coding.decoder.decode(VoiceSessionInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.backend, "livekit")
        XCTAssertEqual(info.url, "wss://sfu.example.test")
        XCTAssertEqual(info.token, "jwt")
        XCTAssertEqual(info.identity, "p1")
    }

    // MARK: - The 45 second clock

    /// The number itself, because it is a contract with the web client and with
    /// the server's own join timer.
    func testSfuJoinTimeoutIs45Seconds() {
        XCTAssertEqual(sfuJoinTimeout, .seconds(45))
    }

    /// A connect that never comes up is a `.timedOut`, not a hang. Run with a
    /// short clock so the test does not wait the real 45 seconds; the helper
    /// takes the duration as a parameter for exactly this reason.
    func testConnectThatNeverCompletesTimesOut() async {
        do {
            try await withSfuTimeout(.milliseconds(50)) {
                try await Task.sleep(for: .seconds(30))
            }
            XCTFail("expected a timeout")
        } catch let error as SfuJoinError {
            XCTAssertEqual(error, .timedOut)
        } catch {
            XCTFail("expected SfuJoinError.timedOut, got \(error)")
        }
    }

    /// A connect that completes in time is the value, not a timeout.
    func testConnectThatCompletesInTimeReturns() async throws {
        let value = try await withSfuTimeout(.seconds(5)) { "connected" }
        XCTAssertEqual(value, "connected")
    }

    /// A connect that fails on its own reports its own error, not the clock's.
    func testConnectFailureIsNotReportedAsTimeout() async {
        do {
            try await withSfuTimeout(.seconds(5)) {
                throw SfuJoinError.token("503 SFU backend not configured")
            }
            XCTFail("expected a token error")
        } catch let error as SfuJoinError {
            XCTAssertEqual(error, .token("503 SFU backend not configured"))
        } catch {
            XCTFail("expected SfuJoinError.token, got \(error)")
        }
    }

    // MARK: - What the user is told

    /// Every failure to establish media says the same thing, and it is the web
    /// client's sentence: the two clients describe one failure one way.
    func testEveryMediaFailureHasTheOneMessage() {
        let expected = "Could not reach the voice server, so you have not joined this call. Check your network and try again."
        XCTAssertEqual(sfuFailureMessage(.timedOut), expected)
        XCTAssertEqual(sfuFailureMessage(.token("500")), expected)
        XCTAssertEqual(sfuFailureMessage(.connect("refused")), expected)
    }

    /// A join abandoned by a leave is not a failure; nothing is shown.
    func testSupersededJoinIsSilent() {
        XCTAssertNil(sfuFailureMessage(.superseded))
    }

    // MARK: - Keeping the room across a socket blip

    func testSessionIsKeptOnlyWhenResumedSamePeerAndStillConnected() {
        XCTAssertTrue(keepsSfuSession(resumed: true, welcomePeerId: "p1", currentPeerId: "p1", sfuConnected: true))
        // Cold join after the blip: a new id, so a new LiveKit identity.
        XCTAssertFalse(keepsSfuSession(resumed: false, welcomePeerId: "p2", currentPeerId: "p1", sfuConnected: true))
        // The server reattached but the SFU had already given up on its side.
        XCTAssertFalse(keepsSfuSession(resumed: true, welcomePeerId: "p1", currentPeerId: "p1", sfuConnected: false))
        // Says resumed, but not our id. Never trust the flag over the id.
        XCTAssertFalse(keepsSfuSession(resumed: true, welcomePeerId: "p2", currentPeerId: "p1", sfuConnected: true))
        // First welcome of the call: nothing to keep yet.
        XCTAssertFalse(keepsSfuSession(resumed: false, welcomePeerId: "p1", currentPeerId: nil, sfuConnected: false))
    }
}
