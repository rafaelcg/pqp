import XCTest
@testable import pqp

/// Pulling to refresh used to print "cancelled" in red. These pin the three
/// pieces of the fix: what counts as a cancellation, what `APIClient` throws
/// for one, and that a pull-to-refresh outlives the task SwiftUI cancels.
final class CancellationTests: XCTestCase {
    // MARK: - What counts as a cancellation

    func testCancellationErrorIsACancellation() {
        XCTAssertTrue(CancellationError().isCancellation)
    }

    func testURLSessionCancelledIsACancellation() {
        XCTAssertTrue(URLError(.cancelled).isCancellation)
        // The bridged spelling, which is what an Objective-C completion hands back.
        let bridged = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        XCTAssertTrue(bridged.isCancellation)
    }

    func testRealFailuresAreNotCancellations() {
        XCTAssertFalse(URLError(.notConnectedToInternet).isCancellation)
        XCTAssertFalse(URLError(.timedOut).isCancellation)
        XCTAssertFalse(APIError.transport("cancelled").isCancellation)
        XCTAssertFalse(APIError.server(status: 503, message: "Down").isCancellation)
        XCTAssertFalse(NSError(domain: "other", code: NSURLErrorCancelled).isCancellation)
    }

    // MARK: - What a person is shown

    func testCancellationsShowNothing() {
        XCTAssertNil(CancellationError().userFacingMessage)
        XCTAssertNil(URLError(.cancelled).userFacingMessage)
    }

    func testRealFailuresKeepTheirSentence() {
        XCTAssertEqual(
            APIError.server(status: 503, message: "Service unavailable").userFacingMessage,
            "Service unavailable"
        )
        XCTAssertEqual(APIError.transport("offline").userFacingMessage, "offline")
        let offline = URLError(.notConnectedToInternet)
        XCTAssertEqual(offline.userFacingMessage, offline.localizedDescription)
        XCTAssertNotNil(APIError.unauthorized.userFacingMessage)
    }

    // MARK: - APIClient's mapping of URLSession failures

    func testCancelledRequestBecomesCancellationError() {
        XCTAssertTrue(APIClient.transportFailure(URLError(.cancelled)) is CancellationError)
        XCTAssertTrue(APIClient.transportFailure(CancellationError()) is CancellationError)
    }

    func testOfflineRequestStaysATransportFailure() {
        let offline = URLError(.notConnectedToInternet)
        guard case APIError.transport(let detail) = APIClient.transportFailure(offline) else {
            return XCTFail("an offline request must still surface as a transport failure")
        }
        XCTAssertEqual(detail, offline.localizedDescription)
    }

    // MARK: - The pull outlives SwiftUI's task

    @MainActor
    func testPullToRefreshFinishesWhenItsCallerIsCancelled() async {
        let started = expectation(description: "refresh started")
        let release = AsyncGate()
        var sawCancellation: Bool?

        let gesture = Task { @MainActor in
            await PullToRefresh.run {
                started.fulfill()
                await release.wait()
                sawCancellation = Task.isCancelled
            }
        }
        await fulfillment(of: [started], timeout: 2)
        // What SwiftUI does when the scroll view rebuilds under the pull.
        gesture.cancel()
        await release.open()
        await gesture.value

        XCTAssertEqual(sawCancellation, false, "the refresh must not inherit the gesture's cancellation")
    }
}

/// A one-shot latch the test opens by hand.
private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}
