import XCTest
@testable import pqp

/// What the lime Baú badge says, as pure rules.
final class BauBadgeTests: XCTestCase {
    func testNothingUnreadShowsNoBadge() {
        XCTAssertNil(BauBadge.label(count: 0))
        XCTAssertNil(BauBadge.label(count: -2))
    }

    func testCountsUpToNineAreShownAsTheyAre() {
        XCTAssertEqual(BauBadge.label(count: 1), "1")
        XCTAssertEqual(BauBadge.label(count: 9), "9")
    }

    func testTenAndAboveStopAtNinePlus() {
        XCTAssertEqual(BauBadge.label(count: 10), "9+")
        XCTAssertEqual(BauBadge.label(count: 250), "9+")
    }

    func testAServerMissingFromTheAggregateHasNothingUnread() {
        let unread = ["a": 3, "b": 12]
        XCTAssertEqual(BauBadge.unread(for: "a", in: unread), 3)
        XCTAssertEqual(BauBadge.unread(for: "b", in: unread), 12)
        XCTAssertEqual(BauBadge.unread(for: "c", in: unread), 0)
    }

    /// The API also sends `newest` (web-only); the app must keep decoding.
    func testTheAggregateDecodesAndIgnoresTheWebOnlyNewestTimes() throws {
        let body = Data("""
        {"servers":{"s1":2,"s2":11},"newest":{"s1":"2026-10-10T10:00:00.000Z"}}
        """.utf8)
        let decoded = try JSONDecoder().decode(CommunityHomeUnreadAllResponse.self, from: body)
        XCTAssertEqual(decoded.servers, ["s1": 2, "s2": 11])
    }
}
