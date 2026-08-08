import XCTest
@testable import pqp

/// The DM call's decisions, pinned.
///
/// Two kinds of thing are covered here, and both are the kind that fail
/// silently: the stage's layout/format rules, which must agree with
/// `client/src/components/dm/call-stage-state.ts` because the two clients meet
/// in the same call, and the ring frames' decoding, which is the wire contract
/// in `packages/shared/src/signaling.ts`. A drifted decode rule is a dropped
/// frame, not an error — a phone that simply never rings.
final class CallStateTests: XCTestCase {

    // MARK: - Stage layout

    func testLayoutIsRingWhenAloneAndSpotlightForOne() {
        XCTAssertEqual(callStageLayout(remoteCount: 0, hasScreenShare: false), .ring)
        XCTAssertEqual(callStageLayout(remoteCount: 1, hasScreenShare: false), .spotlight)
        XCTAssertEqual(callStageLayout(remoteCount: 2, hasScreenShare: false), .grid)
        XCTAssertEqual(callStageLayout(remoteCount: 5, hasScreenShare: false), .grid)
    }

    /// A shared screen outranks everything, including being alone with it: a
    /// face is glanceable at thumbnail size and a screen is not.
    func testScreenShareWinsEveryLayout() {
        for count in 0...4 {
            XCTAssertEqual(
                callStageLayout(remoteCount: count, hasScreenShare: true), .screen,
                "screen share should take the stage at remoteCount \(count)"
            )
        }
    }

    // MARK: - Duration

    func testDurationFormatting() {
        XCTAssertEqual(formatCallDuration(0), "0:00")
        XCTAssertEqual(formatCallDuration(7), "0:07")
        XCTAssertEqual(formatCallDuration(761), "12:41")
        XCTAssertEqual(formatCallDuration(3909), "1:05:09")
    }

    /// Clocks drift backwards across a resync; a negative elapsed must read as
    /// zero rather than "-1:-1".
    func testNegativeDurationClampsToZero() {
        XCTAssertEqual(formatCallDuration(-30), "0:00")
    }

    // MARK: - Phase

    func testOnlyLivePhasesCountAsLive() {
        XCTAssertFalse(CallPhase.idle.isLive)
        XCTAssertTrue(CallPhase.connecting.isLive)
        XCTAssertTrue(CallPhase.ringing.isLive)
        XCTAssertTrue(CallPhase.active.isLive)
        XCTAssertFalse(CallPhase.ended(nil).isLive)
        XCTAssertFalse(CallPhase.ended("No answer").isLive)
    }

    // MARK: - Wire

    private func firstEvent(from json: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(json.utf8))
        var iterator = stream.makeAsyncIterator()
        let waiter = Task { await iterator.next() }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            waiter.cancel()
        }
        let event = await waiter.value
        timeout.cancel()
        return event
    }

    /// `callIncomingMessageSchema`. The caller is a nested object, which is the
    /// bit a flat envelope quietly loses.
    func testCallIncomingDecodes() async throws {
        let json = """
        {"type":"call-incoming","conversationId":"22222222-2222-2222-2222-222222222222",
         "kind":"dm","caller":{"userId":"44444444-4444-4444-4444-444444444444",
         "displayName":"Ana","avatarUrl":null}}
        """
        let event = await firstEvent(from: json)
        guard case .callIncoming(let call) = event else {
            return XCTFail("Expected callIncoming, got \(String(describing: event))")
        }
        XCTAssertEqual(call.conversationId, "22222222-2222-2222-2222-222222222222")
        XCTAssertEqual(call.kind, "dm")
        XCTAssertEqual(call.callerName, "Ana")
        XCTAssertEqual(call.callerUserId, "44444444-4444-4444-4444-444444444444")
        XCTAssertNil(call.callerAvatarUrl)
    }

    func testCallRingCancelledCarriesItsReason() async throws {
        for reason in ["answered", "declined", "cancelled", "timeout"] {
            let json = """
            {"type":"call-ring-cancelled",
             "conversationId":"22222222-2222-2222-2222-222222222222","reason":"\(reason)"}
            """
            let event = await firstEvent(from: json)
            guard case .callRingCancelled(_, let decoded) = event else {
                return XCTFail("\(reason) did not decode as callRingCancelled")
            }
            XCTAssertEqual(decoded, reason)
        }
    }

    func testCallDeclinedDecodes() async throws {
        let json = """
        {"type":"call-declined","conversationId":"22222222-2222-2222-2222-222222222222",
         "userId":"44444444-4444-4444-4444-444444444444"}
        """
        let event = await firstEvent(from: json)
        guard case .callDeclined(let conversationId, let userId) = event else {
            return XCTFail("Expected callDeclined, got \(String(describing: event))")
        }
        XCTAssertEqual(conversationId, "22222222-2222-2222-2222-222222222222")
        XCTAssertEqual(userId, "44444444-4444-4444-4444-444444444444")
    }

    /// `cameraStreamId` is the entire basis for telling an arriving camera track
    /// from a screen share. Losing it in the decode does not fail anything — it
    /// silently draws someone's face in the screen-share slot.
    func testRosterCarriesCameraStreamIdAndVoiceState() async throws {
        let json = """
        {"type":"voice-roster","voiceChannelId":"33333333-3333-3333-3333-333333333333",
         "participants":[{"peerId":"p1","userId":"44444444-4444-4444-4444-444444444444",
         "displayName":"Ana","avatarUrl":null,"sharingScreen":false,
         "cameraStreamId":"cam-abc","muted":true,"deafened":false}],"transport":"mesh"}
        """
        let event = await firstEvent(from: json)
        guard case .voiceRoster(_, let participants) = event else {
            return XCTFail("Expected voiceRoster, got \(String(describing: event))")
        }
        XCTAssertEqual(participants.first?.cameraStreamId, "cam-abc")
        XCTAssertEqual(participants.first?.muted, true)
        XCTAssertEqual(participants.first?.deafened, false)
    }

    /// Camera off is an explicit `null`, and a server that predates cameras
    /// omits the key. Both must read as "no camera", never as a decode failure.
    func testAbsentAndNullCameraStreamIdBothReadAsOff() async throws {
        let variants = [
            "\"cameraStreamId\":null,",
            "",
        ]
        for extra in variants {
            let json = """
            {"type":"peer-joined","peer":{"peerId":"p1",
             "userId":"44444444-4444-4444-4444-444444444444","displayName":"Ana",
             "avatarUrl":null,\(extra)"sharingScreen":false}}
            """
            let event = await firstEvent(from: json)
            guard case .voicePeerJoined(let participant) = event else {
                return XCTFail("Expected voicePeerJoined for variant '\(extra)'")
            }
            XCTAssertNil(participant.cameraStreamId)
        }
    }
}
