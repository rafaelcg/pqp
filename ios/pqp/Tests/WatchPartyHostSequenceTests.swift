import XCTest
@testable import pqp

/**
 Ir ao vivo and Encerrar, as an ordered list of effects rather than a
 paragraph in a controller -- the "go-live/end sequencing" the hosting
 review's test plan asks for: state first, so a failed share never
 broadcasts silently, and Encerrar always leaves voice even when telling
 the server the party ended fails, or is cancelled mid-request.

 A direct port of `WatchPartyHostSequenceTest.kt` from Android's hosting PR
 (#834), case for case, onto `performWatchPartyGoLive`/`performWatchPartyEnd`
 in `WatchPartyHostSequence.swift`. The one shape difference: no
 `startScreenShare` parameter (see that file's doc for why iOS has nothing
 to call there).
 */
final class WatchPartyHostSequenceTests: XCTestCase {
    private struct Failure: Error {}
    private struct Cancelled: Error {}

    // MARK: - go-live: the happy path

    func testGoLiveSetsStateThenJoinsTheRoomInThatOrder() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let result = try await performWatchPartyGoLive(
            setLive: { await calls.add("setLive"); return true },
            checkLive: { XCTFail("must not re-check a setLive that did not throw"); return false },
            joinVoice: { await calls.add("joinVoice") },
            endParty: { XCTFail("must not end a party that was never joined-and-failed"); return false }
        )
        XCTAssertEqual(result, .live)
        let log = await calls.log
        XCTAssertEqual(log, ["setLive", "joinVoice"])
    }

    func testACleanRefusalJoinsNothingAndIsNeverRechecked() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let result = try await performWatchPartyGoLive(
            setLive: { await calls.add("setLive"); return false },
            checkLive: { XCTFail("a clean false is unambiguous, checkLive must not run"); return false },
            joinVoice: { await calls.add("joinVoice") },
            endParty: { XCTFail("nothing to end, the party never went live"); return false }
        )
        XCTAssertEqual(result, .refused)
        let log = await calls.log
        XCTAssertEqual(log, ["setLive"])
    }

    // MARK: - an ambiguous setLive failure

    func testSetLiveThrowingIsRecheckedAndAConfirmedLivePartyStillGoesLive() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let result = try await performWatchPartyGoLive(
            setLive: { await calls.add("setLive"); throw Failure() },
            checkLive: { await calls.add("checkLive"); return true },
            joinVoice: { await calls.add("joinVoice") },
            endParty: { XCTFail("the party is live and was joined, nothing to end"); return false }
        )
        XCTAssertEqual(result, .live)
        let log = await calls.log
        XCTAssertEqual(log, ["setLive", "checkLive", "joinVoice"])
    }

    func testSetLiveThrowingRecheckedAndConfirmedNotLiveIsARefusal() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let result = try await performWatchPartyGoLive(
            setLive: { await calls.add("setLive"); throw Failure() },
            checkLive: { await calls.add("checkLive"); return false },
            joinVoice: { XCTFail("must not join a party the re-check says is not live") },
            endParty: { XCTFail("nothing to end, confirmed not live"); return false }
        )
        XCTAssertEqual(result, .refused)
        let log = await calls.log
        XCTAssertEqual(log, ["setLive", "checkLive"])
    }

    func testSetLiveThrowingAndTheRecheckItselfThrowingIsStillJustARefusal() async throws {
        let result = try await performWatchPartyGoLive(
            setLive: { throw Failure() },
            checkLive: { throw Failure() },
            joinVoice: { XCTFail("must not join") },
            endParty: { XCTFail("nothing to end"); return false }
        )
        XCTAssertEqual(result, .refused)
    }

    func testCancellationOfSetLivePropagatesRatherThanBeingTreatedAsAmbiguous() async {
        var threw = false
        do {
            _ = try await performWatchPartyGoLive(
                setLive: { throw CancellationError() },
                checkLive: { XCTFail("cancellation is not ambiguity, must not re-check"); return false },
                joinVoice: { XCTFail("must not join") },
                endParty: { XCTFail("nothing to end"); return false }
            )
        } catch is CancellationError {
            threw = true
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertTrue(threw)
    }

    // MARK: - joinVoice fails, already live

    func testJoinVoiceFailingOnAnAlreadyLivePartyEndsItAndReportsJoinFailedEndedTrue() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let result = try await performWatchPartyGoLive(
            setLive: { await calls.add("setLive"); return true },
            checkLive: { XCTFail("must not re-check a setLive that did not throw"); return false },
            joinVoice: { await calls.add("joinVoice"); throw Failure() },
            endParty: { await calls.add("endParty"); return true }
        )
        XCTAssertEqual(result, .joinFailed(ended: true))
        let log = await calls.log
        XCTAssertEqual(log, ["setLive", "joinVoice", "endParty"])
    }

    func testJoinVoiceFailingAndAlsoFailingToEndThePartyIsReportedHonestly() async throws {
        let result = try await performWatchPartyGoLive(
            setLive: { true },
            checkLive: { XCTFail("must not re-check"); return false },
            joinVoice: { throw Failure() },
            endParty: { throw Failure() }
        )
        XCTAssertEqual(result, .joinFailed(ended: false))
    }

    func testJoinVoiceFailingAfterTheAmbiguousButConfirmedLivePathStillTriesToEndIt() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let result = try await performWatchPartyGoLive(
            setLive: { throw Failure() },
            checkLive: { true },
            joinVoice: { await calls.add("joinVoice"); throw Failure() },
            endParty: { await calls.add("endParty"); return true }
        )
        XCTAssertEqual(result, .joinFailed(ended: true))
        let log = await calls.log
        XCTAssertEqual(log, ["joinVoice", "endParty"])
    }

    func testJoinVoiceCancellationPropagatesRatherThanBeingReportedAsJoinFailed() async {
        var threw = false
        do {
            _ = try await performWatchPartyGoLive(
                setLive: { true },
                checkLive: { XCTFail("must not re-check"); return false },
                joinVoice: { throw CancellationError() },
                endParty: { XCTFail("cancellation is not a join failure, must not end"); return false }
            )
        } catch is CancellationError {
            threw = true
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertTrue(threw)
    }

    // MARK: - Encerrar

    func testEndTellsTheServerFirstThenLeavesVoiceAndReportsSuccess() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let ended = try await performWatchPartyEnd(
            setEnded: { await calls.add("setEnded"); return true },
            leaveVoice: { await calls.add("leaveVoice") }
        )
        let log = await calls.log
        XCTAssertEqual(log, ["setEnded", "leaveVoice"])
        XCTAssertTrue(ended)
    }

    func testEndStillLeavesVoiceWhenTellingTheServerFailsAndSaysSo() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let ended = try await performWatchPartyEnd(
            setEnded: { await calls.add("setEnded"); throw Failure() },
            leaveVoice: { await calls.add("leaveVoice") }
        )
        let log = await calls.log
        XCTAssertEqual(log, ["setEnded", "leaveVoice"])
        XCTAssertFalse(ended)
    }

    /// `setEnded` returning `false` WITHOUT throwing: the server answered
    /// cleanly but did not confirm the end (a `nil` party in the response,
    /// the same shape `setLive` already has to handle).
    func testEndStillLeavesVoiceAndReportsFailureWhenSetEndedReturnsFalseWithoutThrowing() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        let ended = try await performWatchPartyEnd(
            setEnded: { await calls.add("setEnded"); return false },
            leaveVoice: { await calls.add("leaveVoice") }
        )
        let log = await calls.log
        XCTAssertEqual(log, ["setEnded", "leaveVoice"])
        XCTAssertFalse(ended)
    }

    /// Cancelled while the end request is in flight (the screen was left,
    /// the scope torn down): the cancellation still propagates, but the
    /// phone leaves voice first, so its screen never keeps broadcasting
    /// after the host pressed Encerrar.
    func testEndStillLeavesVoiceWhenCancelledMidRequestAndRethrowsTheCancellation() async {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        var rethrown = false
        do {
            _ = try await performWatchPartyEnd(
                setEnded: { await calls.add("setEnded"); throw CancellationError() },
                leaveVoice: { await calls.add("leaveVoice") }
            )
        } catch is CancellationError {
            rethrown = true
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertTrue(rethrown)
        let log = await calls.log
        XCTAssertEqual(log, ["setEnded", "leaveVoice"])
    }

    // MARK: - joinVoiceAndGuardSettle

    /**
     Farol finding on `WatchPartyHostController.goLive`'s first cut: a
     timed-out or refused `waitForVoiceJoin` ended the party without ever
     telling `VoiceModel` to give up on the join it had just asked for, so a
     late `welcome` could seat the phone in a room for a party already told
     it ended. `joinVoiceAndGuardSettle` is the fix, pulled out as its own
     pure function so the guarantee -- a failed settle always leaves before
     the failure propagates -- is provable without a real `VoiceModel`.
     */
    func testJoinVoiceAndGuardSettleLeavesNothingBehindOnSuccess() async throws {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        try await joinVoiceAndGuardSettle(
            join: { await calls.add("join") },
            waitForSettle: { await calls.add("waitForSettle") },
            leaveOnFailure: { await calls.add("leaveOnFailure") }
        )
        let log = await calls.log
        XCTAssertEqual(log, ["join", "waitForSettle"])
    }

    func testJoinVoiceAndGuardSettleLeavesBeforeRethrowingAnOrdinaryFailure() async {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        var rethrown = false
        do {
            try await joinVoiceAndGuardSettle(
                join: { await calls.add("join") },
                waitForSettle: { await calls.add("waitForSettle"); throw Failure() },
                leaveOnFailure: { await calls.add("leaveOnFailure") }
            )
        } catch is Failure {
            rethrown = true
        } catch {
            XCTFail("expected Failure, got \(error)")
        }
        XCTAssertTrue(rethrown)
        let log = await calls.log
        XCTAssertEqual(log, ["join", "waitForSettle", "leaveOnFailure"])
    }

    /// A timeout is modelled here as an ordinary throw from `waitForSettle`
    /// (that is exactly what `WatchPartyHostController.waitForVoiceJoin`
    /// does past its deadline) -- the leave must still run.
    func testJoinVoiceAndGuardSettleLeavesOnATimeoutTheSameWay() async {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        do {
            try await joinVoiceAndGuardSettle(
                join: {},
                waitForSettle: { throw WatchPartyHostError.message("timed out") },
                leaveOnFailure: { await calls.add("leaveOnFailure") }
            )
            XCTFail("expected a throw")
        } catch {
            // Expected -- the point of this test is that leave still ran.
        }
        let log = await calls.log
        XCTAssertEqual(log, ["leaveOnFailure"])
    }

    func testJoinVoiceAndGuardSettleLeavesBeforeRethrowingCancellation() async {
        actor Calls { var log: [String] = []; func add(_ s: String) { log.append(s) } }
        let calls = Calls()
        var rethrown = false
        do {
            try await joinVoiceAndGuardSettle(
                join: {},
                waitForSettle: { throw CancellationError() },
                leaveOnFailure: { await calls.add("leaveOnFailure") }
            )
        } catch is CancellationError {
            rethrown = true
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertTrue(rethrown)
        let log = await calls.log
        XCTAssertEqual(log, ["leaveOnFailure"])
    }

    // MARK: - The streaming-responsibility ack, fail-closed

    func testAckNeedsShowingReturnsTheLookupsCleanAnswer() async throws {
        let needsTrue = try await hostAckNeedsShowing { true }
        XCTAssertTrue(needsTrue)
        let needsFalse = try await hostAckNeedsShowing { false }
        XCTAssertFalse(needsFalse)
    }

    func testAckNeedsShowingFailsClosedOnAThrow() async throws {
        let needs = try await hostAckNeedsShowing { throw Failure() }
        XCTAssertTrue(needs, "a lookup that throws must show the notice, not skip it")
    }

    func testAckNeedsShowingPropagatesCancellationRatherThanFailingClosed() async {
        var threw = false
        do {
            _ = try await hostAckNeedsShowing { throw CancellationError() }
        } catch is CancellationError {
            threw = true
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertTrue(threw)
    }

    func testAckConfirmedReturnsTrueWhenTheSaveSucceeds() async throws {
        let confirmed = try await hostAckConfirmed { }
        XCTAssertTrue(confirmed)
    }

    func testAckConfirmedFailsClosedOnAThrow() async throws {
        let confirmed = try await hostAckConfirmed { throw Failure() }
        XCTAssertFalse(confirmed, "a save that throws must not be read as consent recorded")
    }

    func testAckConfirmedPropagatesCancellationRatherThanFailingClosed() async {
        var threw = false
        do {
            _ = try await hostAckConfirmed { throw CancellationError() }
        } catch is CancellationError {
            threw = true
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertTrue(threw)
    }
}
