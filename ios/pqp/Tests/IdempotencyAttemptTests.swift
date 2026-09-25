import XCTest

@testable import pqp

/// `IdempotencyAttempt`, pure logic, no networking: the same guarantee
/// `client/src/lib/idempotency.test.ts` pins on the web side. The header
/// actually landing on the wire is `APIClient.perform`'s job, proved by
/// reading (there is no request-inspection test harness anywhere in this
/// target to hook into, see AttachmentUploadTests.swift's note that it talks
/// to a real local server rather than a stub).
final class IdempotencyAttemptTests: XCTestCase {
    func testTheSameContentTwiceReusesTheKey() {
        let attempt = IdempotencyAttempt()
        let first = attempt.keyFor("Sala")
        let second = attempt.keyFor("Sala")
        XCTAssertEqual(first, second)
    }

    func testDifferentContentGetsADifferentKey() {
        let attempt = IdempotencyAttempt()
        let first = attempt.keyFor("Sala")
        let second = attempt.keyFor("Outra sala")
        XCTAssertNotEqual(first, second)
    }

    func testResetStartsAFreshAttemptForTheSameContent() {
        let attempt = IdempotencyAttempt()
        let first = attempt.keyFor("Sala")
        attempt.reset()
        let second = attempt.keyFor("Sala")
        XCTAssertNotEqual(first, second)
    }

    func testCreateIdempotencyKeyIsNeverEmptyAndNeverRepeats() {
        let a = createIdempotencyKey()
        let b = createIdempotencyKey()
        XCTAssertFalse(a.isEmpty)
        XCTAssertFalse(b.isEmpty)
        XCTAssertNotEqual(a, b)
    }
}
