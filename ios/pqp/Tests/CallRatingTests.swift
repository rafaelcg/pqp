import XCTest
@testable import pqp

/// The rules that decide whether somebody gets interrupted after a call.
///
/// The twin of `client/src/lib/call-rating.test.ts`, and the reason the logic is
/// a value type at all: `VoiceModel` and `CallModel` both open a microphone, so
/// neither can be built here.
final class CallRatingTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)
    private let neverAsked = Date(timeIntervalSince1970: 0)

    private func trackerAfter(
        seconds: TimeInterval,
        peers: Int = 1,
        screenSharing: Bool = false,
        channelId: String? = "8f1f0f4e-0000-4000-8000-000000000001"
    ) -> (CallRatingTracker, Date) {
        var tracker = CallRatingTracker()
        tracker.observe(
            CallSnapshot(
                peerCount: peers, screenSharing: screenSharing, channelId: channelId
            ),
            now: start
        )
        return (tracker, start.addingTimeInterval(seconds))
    }

    // MARK: - The three gates

    func testACallOverAMinuteWithSomebodyInItIsWorthAsking() {
        var (tracker, end) = trackerAfter(seconds: 90)
        let call = tracker.finish(now: end, lastAskedAt: neverAsked)
        XCTAssertEqual(call?.durationSeconds, 90)
        XCTAssertEqual(call?.peerCount, 1)
        XCTAssertEqual(call?.transport, .mesh)
        XCTAssertEqual(call?.hadScreenShare, false)
    }

    func testAShortCallIsNotWorthAsking() {
        var (tracker, end) = trackerAfter(seconds: 59)
        XCTAssertNil(
            tracker.finish(now: end, lastAskedAt: neverAsked),
            "Under a minute the person is rating whether they meant to tap"
        )
    }

    func testExactlyTheMinimumCounts() {
        var (tracker, end) = trackerAfter(seconds: 60)
        XCTAssertNotNil(tracker.finish(now: end, lastAskedAt: neverAsked))
    }

    func testACallOfOneHasNoQuality() {
        var (tracker, end) = trackerAfter(seconds: 600, peers: 0)
        XCTAssertNil(tracker.finish(now: end, lastAskedAt: neverAsked))
    }

    func testAskedRecentlyStaysQuiet() {
        var (tracker, end) = trackerAfter(seconds: 300)
        let anHourAgo = end.addingTimeInterval(-3600)
        XCTAssertNil(tracker.finish(now: end, lastAskedAt: anHourAgo))
    }

    func testAskedLongerAgoThanTheCooldownAsksAgain() {
        var (tracker, end) = trackerAfter(seconds: 300)
        let stale = end.addingTimeInterval(-(CallRating.cooldown + 1))
        XCTAssertNotNil(tracker.finish(now: end, lastAskedAt: stale))
    }

    // MARK: - What is remembered

    func testPeersAreAHighWaterMarkBecausePeopleLeaveFirst() {
        var tracker = CallRatingTracker()
        tracker.observe(CallSnapshot(peerCount: 1), now: start)
        tracker.observe(CallSnapshot(peerCount: 4), now: start.addingTimeInterval(30))
        // Everybody drifts off before the last person hangs up.
        tracker.observe(CallSnapshot(peerCount: 0), now: start.addingTimeInterval(200))

        let call = tracker.finish(
            now: start.addingTimeInterval(240), lastAskedAt: neverAsked
        )
        XCTAssertEqual(
            call?.peerCount, 4,
            "Describing a call of five as a call of one misreports the thing being rated"
        )
    }

    func testTheScreenShareFlagIsStickyForTheSameReason() {
        var tracker = CallRatingTracker()
        tracker.observe(CallSnapshot(peerCount: 1, screenSharing: false), now: start)
        tracker.observe(
            CallSnapshot(peerCount: 1, screenSharing: true),
            now: start.addingTimeInterval(20)
        )
        tracker.observe(
            CallSnapshot(peerCount: 1, screenSharing: false),
            now: start.addingTimeInterval(100)
        )

        let call = tracker.finish(
            now: start.addingTimeInterval(120), lastAskedAt: neverAsked
        )
        XCTAssertEqual(call?.hadScreenShare, true)
    }

    func testTheChannelIsTakenFromTheJoinAndNotFromTheEnd() {
        var tracker = CallRatingTracker()
        tracker.observe(CallSnapshot(peerCount: 1, channelId: "room-a"), now: start)
        // `clearCallState` empties the id before the phase moves, so an
        // implementation that re-read it at the end would record nothing.
        tracker.observe(
            CallSnapshot(peerCount: 1, channelId: nil),
            now: start.addingTimeInterval(90)
        )

        let call = tracker.finish(
            now: start.addingTimeInterval(95), lastAskedAt: neverAsked
        )
        XCTAssertEqual(call?.channelId, "room-a")
    }

    func testTransportIsRereadBecauseARoomCanBePromotedMidCall() {
        var tracker = CallRatingTracker()
        tracker.observe(CallSnapshot(peerCount: 1, usingSfu: false), now: start)
        tracker.observe(
            CallSnapshot(peerCount: 1, usingSfu: true),
            now: start.addingTimeInterval(80)
        )

        let call = tracker.finish(
            now: start.addingTimeInterval(90), lastAskedAt: neverAsked
        )
        XCTAssertEqual(call?.transport, .livekit)
    }

    func testDurationIsRoundedTheWayTheWebRoundsIt() {
        var (tracker, end) = trackerAfter(seconds: 90.6)
        XCTAssertEqual(tracker.finish(now: end, lastAskedAt: neverAsked)?.durationSeconds, 91)
    }

    // MARK: - Ending twice

    func testAFinishedCallCannotBeAskedAboutTwice() {
        var (tracker, end) = trackerAfter(seconds: 300)
        XCTAssertNotNil(tracker.finish(now: end, lastAskedAt: neverAsked))
        XCTAssertNil(
            tracker.finish(now: end, lastAskedAt: neverAsked),
            "Both models end a call through more than one path; a second one must be silent"
        )
    }

    func testFinishingWithoutACallIsSilent() {
        var tracker = CallRatingTracker()
        XCTAssertNil(tracker.finish(now: start, lastAskedAt: neverAsked))
    }

    // MARK: - The model around it

    @MainActor
    func testTheCooldownIsWrittenWhenTheQuestionIsAskedNotWhenItIsAnswered() {
        let clock = SpyClock()
        let model = CallRatingModel(clock: clock)
        var (tracker, end) = trackerAfter(seconds: 300)

        model.finish(&tracker, now: end)

        XCTAssertNotNil(model.pending)
        XCTAssertEqual(
            clock.asked, end,
            "Writing it on answer punishes the people who dismiss it, by asking again"
        )
    }

    @MainActor
    func testACallThatFailsTheGatesNeitherAsksNorBurnsTheCooldown() {
        let clock = SpyClock()
        let model = CallRatingModel(clock: clock)
        var (tracker, end) = trackerAfter(seconds: 10)

        model.finish(&tracker, now: end)

        XCTAssertNil(model.pending)
        XCTAssertNil(clock.asked)
    }

    @MainActor
    func testDismissingClearsIt() {
        let model = CallRatingModel(clock: SpyClock())
        var (tracker, end) = trackerAfter(seconds: 300)
        model.finish(&tracker, now: end)
        model.dismiss()
        XCTAssertNil(model.pending)
    }

    @MainActor
    func testTheStoredStampSurvivesARoundTripThroughDefaults() {
        // The real clock, on a throwaway suite: a stamp that does not read back
        // as it was written is a cooldown that never applies.
        let name = "pqp.tests.callRating.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { UserDefaults.standard.removePersistentDomain(forName: name) }

        let clock = DefaultsCallRatingClock(defaults: defaults)
        XCTAssertEqual(
            clock.lastAsked(), Date(timeIntervalSince1970: 0),
            "Never asked has to read as long ago, or nobody is ever asked"
        )
        clock.recordAsked(start)
        XCTAssertEqual(clock.lastAsked().timeIntervalSince1970, start.timeIntervalSince1970)
    }

    /// Records rather than persists, so the cooldown can be asserted on without
    /// depending on the simulator's `UserDefaults` surviving between tests.
    private final class SpyClock: CallRatingClock, @unchecked Sendable {
        var stored = Date(timeIntervalSince1970: 0)
        var asked: Date?

        func lastAsked() -> Date { stored }

        func recordAsked(_ now: Date) {
            asked = now
            stored = now
        }
    }
}
