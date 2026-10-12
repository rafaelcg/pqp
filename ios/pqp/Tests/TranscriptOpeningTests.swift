import CoreGraphics
import XCTest
@testable import pqp

/// A channel opens on its latest message without scrolling there in view.
///
/// The scroll itself needs a screen (see `ChatView.positionTranscript`); what
/// is pinned here is the two rules around it that fail quietly. When the list
/// is held invisible: too eagerly and the scroll through history is back, too
/// long and an empty channel is a blank screen. And the box a picture reserves
/// before its bytes arrive: one point off and every picture nudges the
/// transcript again when it loads.
final class TranscriptOpeningTests: XCTestCase {
    // MARK: - The hold

    func testHeldWhileMessagesWaitToBePositioned() {
        XCTAssertTrue(TranscriptOpening.isHidden(
            isForumPost: false, positioned: false, hasMessages: true, isLoading: false, holdExpired: false
        ))
    }

    func testHeldWhileAChannelNeverOpenedHereIsStillLoading() {
        XCTAssertTrue(TranscriptOpening.isHidden(
            isForumPost: false, positioned: false, hasMessages: false, isLoading: true, holdExpired: false
        ))
    }

    func testDrawnOncePositioned() {
        XCTAssertFalse(TranscriptOpening.isHidden(
            isForumPost: false, positioned: true, hasMessages: true, isLoading: true, holdExpired: false
        ))
    }

    func testAnEmptyChannelShowsItsEmptyStateAtOnce() {
        XCTAssertFalse(TranscriptOpening.isHidden(
            isForumPost: false, positioned: false, hasMessages: false, isLoading: false, holdExpired: false
        ))
    }

    func testTheHoldGivesUpRatherThanLeaveABlankScreen() {
        XCTAssertFalse(TranscriptOpening.isHidden(
            isForumPost: false, positioned: false, hasMessages: true, isLoading: true, holdExpired: true
        ))
    }

    /// A post lands through `ForumLanding`, header first; holding it here
    /// would hide the question for as long as that pages back.
    func testAForumPostIsNeverHeld() {
        XCTAssertFalse(TranscriptOpening.isHidden(
            isForumPost: true, positioned: false, hasMessages: true, isLoading: true, holdExpired: false
        ))
    }

    // MARK: - The reserved box

    func testLandscapeFillsTheWidth() {
        let box = MediaBox.fitted(width: 1600, height: 600, maxWidth: 260, maxHeight: 260)
        XCTAssertEqual(box, CGSize(width: 260, height: 98))
    }

    func testPortraitFillsTheHeight() {
        let box = MediaBox.fitted(width: 800, height: 1400, maxWidth: 260, maxHeight: 260)
        XCTAssertEqual(box, CGSize(width: 149, height: 260))
    }

    /// Matches `.resizable().scaledToFit()` in a max frame, which scales a
    /// small picture up to the box: reserving its native size would be wrong
    /// by exactly the difference.
    func testASmallPictureScalesUpLikeTheViewDoes() {
        let box = MediaBox.fitted(width: 100, height: 50, maxWidth: 240, maxHeight: 160)
        XCTAssertEqual(box, CGSize(width: 240, height: 120))
    }

    func testWholePointsSoBothSidesOfTheLoadAgree() {
        let box = MediaBox.fitted(width: 1000, height: 333, maxWidth: 260, maxHeight: 260)
        XCTAssertEqual(box?.width, 260)
        XCTAssertEqual(box?.height, 87)
    }

    func testUnknownOrNonsenseDimensionsReserveNothing() {
        XCTAssertNil(MediaBox.fitted(width: nil, height: 600, maxWidth: 260, maxHeight: 260))
        XCTAssertNil(MediaBox.fitted(width: 800, height: nil, maxWidth: 260, maxHeight: 260))
        XCTAssertNil(MediaBox.fitted(width: 0, height: 600, maxWidth: 260, maxHeight: 260))
        XCTAssertNil(MediaBox.fitted(width: 800, height: -1, maxWidth: 260, maxHeight: 260))
    }
}
