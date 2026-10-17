import XCTest
@testable import pqp

/// The forum-wide pinned set behind "Fixar post (N de 3)" and the pin cap
/// (Farol on #1322: stale after remote changes, a recount on every upsert, a
/// superseded count authorising a pin).
final class ForumPinnedTrackerTests: XCTestCase {
    private func loaded(_ ids: [String]) -> ForumPinnedTracker {
        var tracker = ForumPinnedTracker()
        let generation = tracker.beginRead(quiet: false)
        _ = tracker.finishRead(ids, generation: generation)
        return tracker
    }

    func testUnknownUntilRead() {
        XCTAssertNil(ForumPinnedTracker().count)
    }

    func testAReadSetsTheCountAndReturnsAReading() {
        var tracker = ForumPinnedTracker()
        let generation = tracker.beginRead(quiet: false)
        let reading = tracker.finishRead(["a", "b"], generation: generation)
        XCTAssertEqual(reading?.count, 2)
        XCTAssertEqual(tracker.count, 2)
    }

    func testARemoteUnpinOfAPostTheFilterHidesLowersTheCount() {
        // "rules" is hidden by the filter: it is in no list, only in the set.
        var tracker = loaded(["rules", "faq"])
        XCTAssertTrue(tracker.observe(postId: "rules", isPinned: false))
        XCTAssertEqual(tracker.count, 1)
    }

    func testARemotePinOfAHiddenPostRaisesTheCount() {
        var tracker = loaded(["rules"])
        XCTAssertTrue(tracker.observe(postId: "new", isPinned: true))
        XCTAssertEqual(tracker.count, 2)
    }

    func testAnUpsertThatChangesNothingCostsNothing() {
        var tracker = loaded(["rules"])
        let before = tracker.generation
        XCTAssertFalse(tracker.observe(postId: "rules", isPinned: true))   // already pinned
        XCTAssertFalse(tracker.observe(postId: "other", isPinned: false))  // never pinned
        XCTAssertEqual(tracker.generation, before)
    }

    func testARemovedPinnedPostLeavesTheSet() {
        var tracker = loaded(["rules", "faq"])
        XCTAssertTrue(tracker.forget(postId: "faq"))
        XCTAssertEqual(tracker.count, 1)
        XCTAssertFalse(tracker.forget(postId: "faq"))
    }

    func testFramesAreIgnoredWhileTheSetIsUnknown() {
        var tracker = ForumPinnedTracker()
        XCTAssertFalse(tracker.observe(postId: "a", isPinned: true))
        XCTAssertNil(tracker.count)
    }

    func testASupersededReadNeverLandsAndIsNotAnAuthority() {
        var tracker = ForumPinnedTracker()
        let older = tracker.beginRead(quiet: false)
        let newer = tracker.beginRead(quiet: false)
        XCTAssertNotNil(tracker.finishRead(["a", "b", "c"], generation: newer))
        // The older read finishes afterwards, seeing room: it must not authorise anything.
        XCTAssertNil(tracker.finishRead(["a"], generation: older))
        XCTAssertEqual(tracker.count, 3)
    }

    func testAFailedReadIsNeverAnAuthority() {
        var tracker = ForumPinnedTracker()
        let generation = tracker.beginRead(quiet: false)
        XCTAssertNil(tracker.finishRead(nil, generation: generation))
        XCTAssertNil(tracker.count)
    }

    func testAQuietReadKeepsTheKnownCountWhileItRuns() {
        var tracker = loaded(["a", "b"])
        _ = tracker.beginRead(quiet: true)
        XCTAssertEqual(tracker.count, 2)
        _ = tracker.beginRead(quiet: false)
        XCTAssertNil(tracker.count)
    }

    func testAReadingGoesStaleWhenAFrameMovesThePinsBeforeTheWrite() {
        var tracker = ForumPinnedTracker()
        let generation = tracker.beginRead(quiet: false)
        let reading = tracker.finishRead(["a", "b"], generation: generation)!
        XCTAssertTrue(tracker.isCurrent(reading))
        // Another moderator pins a third while this one's pin request is on its way.
        tracker.observe(postId: "c", isPinned: true)
        XCTAssertFalse(tracker.isCurrent(reading))
        XCTAssertEqual(ForumPinnedCount.gate(count: tracker.count, max: 3), .full)
    }
}
