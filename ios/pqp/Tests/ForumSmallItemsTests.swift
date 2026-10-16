import XCTest
@testable import pqp

/// QA F2 (the pinned count under a filter) and C1 (singular and plural in the
/// forum copy).
final class ForumSmallItemsTests: XCTestCase {
    func testPinnedCountIsTheListsOwnWhenNothingNarrowsIt() {
        XCTAssertEqual(ForumPinnedCount.resolve(narrowing: false, shown: 1, unfiltered: nil), 1)
        // A stale forum-wide number never overrides a list that is whole.
        XCTAssertEqual(ForumPinnedCount.resolve(narrowing: false, shown: 2, unfiltered: 0), 2)
    }

    func testUnderAFilterTheForumWideCountWinsOnceRead() {
        // The Bug filter hides the pinned rules post: the list shows 0, the forum has 1.
        XCTAssertEqual(ForumPinnedCount.resolve(narrowing: true, shown: 0, unfiltered: 1), 1)
        XCTAssertEqual(ForumPinnedCount.resolve(narrowing: true, shown: 0, unfiltered: 3), 3)
    }

    func testUnderAFilterBeforeTheReadItFallsBackToWhatIsShown() {
        XCTAssertEqual(ForumPinnedCount.resolve(narrowing: true, shown: 0, unfiltered: nil), 0)
    }

    func testOneNewReplyIsSingular() {
        XCTAssertEqual(ForumCopy.newReplies(1), String(localized: "1 new reply"))
        XCTAssertNotEqual(ForumCopy.newReplies(1), ForumCopy.newReplies(2))
        XCTAssertTrue(ForumCopy.newReplies(3).contains("3"))
    }

    func testRepliesSingularAndPlural() {
        XCTAssertEqual(ForumCopy.replies(1), String(localized: "1 reply"))
        XCTAssertTrue(ForumCopy.replies(2).contains("2"))
    }

    func testThePortugueseSingularsExist() throws {
        let path = try XCTUnwrap(Bundle.main.path(forResource: "pt-BR", ofType: "lproj"))
        let bundle = try XCTUnwrap(Bundle(path: path))
        XCTAssertEqual(bundle.localizedString(forKey: "1 new reply", value: nil, table: nil), "1 resposta nova")
        XCTAssertEqual(bundle.localizedString(forKey: "1 reply", value: nil, table: nil), "1 resposta")
    }
}
