import XCTest
@testable import pqp

/// QA S2: with a story up, the "+" target covered the lower-right of the own
/// ring (its centre too), so a tap on the avatar opened the camera.
final class StoryOwnPlusTests: XCTestCase {
    func testWithAStoryTheRingCentreAndTheAvatarBodyAreNotTheBadgesTarget() {
        let target = StoryOwnPlusTarget.frame(hasStory: true)
        XCTAssertFalse(target.contains(StoryOwnPlusTarget.ringCenter))
        // Where a thumb lands "just right and below the centre" of the avatar.
        XCTAssertFalse(target.contains(CGPoint(x: 38, y: 38)))
        XCTAssertFalse(target.contains(CGPoint(x: 40, y: 50)))
    }

    func testTheBadgeItselfStaysTappable() {
        let target = StoryOwnPlusTarget.frame(hasStory: true)
        // The 20 pt badge sits around 57,56 and must be wholly inside.
        XCTAssertTrue(target.contains(CGPoint(x: 47, y: 46)))
        XCTAssertTrue(target.contains(CGPoint(x: 67, y: 66)))
        XCTAssertTrue(target.contains(CGPoint(x: 57, y: 56)))
    }

    func testWithoutAStoryTheTargetStaysTheBigOne() {
        let target = StoryOwnPlusTarget.frame(hasStory: false)
        XCTAssertEqual(target.width, 48)
        XCTAssertEqual(target.height, 48)
        XCTAssertTrue(target.contains(CGPoint(x: 57, y: 56)))
    }
}
