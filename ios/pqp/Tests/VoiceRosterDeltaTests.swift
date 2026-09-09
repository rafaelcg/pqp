import XCTest
@testable import pqp

/**
 The convergence rule, tested from the outside.

 A roster bug on a phone does not look like an error. It looks like somebody
 missing from a call, or a moderator's mute that never lands, and it looks
 exactly like the other person having a bad connection. So these are written
 as the three ways this can be wrong rather than as a walk through the happy
 path: a peer silently dropped, an update silently missed, and a gap silently
 applied.

 Two layers. `VoiceRosterTracker` is checked directly, because it is where the
 rule lives. Then the same frames are fed through `RealtimeClient.ingest`,
 because a perfect tracker nobody calls is the same outcome as no tracker, and
 because the event the models actually read is the thing that has to be right.
 */
final class VoiceRosterDeltaTests: XCTestCase {

    // MARK: - Fixtures

    private func peer(
        _ id: String,
        name: String? = nil,
        muted: Bool = false,
        serverMuted: Bool = false,
        sharingScreen: Bool = false,
        cameraStreamId: String? = nil,
        canSpeak: Bool = true
    ) -> VoiceParticipant {
        let json = """
        {"peerId":"\(id)","userId":"\(Self.uuid(for: id))",
         "displayName":"\(name ?? id)","avatarUrl":null,
         "sharingScreen":\(sharingScreen),
         "cameraStreamId":\(cameraStreamId.map { "\"\($0)\"" } ?? "null"),
         "screenAudioStreamId":null,
         "muted":\(muted),"deafened":false,
         "serverMuted":\(serverMuted),"canSpeak":\(canSpeak)}
        """
        // Decoded rather than constructed, so the fixture goes through the very
        // decoder the wire uses. A field this app stopped reading would make
        // these tests pass against a participant the real socket cannot build.
        // swiftlint:disable:next force_try
        return try! Coding.decoder.decode(VoiceParticipant.self, from: Data(json.utf8))
    }

    private static func uuid(for id: String) -> String {
        let seed = abs(id.hashValue) % 1_000_000
        return String(format: "00000000-0000-0000-0000-%012d", seed)
    }

    private func ids(_ participants: [VoiceParticipant]?) -> [String]? {
        participants?.map(\.peerId)
    }

    private let room = "44444444-4444-4444-4444-444444444444"
    private let otherRoom = "55555555-5555-5555-5555-555555555555"

    // MARK: - The ordinary case

    func testADeltaAddsUpdatesAndRemovesInOneFrame() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b"), peer("c")], voiceChannelId: room, seq: 7)

        let applied = tracker.apply(
            deltaFor: room, seq: 8, size: 3,
            joined: [peer("d")],
            updated: [peer("b", muted: true)],
            left: ["a"]
        )

        XCTAssertEqual(ids(applied), ["b", "c", "d"])
        XCTAssertEqual(applied?.first { $0.peerId == "b" }?.muted, true)
        XCTAssertEqual(tracker.sequence(for: room), 8)
    }

    func testSeveralDeltasInARowCompose() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 1)

        _ = tracker.apply(deltaFor: room, seq: 2, size: 2, joined: [peer("b")])
        _ = tracker.apply(deltaFor: room, seq: 3, size: 3, joined: [peer("c")])
        let applied = tracker.apply(deltaFor: room, seq: 4, size: 2, left: ["a"])

        XCTAssertEqual(ids(applied), ["b", "c"])
    }

    /// The one that would show as faces jumping around the call screen every
    /// time anybody muted. A replaced peer keeps its place; a new one is
    /// appended.
    func testAnUpdateKeepsThePeerInPlaceAndAJoinGoesOnTheEnd() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b"), peer("c")], voiceChannelId: room, seq: 1)

        let applied = tracker.apply(
            deltaFor: room, seq: 2, size: 4,
            joined: [peer("d")],
            updated: [peer("a", muted: true)]
        )

        XCTAssertEqual(ids(applied), ["a", "b", "c", "d"])
    }

    /// Every entry is an absolute statement about one peer, which is what makes
    /// a delta overlapping a snapshot harmless. If it were relative this would
    /// double-count and the size check would fail.
    func testRestatingAPeerTheSnapshotAlreadyCarriedChangesNothing() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 4)

        let applied = tracker.apply(deltaFor: room, seq: 5, size: 2, joined: [peer("b")])

        XCTAssertEqual(ids(applied), ["a", "b"])
    }

    /// The lists are applied in order, so somebody who arrives and leaves
    /// inside one coalescing window ends up out, which is what the server saw.
    func testAWindowThatBothAddsAndRemovesTheSamePeerEndsWithItGone() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 1)

        let applied = tracker.apply(
            deltaFor: room, seq: 2, size: 2,
            joined: [peer("b"), peer("c")],
            updated: [peer("a", muted: true)],
            left: ["c"]
        )

        XCTAssertEqual(ids(applied), ["a", "b"])
    }

    // MARK: - The three ways it can be wrong

    /// A GAP MUST NOT BE APPLIED. Frame 9 never arrived, so frame 10 is
    /// measured against a room missing whatever 9 said.
    func testADeltaThatSkipsASequenceIsRefusedAndChangesNothing() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 8)

        XCTAssertNil(tracker.apply(deltaFor: room, seq: 10, size: 3, joined: [peer("d")]))
        XCTAssertEqual(tracker.sequence(for: room), 8)

        // The refusal did not advance the sequence: the next frame in line is
        // still 9. A tracker that had crept forward would resume applying on
        // top of a baseline missing a peer.
        let applied = tracker.apply(deltaFor: room, seq: 9, size: 3, joined: [peer("c")])
        XCTAssertEqual(ids(applied), ["a", "b", "c"])
    }

    /// A frame delivered twice, or out of order behind a newer one.
    func testADeltaWithASequenceAlreadyAppliedIsRefused() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 3)
        _ = tracker.apply(deltaFor: room, seq: 4, size: 2, joined: [peer("b")])

        XCTAssertNil(tracker.apply(deltaFor: room, seq: 4, size: 2, joined: [peer("b")]))
        XCTAssertEqual(tracker.sequence(for: room), 4)
    }

    /// THE SECOND, INDEPENDENT CHECK. The sequence is perfect and the room
    /// still does not match, which is divergence `seq` cannot see.
    func testADeltaWhoseSizeDisagreesIsRefusedAndChangesNothing() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 2)

        XCTAssertNil(tracker.apply(deltaFor: room, seq: 3, size: 9, joined: [peer("c")]))
        XCTAssertEqual(tracker.sequence(for: room), 2)

        // Nothing was written, so the refused join is not sitting in the
        // baseline waiting to fail the next size check as well.
        let applied = tracker.apply(deltaFor: room, seq: 3, size: 3, joined: [peer("c")])
        XCTAssertEqual(ids(applied), ["a", "b", "c"])
    }

    /// The repair. Whatever went wrong, and whether or not this client could
    /// tell, the next full roster replaces the state wholesale.
    func testAKeyframeRepairsAClientThatHadGivenUpOnTheDeltas() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 5)
        XCTAssertNil(tracker.apply(deltaFor: room, seq: 40, size: 2, joined: [peer("b")]))

        tracker.apply(snapshot: [peer("b"), peer("c")], voiceChannelId: room, seq: 41)

        let applied = tracker.apply(deltaFor: room, seq: 42, size: 3, joined: [peer("d")])
        XCTAssertEqual(ids(applied), ["b", "c", "d"])
    }

    // MARK: - Baselines, empty rooms, other rooms

    /// A client with no baseline holds 0, so the first delta of a room that has
    /// been empty is self-sufficient. Without this, joining a quiet channel and
    /// watching one person arrive would show nothing for up to ten seconds.
    func testTheFirstDeltaOfAFreshRoomAppliesWithNoBaselineAtAll() {
        var tracker = VoiceRosterTracker()

        let applied = tracker.apply(deltaFor: room, seq: 1, size: 1, joined: [peer("a")])

        XCTAssertEqual(ids(applied), ["a"])
        XCTAssertEqual(tracker.sequence(for: room), 1)
    }

    func testADeltaForARoomWithNoBaselineThatIsNotTheFirstIsRefused() {
        var tracker = VoiceRosterTracker()

        XCTAssertNil(tracker.apply(deltaFor: room, seq: 12, size: 1, joined: [peer("a")]))
        XCTAssertEqual(tracker.sequence(for: room), 0)
    }

    /// The server forgets an empty room's sequence so the next call in the
    /// channel starts again at 1. A client that kept the old number would read
    /// that first delta as a gap and sit out the whole of the next call.
    func testEmptyingTheRoomResetsTheSequenceSoTheNextCallStartsAtOne() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 6)

        let emptied = tracker.apply(deltaFor: room, seq: 7, size: 0, left: ["a"])
        XCTAssertEqual(ids(emptied), [])
        XCTAssertEqual(tracker.sequence(for: room), 0)
        XCTAssertEqual(tracker.trackedRoomCount, 0)

        let applied = tracker.apply(deltaFor: room, seq: 1, size: 1, joined: [peer("b")])
        XCTAssertEqual(ids(applied), ["b"])
    }

    func testAnEmptySnapshotResetsTheSequenceToo() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 6)
        tracker.apply(snapshot: [], voiceChannelId: room, seq: 7)

        XCTAssertEqual(tracker.sequence(for: room), 0)
        XCTAssertEqual(
            ids(tracker.apply(deltaFor: room, seq: 1, size: 1, joined: [peer("b")])),
            ["b"]
        )
    }

    /// Rooms are independent. A sequence that happens to line up must not patch
    /// the wrong room, and a delta for a busy channel must not disturb the one
    /// this device is sitting in.
    func testRoomsDoNotShareASequence() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 4)
        tracker.apply(snapshot: [peer("x")], voiceChannelId: otherRoom, seq: 30)

        let elsewhere = tracker.apply(deltaFor: otherRoom, seq: 31, size: 2, joined: [peer("y")])
        XCTAssertEqual(ids(elsewhere), ["x", "y"])

        XCTAssertEqual(tracker.sequence(for: room), 4)
        XCTAssertEqual(
            ids(tracker.apply(deltaFor: room, seq: 5, size: 3, joined: [peer("c")])),
            ["a", "b", "c"]
        )
    }

    func testForgetAllDropsEveryBaseline() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 30)
        tracker.apply(snapshot: [peer("x")], voiceChannelId: otherRoom, seq: 4)

        tracker.forgetAll()

        XCTAssertEqual(tracker.trackedRoomCount, 0)
        XCTAssertEqual(tracker.sequence(for: room), 0)
        // A server process that restarted its numbering at 1, taken rather than
        // refused for the whole of the rebuilt call.
        XCTAssertEqual(
            ids(tracker.apply(deltaFor: room, seq: 1, size: 1, joined: [peer("z")])),
            ["z"]
        )
    }

    // MARK: - What the call screen reads off the roster

    /// On a mesh room the roster is the ONLY channel the server has: it cannot
    /// touch the media, so a moderator's mute is every client obeying a flag.
    /// A delta that dropped it is a phone still playing somebody the whole call
    /// agreed not to.
    func testAModeratorMuteArrivingAsAnUpdateReachesThePeerItNames() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 1)

        let applied = tracker.apply(
            deltaFor: room, seq: 2, size: 2,
            updated: [peer("b", muted: true, serverMuted: true)]
        )

        XCTAssertEqual(applied?.first { $0.peerId == "b" }?.serverMuted, true)
        XCTAssertEqual(applied?.first { $0.peerId == "b" }?.muted, true)
        XCTAssertEqual(applied?.first { $0.peerId == "a" }?.serverMuted, false)
    }

    func testAScreenShareAndACameraStreamIdSurviveTheDeltaPath() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a")], voiceChannelId: room, seq: 1)

        let sharing = tracker.apply(
            deltaFor: room, seq: 2, size: 1,
            updated: [peer("a", sharingScreen: true, cameraStreamId: "cam-1")]
        )
        XCTAssertEqual(sharing?.first?.sharingScreen, true)
        XCTAssertEqual(sharing?.first?.cameraStreamId, "cam-1")

        // And the end of a share, which only the roster can say: the screen is
        // the one stream defined negatively, so it announces no id to go nil.
        let stopped = tracker.apply(
            deltaFor: room, seq: 3, size: 1,
            updated: [peer("a", sharingScreen: false, cameraStreamId: nil)]
        )
        XCTAssertEqual(stopped?.first?.sharingScreen, false)
        XCTAssertNil(stopped?.first?.cameraStreamId)
    }

    func testASpeakRevokeArrivingAsAnUpdateReachesThePeerItNames() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: [peer("a"), peer("b")], voiceChannelId: room, seq: 1)

        let applied = tracker.apply(
            deltaFor: room, seq: 2, size: 2,
            updated: [peer("b", canSpeak: false)]
        )

        XCTAssertEqual(applied?.first { $0.peerId == "b" }?.canSpeak, false)
        XCTAssertEqual(applied?.first { $0.peerId == "a" }?.canSpeak, true)
    }

    /// The room the 2026-09-05 incident was actually about.
    func testAHundredAndThirtyPeopleConvergeThroughDeltasAlone() {
        var tracker = VoiceRosterTracker()
        tracker.apply(snapshot: (1...130).map { peer("p\($0)") }, voiceChannelId: room, seq: 100)

        var seq = 100
        var size = 130
        for index in 0..<30 {
            seq += 1
            size += 1
            _ = tracker.apply(deltaFor: room, seq: seq, size: size, joined: [peer("late\(index)")])
        }
        for index in 1...10 {
            seq += 1
            size -= 1
            _ = tracker.apply(deltaFor: room, seq: seq, size: size, left: ["p\(index)"])
        }
        let applied = tracker.apply(
            deltaFor: room, seq: seq + 1, size: size,
            updated: [peer("p50", muted: true)]
        )

        XCTAssertEqual(applied?.count, 150)
        XCTAssertEqual(applied?.first { $0.peerId == "p50" }?.muted, true)
        XCTAssertNil(applied?.first { $0.peerId == "p1" })
        XCTAssertTrue(applied?.contains { $0.peerId == "p11" } ?? false)
        XCTAssertTrue(applied?.contains { $0.peerId == "late29" } ?? false)
    }

    // MARK: - Through the socket

    /// Feeds frames into one client in order and collects what it yields.
    ///
    /// Deliberately not `WireDecodingTests.firstEvent`, which builds a fresh
    /// client per frame: the whole point here is that state carries from one
    /// frame to the next.
    private actor Collected {
        private(set) var events: [RealtimeEvent] = []
        func append(_ event: RealtimeEvent) { events.append(event) }
    }

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
        // Everything here is in-process and synchronous on the far side of one
        // actor hop, so this is a settle rather than a race: a refused delta
        // yields nothing at all, and the only way to assert "nothing" is to
        // give it a moment and count.
        try? await Task.sleep(for: .milliseconds(200))
        pump.cancel()
        return await collected.events
    }

    private func rosterFrame(seq: Int, peerIds: [String]) -> String {
        let participants = peerIds.map { id in
            """
            {"peerId":"\(id)","userId":"\(Self.uuid(for: id))","displayName":"\(id)",
             "avatarUrl":null,"sharingScreen":false,"muted":false,"deafened":false,
             "serverMuted":false,"canSpeak":true}
            """
        }.joined(separator: ",")
        return """
        {"type":"voice-roster","voiceChannelId":"\(room)","transport":"mesh",
         "seq":\(seq),"participants":[\(participants)]}
        """
    }

    private func deltaFrame(
        seq: Int,
        size: Int,
        joined: [String] = [],
        updatedMuted: [String] = [],
        left: [String] = []
    ) -> String {
        func entries(_ ids: [String], muted: Bool) -> String {
            ids.map { id in
                """
                {"peerId":"\(id)","userId":"\(Self.uuid(for: id))","displayName":"\(id)",
                 "avatarUrl":null,"sharingScreen":false,"muted":\(muted),"deafened":false,
                 "serverMuted":\(muted),"canSpeak":true}
                """
            }.joined(separator: ",")
        }
        return """
        {"type":"voice-roster-delta","voiceChannelId":"\(room)","transport":"mesh",
         "seq":\(seq),"size":\(size),
         "joined":[\(entries(joined, muted: false))],
         "updated":[\(entries(updatedMuted, muted: true))],
         "left":[\(left.map { "\"\($0)\"" }.joined(separator: ","))]}
        """
    }

    /// THE WHOLE PATH. A snapshot, then a delta, and the socket yields one
    /// `voiceRoster` for each carrying the whole room, which is the only shape
    /// `VoiceModel` and `CallModel` know how to read.
    func testTheSocketTurnsADeltaBackIntoAWholeRoster() async {
        let collected = await events(from: [
            rosterFrame(seq: 4, peerIds: ["a", "b"]),
            deltaFrame(seq: 5, size: 3, joined: ["c"], updatedMuted: ["b"])
        ])

        XCTAssertEqual(collected.count, 2)
        guard case .voiceRoster(let firstChannel, let first) = collected.first,
              case .voiceRoster(_, let second) = collected.last
        else {
            return XCTFail("Expected two voiceRoster events, got \(collected)")
        }
        XCTAssertEqual(firstChannel, room)
        XCTAssertEqual(first.map(\.peerId), ["a", "b"])
        XCTAssertEqual(second.map(\.peerId), ["a", "b", "c"])
        XCTAssertEqual(second.first { $0.peerId == "b" }?.serverMuted, true)
    }

    /// A departure carried only by a delta still leaves the room, which is the
    /// case a client that ignored `left` would show as somebody who never hung
    /// up.
    func testADepartureCarriedOnlyByADeltaLeavesTheRoom() async {
        let collected = await events(from: [
            rosterFrame(seq: 1, peerIds: ["a", "b", "c"]),
            deltaFrame(seq: 2, size: 2, left: ["b"])
        ])

        guard case .voiceRoster(_, let after) = collected.last else {
            return XCTFail("Expected a voiceRoster, got \(collected)")
        }
        XCTAssertEqual(after.map(\.peerId), ["a", "c"])
    }

    /// A GAP YIELDS NOTHING. The models keep the room they had rather than
    /// being handed one built on a baseline that is missing a frame.
    func testAGapYieldsNoEventAtAll() async {
        let collected = await events(from: [
            rosterFrame(seq: 1, peerIds: ["a"]),
            deltaFrame(seq: 3, size: 2, joined: ["b"])
        ])

        XCTAssertEqual(collected.count, 1)
        guard case .voiceRoster(_, let only) = collected.first else {
            return XCTFail("Expected the snapshot only, got \(collected)")
        }
        XCTAssertEqual(only.map(\.peerId), ["a"])
    }

    func testASizeMismatchYieldsNoEventAtAll() async {
        let collected = await events(from: [
            rosterFrame(seq: 1, peerIds: ["a"]),
            deltaFrame(seq: 2, size: 7, joined: ["b"])
        ])

        XCTAssertEqual(collected.count, 1)
    }

    /// And after a refused delta the next keyframe still lands, so the room
    /// repairs itself rather than staying stuck on the last good frame.
    func testAKeyframeAfterARefusedDeltaStillArrives() async {
        let collected = await events(from: [
            rosterFrame(seq: 1, peerIds: ["a"]),
            deltaFrame(seq: 9, size: 2, joined: ["b"]),
            rosterFrame(seq: 10, peerIds: ["a", "b", "c"])
        ])

        XCTAssertEqual(collected.count, 2)
        guard case .voiceRoster(_, let repaired) = collected.last else {
            return XCTFail("Expected the keyframe, got \(collected)")
        }
        XCTAssertEqual(repaired.map(\.peerId), ["a", "b", "c"])
    }

    // MARK: - The capability itself

    /**
     THE STRING THIS BUILD ASKS FOR, against the two places that answer.

     `voice-roster-delta` is opt-in per socket: the server sends whole rosters
     to anything that does not declare it, so getting the string wrong, or
     dropping the array from the handshake, produces no error anywhere. The app
     carries on working and the phone quietly keeps paying for ~99 kB frames it
     does not need. That is the shape of CLAUDE.md pitfall 9, where Cloudflare
     TURN was configured, deployed and never once used, so the only defence is
     to pin it rather than trust it.
     */
    func testTheCapabilityMatchesTheServerAndTheWebClient() throws {
        let cap = "voice-roster-delta"
        // EXACT, and deliberately not `contains`. This list is the whole of
        // what this build promises the server, and the promise runs in the
        // dangerous direction for `voice-transport-changed`: declaring it
        // stops the server releasing this seat when a room is promoted, so an
        // entry added here without its handler leaves somebody seated in a
        // call whose media has moved without them. A `contains` would let the
        // list grow silently, which is exactly the drift this asserts against.
        // The promotion capability's own contract is in `VoicePromotionTests`.
        XCTAssertEqual(RealtimeClient.wireCaps, [cap, "voice-transport-changed", "presence-delta"])
        XCTAssertEqual(
            RealtimeClient.authFrame(token: "t")["caps"] as? [String],
            [cap, "voice-transport-changed", "presence-delta"],
            "The handshake must declare exactly RealtimeClient.wireCaps. A correct list "
                + "that never reaches the socket is the same outcome as no capability at "
                + "all, and neither the app nor the server would say a word about it."
        )
        XCTAssertEqual(RealtimeClient.authFrame(token: "t")["type"] as? String, "auth")
        XCTAssertEqual(RealtimeClient.authFrame(token: "t")["token"] as? String, "t")

        // And that the socket sends it. Read off the source, because
        // `openSocket` opens a real connection and there is no seam short of
        // one that would show what the first frame was.
        let clientSource = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()   // …/ios/pqp/Tests
                .deletingLastPathComponent()   // …/ios/pqp
                .appending(path: "Sources/Core/RealtimeClient.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(
            clientSource.contains("send(raw: RealtimeClient.authFrame(token:"),
            "openSocket no longer sends `authFrame`, so whatever it does send is not "
                + "declaring this build's capabilities and every socket silently falls "
                + "back to whole rosters."
        )

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
                "\(path) no longer names \"\(cap)\". The server matches this string exactly, "
                    + "so a rename there makes every iOS socket fall back to whole rosters "
                    + "with nothing anywhere going red."
            )
        }

        let wsIndex = try String(
            contentsOf: repoRoot.appending(path: "server/src/ws/index.ts"), encoding: .utf8
        )
        XCTAssertTrue(
            wsIndex.contains("caps"),
            "server/src/ws/index.ts no longer reads `caps` off the auth frame, so nothing "
                + "this handshake declares is heard at all."
        )
    }
}
