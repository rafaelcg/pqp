import XCTest
@testable import pqp

/**
 `WatchPartyPartyTracker`, the versioned state `WatchPartyHostController`
 hands its party knowledge through -- pulled out as a plain value type
 specifically so the three Farol findings on the controller's first cut are
 provable without a real `SessionStore`/`RealtimeClient`:

 1. Unknown until something actually resolves it (a failed initial fetch
    used to be indistinguishable from "no party running").
 2. A slow fetch must not overwrite something fresher that landed while it
    was in flight (a realtime frame, or another fetch).
 3. The direct response to a mutation this phone just made (create, go-live,
    Encerrar) must be applied immediately, not discarded to a `Bool`.

 Also a source check for the fourth, unrelated finding: `WatchPartyHostController`
 uses `@Observable` and must import `Observation` for the macro to resolve,
 even though this build's own CI already proves it compiles without a
 module-boundary issue today -- Farol flagged it as the kind of thing that
 stops being true the moment Swift's implicit re-export rules change.
 */
final class WatchPartyHostControllerTests: XCTestCase {
    private func party(id: String = "p1", state: String = "live") -> WatchPartyPayload {
        WatchPartyPayload(
            id: id, channelId: "c1", name: "Sessão", state: state,
            hostUserId: "u1", hostDisplayName: "Rafael", viewerRole: "host"
        )
    }

    // MARK: - Unknown until resolved

    func testAFreshTrackerIsUnknown() {
        let tracker = WatchPartyPartyTracker()
        XCTAssertEqual(tracker.knowledge, .unknown)
    }

    func testBeginningAFetchAloneDoesNotResolveIt() {
        var tracker = WatchPartyPartyTracker()
        _ = tracker.beginFetch()
        XCTAssertEqual(tracker.knowledge, .unknown, "starting a fetch is not the same as it answering")
    }

    // MARK: - A fetch result versus something fresher

    func testAFetchResultAppliesWhenNothingFresherArrivedWhileItWasInFlight() {
        var tracker = WatchPartyPartyTracker()
        let requested = tracker.beginFetch()
        let applied = tracker.applyFetchResult(party(), requestedGeneration: requested)
        XCTAssertTrue(applied)
        XCTAssertEqual(tracker.knowledge, .known(party()))
    }

    /**
     THE CORE RACE THIS TYPE EXISTS TO CLOSE. A fetch starts, then a
     `watch-party-update` frame (or a mutation response) lands and is
     applied, then the SLOW fetch's result finally arrives -- it must not
     overwrite the fresher answer.
     */
    func testAFetchResultIsDiscardedWhenAnAuthoritativeUpdateArrivedFirst() {
        var tracker = WatchPartyPartyTracker()
        let requested = tracker.beginFetch()
        tracker.applyAuthoritative(party(state: "ended"))
        let applied = tracker.applyFetchResult(party(state: "live"), requestedGeneration: requested)
        XCTAssertFalse(applied)
        XCTAssertEqual(
            tracker.knowledge, .known(party(state: "ended")),
            "the frame's answer must survive the stale fetch landing after it"
        )
    }

    /// The mirror case: a SECOND, newer fetch supersedes a first one still
    /// in flight, the same way an authoritative update does.
    func testAnOlderFetchIsDiscardedOnceANewerFetchHasStarted() {
        var tracker = WatchPartyPartyTracker()
        let firstRequested = tracker.beginFetch()
        let secondRequested = tracker.beginFetch()
        XCTAssertNotEqual(firstRequested, secondRequested)
        let firstApplied = tracker.applyFetchResult(party(state: "ended"), requestedGeneration: firstRequested)
        XCTAssertFalse(firstApplied)
        XCTAssertEqual(tracker.knowledge, .unknown, "neither fetch has answered from the second's point of view yet")
        let secondApplied = tracker.applyFetchResult(party(state: "live"), requestedGeneration: secondRequested)
        XCTAssertTrue(secondApplied)
        XCTAssertEqual(tracker.knowledge, .known(party(state: "live")))
    }

    // MARK: - Authoritative updates always win

    func testAnAuthoritativeUpdateAlwaysApplies() {
        var tracker = WatchPartyPartyTracker()
        tracker.applyAuthoritative(party())
        XCTAssertEqual(tracker.knowledge, .known(party()))
        tracker.applyAuthoritative(nil)
        XCTAssertEqual(tracker.knowledge, .known(nil))
    }

    /// Farol finding #4's shape, at the tracker level: the direct response
    /// to a mutation this phone just made goes through `applyAuthoritative`
    /// exactly like a realtime frame does, so it is never discarded to a
    /// `Bool` and lost if the matching `watch-party-update` is missed.
    func testAnAuthoritativeUpdateResolvesAnUnknownTrackerImmediately() {
        var tracker = WatchPartyPartyTracker()
        XCTAssertEqual(tracker.knowledge, .unknown)
        tracker.applyAuthoritative(party(state: "live"))
        XCTAssertEqual(tracker.knowledge, .known(party(state: "live")))
    }

    // MARK: - reset() bumps rather than zeroes the generation

    func testResetForgetsTheParty() {
        var tracker = WatchPartyPartyTracker()
        tracker.applyAuthoritative(party())
        tracker.reset()
        XCTAssertEqual(tracker.knowledge, .unknown)
    }

    /**
     THE SECOND-ROUND FAROL FINDING. Two visits to the same channel handing
     out the SAME generation numbers is what let a fetch from the first
     visit -- still in flight when the phone came back -- be mistaken for
     the second visit's own fetch. `reset()` bumping `generation` rather
     than zeroing it (the first cut's bug: replacing the whole tracker with
     `WatchPartyPartyTracker()`) is what closes that: every number this
     tracker ever hands out is unique for its whole lifetime, so a stale
     fetch's captured version can never coincide with a legitimate one
     from a later epoch.
     */
    func testAFetchFromBeforeAResetCannotBeMistakenForOneAfterIt() {
        var tracker = WatchPartyPartyTracker()
        // Visit 1: a fetch begins for this channel.
        let firstVisitFetch = tracker.beginFetch()
        // The phone leaves, then returns to the SAME channel: `open` resets.
        tracker.reset()
        // Visit 2: a fresh fetch begins and answers immediately.
        let secondVisitFetch = tracker.beginFetch()
        XCTAssertNotEqual(
            firstVisitFetch, secondVisitFetch,
            "two visits must never hand out the same generation number"
        )
        tracker.applyFetchResult(party(state: "live"), requestedGeneration: secondVisitFetch)
        XCTAssertEqual(tracker.knowledge, .known(party(state: "live")))
        // The FIRST visit's fetch, delayed this whole time, finally answers
        // with whatever it saw back then -- it must not overwrite visit 2's
        // already-applied, correct answer.
        let stillApplied = tracker.applyFetchResult(party(state: "ended"), requestedGeneration: firstVisitFetch)
        XCTAssertFalse(stillApplied)
        XCTAssertEqual(tracker.knowledge, .known(party(state: "live")))
    }

    func testResetAdvancesGenerationEvenWithNoFetchInFlight() {
        var tracker = WatchPartyPartyTracker()
        let before = tracker.beginFetch()
        tracker.reset()
        let after = tracker.beginFetch()
        XCTAssertNotEqual(before, after)
    }

    // MARK: - WatchPartyFetchBackoff gives up eventually

    func testBackoffDoublesUpToItsCeiling() {
        var backoff = WatchPartyFetchBackoff()
        let delays = (0..<WatchPartyFetchBackoff.maxAttempts).compactMap { _ in backoff.next() }
        XCTAssertEqual(delays.count, WatchPartyFetchBackoff.maxAttempts)
        XCTAssertEqual(delays.first, .milliseconds(1_000))
        XCTAssertEqual(delays.last, .milliseconds(30_000))
        // Strictly non-decreasing, capped at 30s.
        for delay in delays {
            XCTAssertLessThanOrEqual(delay, .milliseconds(30_000))
        }
    }

    /// Farol finding: an unbounded retry keeps generating traffic for a
    /// channel nobody is looking at any more (there is no explicit
    /// `close()`). `next()` must eventually say so rather than retry forever.
    func testBackoffGivesUpAfterMaxAttempts() {
        var backoff = WatchPartyFetchBackoff()
        for _ in 0..<WatchPartyFetchBackoff.maxAttempts {
            XCTAssertNotNil(backoff.next())
        }
        XCTAssertNil(backoff.next(), "must give up once maxAttempts is reached")
    }

    // MARK: - Farol finding #1: the macro's own module

    func testControllerImportsObservationForTheObservableMacro() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Sources/Voice/WatchPartyHostController.swift")
        let source = try String(contentsOf: path, encoding: .utf8)
        XCTAssertTrue(
            source.contains("import Observation"),
            "@Observable is declared in the Observation module; this file must import it directly"
        )
    }
}
