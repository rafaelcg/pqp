import XCTest
@testable import pqp

/**
 THE VIEWER LIST, REBUILT FROM WHAT CHANGED IN IT.

 `presence-delta` is the second half of the same trade the voice roster delta
 made: the server fans a channel's whole viewer list to everybody in it every
 time one person opens or closes it, and a phone on mobile data pays for all of
 it. A socket that declares the capability is sent only what changed.

 Bytes, not pixels. Unlike `voice-transport-changed`, mishandling this cannot
 break a call: the worst case is a viewer list that is briefly stale, and the
 server's next whole list repairs it. That is why it can be declared at all
 while the promotion capability had to be earned.

 What it CAN do is silently do nothing, which is the failure this file is
 mostly about. Two ways for that to happen here, and both have a test:

 - the frame never decodes, because `Envelope.joined` already means something
   else (`testAPresenceDeltaSurvivesTheEnvelopeKeyItCollidesWith`);
 - the sequence rule is wrong, so every delta is refused and the socket quietly
   falls back to waiting for whole lists.
 */
final class PresenceDeltaTests: XCTestCase {

    private let channel = "22222222-2222-2222-2222-222222222222"
    private let otherChannel = "33333333-3333-3333-3333-333333333333"

    // MARK: - The rule

    func testADeltaAddsAndRemovesInOneFrame() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a"), user("b")], channelId: channel, seq: 4)

        let applied = tracker.apply(
            deltaFor: channel, seq: 5, size: 2, joined: [user("c")], left: [id("a")]
        )

        XCTAssertEqual(applied?.map(\.id), [id("b"), id("c")])
        XCTAssertEqual(tracker.sequence(for: channel), 5)
    }

    /// There is no `updated` verb on this frame: the server folds a rename or a
    /// new avatar into `joined`, because the receiver's operation for both is
    /// the same replace-by-id. A replaced person keeps their place, so the list
    /// does not reshuffle every time somebody changes their picture.
    func testARenameArrivesAsAJoinAndKeepsItsPlace() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a"), user("b"), user("c")], channelId: channel, seq: 1)

        let applied = tracker.apply(
            deltaFor: channel, seq: 2, size: 3, joined: [user("a", name: "Rafa")]
        )

        XCTAssertEqual(applied?.map(\.id), [id("a"), id("b"), id("c")])
        XCTAssertEqual(applied?.first?.name, "Rafa")
    }

    /// THE GAP. A frame that is not the next one must change nothing at all,
    /// not even the sequence: advancing past it would turn one missed frame
    /// into a permanently wrong list, because every later delta would then
    /// look like the next in line over a baseline missing what was skipped.
    func testAGapIsRefusedAndLeavesTheSequenceWhereItWas() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a")], channelId: channel, seq: 1)

        XCTAssertNil(tracker.apply(deltaFor: channel, seq: 4, size: 2, joined: [user("b")]))
        XCTAssertEqual(tracker.sequence(for: channel), 1)
        // And the next in line is still accepted, so one lost frame costs a
        // bounded interval of staleness rather than the rest of the session.
        XCTAssertEqual(
            tracker.apply(deltaFor: channel, seq: 2, size: 2, joined: [user("b")])?.count,
            2
        )
    }

    /// THE SECOND CHECK, and the one `seq` cannot make. A client that applied
    /// every frame and still disagrees about the count has diverged for some
    /// other reason and is equally out of sync, so it stops patching.
    func testASizeTheServerDisagreesWithIsRefused() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a")], channelId: channel, seq: 1)

        XCTAssertNil(tracker.apply(deltaFor: channel, seq: 2, size: 9, joined: [user("b")]))
        XCTAssertEqual(tracker.sequence(for: channel), 1)
    }

    /// Every entry is an absolute statement about one person, which is what
    /// makes a delta overlapping a snapshot harmless. If it were relative this
    /// would double count and the size check would fail.
    func testRestatingSomebodyTheSnapshotAlreadyCarriedChangesNothing() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a"), user("b")], channelId: channel, seq: 7)

        XCTAssertEqual(
            tracker.apply(deltaFor: channel, seq: 8, size: 2, joined: [user("b")])?.map(\.id),
            [id("a"), id("b")]
        )
    }

    /// An emptied channel is forgotten on both sides, so the next visitor's
    /// first delta starts again at 1 and is self-sufficient. A client that kept
    /// the old number would read it as a gap and sit out the whole next visit.
    func testAnEmptiedChannelIsForgottenSoTheNextSequenceStartsAgain() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a")], channelId: channel, seq: 5)

        XCTAssertEqual(tracker.apply(deltaFor: channel, seq: 6, size: 0, left: [id("a")])?.count, 0)
        XCTAssertEqual(tracker.sequence(for: channel), 0)
        XCTAssertEqual(tracker.trackedChannelCount, 0)
        XCTAssertEqual(
            tracker.apply(deltaFor: channel, seq: 1, size: 1, joined: [user("z")])?.map(\.id),
            [id("z")]
        )
    }

    /// A new socket may be talking to a server process that restarted its
    /// numbering. Holding a number the server no longer shares is worse than
    /// stale: it can line up by accident and patch a channel that has moved on.
    func testReopeningTheSocketDropsEveryBaseline() {
        var tracker = PresenceTracker()
        tracker.apply(snapshot: [user("a")], channelId: channel, seq: 5)
        tracker.apply(snapshot: [user("b")], channelId: otherChannel, seq: 2)

        tracker.forgetAll()

        XCTAssertEqual(tracker.trackedChannelCount, 0)
        XCTAssertEqual(tracker.sequence(for: channel), 0)
    }

    // MARK: - Through the real decoder

    /**
     THE KEY COLLISION, which is the whole reason `presence-delta` gets its own
     `Decodable` rather than riding the shared `Envelope`.

     `Envelope.joined` is `[VoiceParticipant]?`, because the voice roster delta
     used the name first. A `PresenceUser` has none of the fields a
     `VoiceParticipant` requires, so decoding this frame through `Envelope`
     throws, `try?` swallows it, and every presence delta is dropped in
     silence. The app keeps working (whole lists still arrive on a socket the
     server thinks negotiated deltas... except it does not, because the server
     stopped sending them), and nothing anywhere goes red.

     Two assertions on purpose: that a delta produces the list, and that it
     produces the SAME list a snapshot would, since the models cannot tell the
     two frames apart and must not behave differently depending on which one
     the server happened to send.
     */
    func testAPresenceDeltaSurvivesTheEnvelopeKeyItCollidesWith() async {
        let events = await events(from: [
            snapshotFrame(seq: 1, ids: ["a", "b"]),
            deltaFrame(seq: 2, size: 3, joined: ["c"])
        ])

        XCTAssertEqual(events.count, 2)
        guard case .presence(let channelId, let users) = events.last else {
            return XCTFail("Expected a presence list, got \(events)")
        }
        XCTAssertEqual(channelId, channel)
        XCTAssertEqual(users.map(\.id), [id("a"), id("b"), id("c")])
        XCTAssertEqual(users.map(\.name), ["a", "b", "c"])
    }

    /// A refused delta yields nothing at all rather than a wrong list, and the
    /// whole list that follows repairs the channel wholesale.
    func testARefusedDeltaYieldsNothingAndTheNextWholeListRepairsIt() async {
        let events = await events(from: [
            snapshotFrame(seq: 1, ids: ["a"]),
            deltaFrame(seq: 9, size: 2, joined: ["b"]),
            snapshotFrame(seq: 10, ids: ["a", "b", "c"])
        ])

        XCTAssertEqual(events.count, 2, "The gap must yield nothing, got \(events)")
        guard case .presence(_, let repaired) = events.last else {
            return XCTFail("Expected the whole list, got \(events)")
        }
        XCTAssertEqual(repaired.map(\.id), [id("a"), id("b"), id("c")])
    }

    // MARK: - Fixtures

    private func user(_ name: String, name renamed: String? = nil) -> PresenceUser {
        let json = """
        {"id":"\(id(name))","name":"\(renamed ?? name)","avatarUrl":null}
        """
        // Decoded rather than constructed, so the fixture goes through the very
        // decoder the wire uses.
        // swiftlint:disable:next force_try
        return try! Coding.decoder.decode(PresenceUser.self, from: Data(json.utf8))
    }

    private func id(_ name: String) -> String {
        let seed = abs(name.hashValue) % 1_000_000
        return String(format: "00000000-0000-0000-0000-%012d", seed)
    }

    private func snapshotFrame(seq: Int, ids: [String]) -> String {
        let users = ids.map { """
            {"id":"\(id($0))","name":"\($0)","avatarUrl":null}
            """ }.joined(separator: ",")
        return """
        {"type":"presence-update","channelId":"\(channel)","seq":\(seq),"users":[\(users)]}
        """
    }

    private func deltaFrame(seq: Int, size: Int, joined: [String] = [], left: [String] = []) -> String {
        let arrived = joined.map { """
            {"id":"\(id($0))","name":"\($0)","avatarUrl":null}
            """ }.joined(separator: ",")
        let departed = left.map { "\"\(id($0))\"" }.joined(separator: ",")
        return """
        {"type":"presence-delta","channelId":"\(channel)","seq":\(seq),"size":\(size),
         "joined":[\(arrived)],"left":[\(departed)]}
        """
    }

    private actor Collected {
        var events: [RealtimeEvent] = []
        func append(_ event: RealtimeEvent) { events.append(event) }
    }

    /// Frames in, events out, through the decoder the socket actually uses.
    /// Settled rather than raced: a refused delta yields nothing, and the only
    /// way to assert "nothing" is to give it a moment and count.
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
