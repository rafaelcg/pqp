import XCTest
@testable import pqp

/**
 FOLLOWING A ROOM THAT MOVED, tested as the ways it can be silently wrong.

 A mesh room is promoted to the SFU when it reaches `MESH_ROOM_PROMOTION_SIZE`
 (four) people, when somebody wants a camera past the mesh cap, or when a ninth
 person arrives. The server tells every seat that declared
 `voice-transport-changed` and RELEASES every seat that did not.

 That asymmetry is what makes this file's subject dangerous rather than merely
 missing. Before it, iOS declared nothing and was thrown out of a four person
 call, which is bad and VISIBLE. Declaring the capability and then not acting
 on the frame is worse and invisible: the server keeps the seat, the person
 stays in the roster, and their media is on a mesh the rest of the room has
 left. Nobody hears them and nothing on their screen says so.

 So the tests below are about the decision and the plumbing rather than about
 the happy path:

 - `voicePromotionAction` is the rule, and every `ignore` in it prevents a
   specific disaster (tearing down the call we are actually in, reconnecting
   over working media, guessing at a transport from a newer server).
 - The frame has to survive `RealtimeClient.ingest`, because a rule nothing
   calls is the same outcome as no rule.
 - The capability and the handlers have to stay together, because that is the
   pair whose drift is silent in both directions.
 */
final class VoicePromotionTests: XCTestCase {

    private let room = "44444444-4444-4444-4444-444444444444"
    private let otherRoom = "55555555-5555-5555-5555-555555555555"

    // MARK: - The decision

    /// The ordinary case, and the only one that touches media: we are in this
    /// room, on the mesh, seated, and the server moved it to the SFU.
    func testAMeshRoomThatMovesToTheSfuIsFollowed() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: room, frameTransport: "livekit",
                currentChannelId: room, currentTransport: .mesh,
                isLive: true, selfPeerId: "p1"
            ),
            .follow(.livekit)
        )
    }

    /// The socket receives voice frames for every room its owner can SEE, not
    /// just the one this phone is in. Acting on one of those would tear down
    /// the call we are actually in for a promotion somewhere else entirely.
    func testAPromotionInAnotherRoomIsIgnored() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: otherRoom, frameTransport: "livekit",
                currentChannelId: room, currentTransport: .mesh,
                isLive: true, selfPeerId: "p1"
            ),
            .ignore
        )
    }

    /// Not in a call at all: there is nothing to move, and reconnecting would
    /// put this phone into a room nobody asked it to join.
    func testAPromotionWhileNotInACallIsIgnored() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: room, frameTransport: "livekit",
                currentChannelId: room, currentTransport: .mesh,
                isLive: false, selfPeerId: "p1"
            ),
            .ignore
        )
    }

    /// The SFU identity IS the peer id the server minted, and
    /// `POST /api/voice/token` signs that exact string. Without one there is
    /// nothing to reconnect as.
    func testAPromotionBeforeWelcomeHasAssignedAPeerIdIsIgnored() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: room, frameTransport: "livekit",
                currentChannelId: room, currentTransport: .mesh,
                isLive: true, selfPeerId: nil
            ),
            .ignore
        )
    }

    /**
     THE DUPLICATE, which is the one that would break a working call.

     Two publishers, or a replay across the cluster bus, can deliver this frame
     twice. The second copy arrives when the SFU room is already up, and acting
     on it would tear down live media to rebuild media that was fine.
     */
    func testASecondCopyOfThePromotionDoesNotRebuildLiveMedia() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: room, frameTransport: "livekit",
                currentChannelId: room, currentTransport: .livekit,
                isLive: true, selfPeerId: "p1"
            ),
            .ignore
        )
    }

    /// A transport this build has never heard of means a newer server moved
    /// the room somewhere we cannot reason about. Staying put is the honest
    /// answer: guessing is what produces the half moved room the whole one
    /// transport rule exists to prevent. Matches `use-voice.ts`.
    func testAnUnknownTransportLeavesTheLiveCallAlone() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: room, frameTransport: "cloudflare-sfu",
                currentChannelId: room, currentTransport: .mesh,
                isLive: true, selfPeerId: "p1"
            ),
            .ignore
        )
    }

    /// Nothing demotes a live room. A frame naming `mesh` is a duplicate or a
    /// server this build does not understand, and both stay put.
    func testAPromotionNamingMeshIsIgnored() {
        XCTAssertEqual(
            voicePromotionAction(
                frameChannelId: room, frameTransport: "mesh",
                currentChannelId: room, currentTransport: .mesh,
                isLive: true, selfPeerId: "p1"
            ),
            .ignore
        )
    }

    // MARK: - What it says on screen

    /// Three reasons, three sentences, and a reason from a newer server reads
    /// as the general one, which is true of every promotion. The same three
    /// the web client shows, because the two meet in the same call.
    func testTheNoticeNamesWhatTheRoomGrewFor() {
        XCTAssertEqual(
            voicePromotionNotice(reason: "cameras"),
            "This call became a large room so more cameras fit"
        )
        XCTAssertEqual(
            voicePromotionNotice(reason: "screens"),
            "This call became a large room so more screens fit"
        )
        XCTAssertEqual(
            voicePromotionNotice(reason: "room-size"),
            "This call became a large room so more people fit"
        )
        XCTAssertEqual(
            voicePromotionNotice(reason: "a reason invented after this build shipped"),
            "This call became a large room so more people fit"
        )
        XCTAssertEqual(
            voicePromotionNotice(reason: nil),
            "This call became a large room so more people fit"
        )
    }

    // MARK: - The frame, through the real decoder

    /**
     The room the frame carries is the whole point of it: a follower builds its
     SFU session from this list rather than waiting for a roster, so the
     participants have to survive decoding, self entry included.
     */
    func testTheFrameDecodesIntoTheRoomItCarries() async {
        let events = await events(from: [promotionFrame(peerIds: ["me", "b", "c", "d"])])

        guard case .voiceTransportChanged(let channelId, let transport, let reason, let people) =
                events.first else {
            return XCTFail("Expected a promotion, got \(events)")
        }
        XCTAssertEqual(channelId, room)
        XCTAssertEqual(transport, "livekit")
        XCTAssertEqual(reason, "room-size")
        XCTAssertEqual(people.map(\.peerId), ["me", "b", "c", "d"])
    }

    /**
     A frame with no room in it is one this build does not understand, and it
     is dropped rather than followed.

     Defaulting to an empty list would be worse than ignoring it: the session
     would move to the SFU holding a roster of nobody, so every other person in
     the call would vanish from the screen until a keyframe arrived.
     */
    func testAPromotionWithNoParticipantsIsDropped() async {
        let frame = """
        {"type":"voice-transport-changed","voiceChannelId":"\(room)",
         "transport":"livekit","reason":"room-size"}
        """
        let events = await events(from: [frame])
        XCTAssertTrue(events.isEmpty, "Expected nothing, got \(events)")
    }

    /**
     `reason` has to reach the model, because it is the whole difference
     between two sentences that mean opposite things.

     Without a reason the join was refused before a peer existed and nobody
     ever saw us. With `promoted` we WERE seated and the seat was released.
     Since this build declares the capability, `promoted` now means the two
     ends disagree, and telling somebody the app "cannot join" a call it was
     in a second ago reads as a bug rather than as an explanation.
     */
    func testTransportUnsupportedCarriesItsReason() async {
        let promoted = """
        {"type":"voice-transport-unsupported","voiceChannelId":"\(room)",
         "transport":"livekit","reason":"promoted"}
        """
        let refused = """
        {"type":"voice-transport-unsupported","voiceChannelId":"\(room)",
         "transport":"livekit"}
        """
        let events = await events(from: [promoted, refused])

        XCTAssertEqual(events.count, 2)
        guard case .voiceTransportUnsupported(_, _, let first) = events.first,
              case .voiceTransportUnsupported(_, _, let second) = events.last else {
            return XCTFail("Expected two refusals, got \(events)")
        }
        XCTAssertEqual(first, "promoted")
        XCTAssertNil(second)
    }

    // MARK: - The capability and the handlers, kept together

    /**
     THE PAIR THAT MUST NOT DRIFT, and the reason this test is written against
     the source text rather than against behaviour.

     Declaring `voice-transport-changed` changes what the SERVER does: it stops
     releasing this seat on a promotion. So a build that declares it and does
     not act on the frame is not degraded, it is broken in a way nobody can
     see, and it is broken for everyone else in the call too. Deleting either
     handler would leave every other test in this file passing, because the
     rule and the decode would both still be perfect.

     `RealtimeClient.wireCaps` itself is pinned exactly, next to the roster
     delta's, in `VoiceRosterDeltaTests`.
     */
    func testBothVoiceModelsActOnThePromotionTheyAskedFor() throws {
        let cap = "voice-transport-changed"
        XCTAssertTrue(
            RealtimeClient.wireCaps.contains(cap),
            "This build no longer asks for \(cap), so the server will release its seat "
                + "whenever a call reaches four people."
        )

        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // …/ios/pqp/Tests
            .deletingLastPathComponent()   // …/ios/pqp
            .appending(path: "Sources")

        for model in ["Voice/VoiceModel.swift", "Voice/CallModel.swift"] {
            let source = try String(contentsOf: sources.appending(path: model), encoding: .utf8)
            XCTAssertTrue(
                source.contains("case .voiceTransportChanged"),
                "\(model) no longer handles the promotion this build declares it can follow. "
                    + "The server therefore keeps the seat instead of releasing it, and the "
                    + "person sits in a call whose media has moved without them: silence "
                    + "nobody can see. Either handle the frame or drop the capability."
            )
            XCTAssertTrue(
                source.contains("startSfuSession(peerId: peerId, channelId: voiceChannelId, promoted: true)"),
                "\(model) decodes the promotion but never brings the media up on the voice "
                    + "server, which is the same broken call by a shorter route."
            )
        }
    }

    /**
     The string, against the three places that have to agree on it.

     The server matches it exactly (`socketHasCap`), so a rename anywhere makes
     every iOS seat fall back to being released on a promotion, with nothing
     going red on either side. Same defence as the roster delta's, and the same
     reason: CLAUDE.md pitfall 9.
     */
    func testTheCapabilityStringMatchesTheServerAndTheWebClient() throws {
        let cap = "voice-transport-changed"
        let repoRoot = URL(fileURLWithPath: #filePath)  // …/ios/pqp/Tests/…
            .deletingLastPathComponent()                // …/ios/pqp/Tests
            .deletingLastPathComponent()                // …/ios/pqp
            .deletingLastPathComponent()                // …/ios
            .deletingLastPathComponent()                // repo root

        for path in [
            "packages/shared/src/signaling.ts",
            "server/src/ws/sockets.ts",
            "client/src/lib/realtime.ts"
        ] {
            let source = try String(contentsOf: repoRoot.appending(path: path), encoding: .utf8)
            XCTAssertTrue(
                source.contains("\"\(cap)\""),
                "\(path) no longer names \"\(cap)\". The server compares this string exactly, "
                    + "so a rename there silently returns every iOS phone to being dropped "
                    + "out of any call that reaches four people."
            )
        }
    }

    // MARK: - Fixtures

    private func promotionFrame(peerIds: [String]) -> String {
        let participants = peerIds.map { id in
            """
            {"peerId":"\(id)","userId":"\(Self.uuid(for: id))","displayName":"\(id)",
             "avatarUrl":null,"sharingScreen":false,"muted":false,"deafened":false,
             "serverMuted":false,"canSpeak":true}
            """
        }.joined(separator: ",")
        return """
        {"type":"voice-transport-changed","voiceChannelId":"\(room)",
         "transport":"livekit","reason":"room-size","participants":[\(participants)]}
        """
    }

    private static func uuid(for id: String) -> String {
        let seed = abs(id.hashValue) % 1_000_000
        return String(format: "00000000-0000-0000-0000-%012d", seed)
    }

    private actor Collected {
        var events: [RealtimeEvent] = []
        func append(_ event: RealtimeEvent) { events.append(event) }
    }

    /// Frames in, events out, through the decoder the socket actually uses.
    /// Same shape as `VoiceRosterDeltaTests.events(from:)`, and settled the
    /// same way: a dropped frame yields nothing, and the only way to assert
    /// "nothing" is to give it a moment and count.
    private func events(from frames: [String]) async -> [RealtimeEvent] {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        let collected = Collected()
        let pump = Task {
            for await event in stream {
                await collected.append(event)
            }
        }
        for frame in frames {
            await client.ingest(Data(frame.utf8))
        }
        try? await Task.sleep(for: .milliseconds(200))
        pump.cancel()
        return await collected.events
    }
}
