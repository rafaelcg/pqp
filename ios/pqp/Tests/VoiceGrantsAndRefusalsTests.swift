import XCTest
@testable import pqp

/**
 TWO GRANTS AND ONE REFUSAL, all of which used to fail quietly.

 `canStream` is a separate permission from `canSpeak` on the server and was
 read off `canSpeak` here, so somebody with a microphone and no camera grant
 was offered the camera, had the publish refused, and was told the call
 "already has the maximum number of cameras". Wrong about them and wrong about
 the room, and it sends a person to ask a human rather than to the permission
 screen.

 `voice-join-refused` was not decoded at all. It means the rejoin did not
 happen: we are not in the room, we are in nobody's roster, and nobody can hear
 us. Dropping it left a phone sitting on a live microphone and a call screen
 for as long as the person kept talking into it.
 */
final class VoiceGrantsAndRefusalsTests: XCTestCase {

    private let room = "33333333-3333-3333-3333-333333333333"

    // MARK: - Resolving STREAM off the wire

    /// Absent means a server from before the grants were split, where SPEAK
    /// gated publishing too. Falling back to `true` instead would hand a
    /// listen-only seat a camera, which is the wrong direction to be wrong in.
    func testAbsentStreamFollowsSpeakRatherThanDefaultingOpen() {
        XCTAssertTrue(VoiceSpeakRule.resolveStream(
            topLevel: nil, selfPeer: nil, canSpeak: true
        ))
        XCTAssertFalse(VoiceSpeakRule.resolveStream(
            topLevel: nil, selfPeer: nil, canSpeak: false
        ))
    }

    /// Top level first, then `self.canStream`, matching how SPEAK resolves.
    func testStreamPrefersTheTopLevelThenSelf() {
        XCTAssertFalse(VoiceSpeakRule.resolveStream(
            topLevel: false, selfPeer: true, canSpeak: true
        ))
        XCTAssertFalse(VoiceSpeakRule.resolveStream(
            topLevel: nil, selfPeer: false, canSpeak: true
        ))
    }

    /// A participant without the key reads as "whatever SPEAK said", which is
    /// what an older server means by omitting it.
    func testAParticipantWithoutTheKeyFollowsItsOwnCanSpeak() throws {
        let json = """
        {"peerId":"p1","userId":"44444444-4444-4444-4444-444444444444",
         "displayName":"Bia","avatarUrl":null,"canSpeak":false}
        """
        let peer = try Coding.decoder.decode(VoiceParticipant.self, from: Data(json.utf8))
        XCTAssertFalse(peer.canSpeak)
        XCTAssertFalse(peer.canStream)
    }

    /// And the split really is carried when the server sends it: a microphone
    /// with no camera is a state this app has to be able to represent at all.
    func testAParticipantCanSpeakWithoutBeingAbleToStream() throws {
        let json = """
        {"peerId":"p1","userId":"44444444-4444-4444-4444-444444444444",
         "displayName":"Bia","avatarUrl":null,"canSpeak":true,"canStream":false}
        """
        let peer = try Coding.decoder.decode(VoiceParticipant.self, from: Data(json.utf8))
        XCTAssertTrue(peer.canSpeak)
        XCTAssertFalse(peer.canStream)
    }

    // MARK: - What losing STREAM alone does

    /**
     THE BUG IN ONE ASSERTION. Losing STREAM while keeping SPEAK has to take
     the camera and the screen share down.

     It did not, because `stopPublishing` was consulted only after an early
     return on `mute`, so a revoke that did not touch the microphone did
     nothing whatever and the camera stayed on in a channel that had just
     forbidden it.
     */
    func testLosingStreamAloneStopsPublishingWithoutMuting() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: true, canStream: false, wasSpeak: true, wasStream: true, source: .change
        )
        XCTAssertFalse(outcome.mute, "The microphone is a separate grant and was not revoked")
        XCTAssertTrue(outcome.stopPublishing)
        XCTAssertEqual(outcome.notice, .streamDenied)
    }

    /// And getting it back says so, without touching the mute.
    func testRegainingStreamAloneSaysSoAndPublishesNothingByItself() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: true, canStream: true, wasSpeak: true, wasStream: false, source: .change
        )
        XCTAssertFalse(outcome.stopPublishing)
        XCTAssertEqual(outcome.notice, .streamGranted)
    }

    /// A seat that walks in able to talk but not to publish is told once, on
    /// arrival, rather than finding out by tapping the camera.
    func testAWelcomeWithoutStreamExplainsItself() {
        let outcome = VoiceSpeakRule.apply(
            canSpeak: true, canStream: false, wasSpeak: true, wasStream: true, source: .welcome
        )
        XCTAssertEqual(outcome.notice, .streamDenied)
    }

    /// One sentence at a time, and SPEAK outranks STREAM: losing the
    /// microphone is the bigger news, and two sentences stacked under the
    /// controls on a phone is how both get ignored.
    func testLosingBothSaysTheSpeakOne() {
        let welcome = VoiceSpeakRule.apply(
            canSpeak: false, canStream: false, wasSpeak: true, wasStream: true, source: .welcome
        )
        XCTAssertEqual(welcome.notice, .listenOnly)
        let change = VoiceSpeakRule.apply(
            canSpeak: false, canStream: false, wasSpeak: true, wasStream: true, source: .change
        )
        XCTAssertEqual(change.notice, .listenOnly)
        XCTAssertTrue(change.mute)
        XCTAssertTrue(change.stopPublishing)
    }

    // MARK: - Through the real decoder

    /// `voice-speak-changed` carries both bits, and an older server that sends
    /// only SPEAK must not silently hand out a camera grant.
    func testSpeakChangedCarriesBothBits() async {
        let split = """
        {"type":"voice-speak-changed","voiceChannelId":"\(room)",
         "canSpeak":true,"canStream":false}
        """
        guard case .voiceSpeakChanged(_, let canSpeak, let canStream) =
                await firstEvent(from: split) else {
            return XCTFail("Expected voiceSpeakChanged")
        }
        XCTAssertTrue(canSpeak)
        XCTAssertFalse(canStream)

        let older = """
        {"type":"voice-speak-changed","voiceChannelId":"\(room)","canSpeak":false}
        """
        guard case .voiceSpeakChanged(_, _, let inherited) =
                await firstEvent(from: older) else {
            return XCTFail("Expected voiceSpeakChanged")
        }
        XCTAssertFalse(inherited, "Absent canStream must follow canSpeak, never default open")
    }

    /// `welcome` resolves STREAM from the top-level key, then `self`, then
    /// SPEAK. This is the frame that decides whether the camera button is
    /// there at all for the whole call.
    func testWelcomeResolvesStream() async {
        let json = """
        {"type":"welcome","peerId":"p1","voiceChannelId":"\(room)","peers":[],
         "self":{"peerId":"p1","userId":"44444444-4444-4444-4444-444444444444",
                 "displayName":"Me","avatarUrl":null,"canSpeak":true,"canStream":false}}
        """
        guard case .voiceWelcome(_, _, _, _, _, _, _, let canSpeak, let canStream) =
                await firstEvent(from: json) else {
            return XCTFail("Expected voiceWelcome")
        }
        XCTAssertTrue(canSpeak)
        XCTAssertFalse(canStream)
    }

    // MARK: - The refusal

    /**
     `voice-join-refused` has to reach a model at all.

     It was falling through to `.other`, so a phone whose resume was declined
     kept its microphone open on a call screen while being in no room and no
     roster. That is indistinguishable, from the inside, from a call where
     everybody has gone quiet.
     */
    func testJoinRefusedDecodesWithAndWithoutAReason() async {
        let withReason = """
        {"type":"voice-join-refused","voiceChannelId":"\(room)",
         "reason":"mesh-multi-instance"}
        """
        guard case .voiceJoinRefused(let channelId, let reason) =
                await firstEvent(from: withReason) else {
            return XCTFail("Expected voiceJoinRefused")
        }
        XCTAssertEqual(channelId, room)
        XCTAssertEqual(reason, "mesh-multi-instance")

        let bare = """
        {"type":"voice-join-refused","voiceChannelId":"\(room)"}
        """
        guard case .voiceJoinRefused(_, let none) = await firstEvent(from: bare) else {
            return XCTFail("Expected voiceJoinRefused with no reason")
        }
        XCTAssertNil(none, "A refusal without a reason is still a refusal")
    }

    /// And both models act on it, rather than decoding it into nothing. Same
    /// reasoning as the promotion capability's source check: a frame that is
    /// decoded and ignored leaves exactly the broken call it was sent to
    /// prevent, and every decode test above still passes.
    func testBothVoiceModelsHangUpOnARefusal() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // …/ios/pqp/Tests
            .deletingLastPathComponent()   // …/ios/pqp
            .appending(path: "Sources")

        for model in ["Voice/VoiceModel.swift", "Voice/CallModel.swift"] {
            let source = try String(contentsOf: sources.appending(path: model), encoding: .utf8)
            XCTAssertTrue(
                source.contains("case .voiceJoinRefused"),
                "\(model) drops `voice-join-refused` on the floor, so a phone whose rejoin "
                    + "was declined sits on a live microphone in a room it is not in."
            )
        }
    }

    // MARK: - Fixtures

    private actor Collected {
        var events: [RealtimeEvent] = []
        func append(_ event: RealtimeEvent) { events.append(event) }
    }

    private func firstEvent(from frame: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        let collected = Collected()
        let pump = Task {
            for await event in stream {
                await collected.append(event)
            }
        }
        await client.ingest(Data(frame.utf8))
        try? await Task.sleep(for: .milliseconds(200))
        pump.cancel()
        return await collected.events.first
    }
}
