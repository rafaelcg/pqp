import XCTest
@testable import pqp

/// A text story from before layers is drawn inside the canvas' safe area and
/// above the footer (QA S1: with the keyboard up, 280 characters printed over
/// the header, the reaction pill and the reply field).
final class StoryTextFitTests: XCTestCase {
    private let canvas = CGRect(x: 0, y: 75, width: 390, height: 693)

    func testWithoutAKeyboardTheBoxIsTheSafeArea() {
        let box = StoryStage.legacyTextBox(canvas: canvas, footerTop: nil)
        XCTAssertEqual(box.minX, 390 * 0.05, accuracy: 0.01)
        XCTAssertEqual(box.width, 390 * 0.9, accuracy: 0.01)
        XCTAssertEqual(box.minY, 75 + 693 * 0.10, accuracy: 0.01)
        XCTAssertEqual(box.maxY, 75 + 693 * 0.87, accuracy: 0.01)
    }

    func testAFooterBelowTheMarginChangesNothing() {
        let plain = StoryStage.legacyTextBox(canvas: canvas, footerTop: nil)
        XCTAssertEqual(StoryStage.legacyTextBox(canvas: canvas, footerTop: 800), plain)
        XCTAssertEqual(StoryStage.legacyTextBox(canvas: canvas, footerTop: .infinity), plain)
    }

    func testAFooterRidingTheKeyboardPullsTheBottomAboveIt() {
        let box = StoryStage.legacyTextBox(canvas: canvas, footerTop: 420)
        XCTAssertEqual(box.maxY, 420 - 12, accuracy: 0.01)
        XCTAssertGreaterThan(box.height, 0)
    }

    func testTheHeaderPushesTheTopDownWhenItIsLowerThanTheMargin() {
        let box = StoryStage.legacyTextBox(canvas: canvas, headerBottom: 160, footerTop: 420)
        XCTAssertEqual(box.minY, 172, accuracy: 0.01)
        // A header inside the margin changes nothing.
        let plain = StoryStage.legacyTextBox(canvas: canvas, footerTop: nil)
        XCTAssertEqual(StoryStage.legacyTextBox(canvas: canvas, headerBottom: 40, footerTop: nil), plain)
    }

    func testAFooterHigherThanTheTopStillLeavesALine() {
        let box = StoryStage.legacyTextBox(canvas: canvas, footerTop: 100)
        XCTAssertEqual(box.height, StoryStage.minHeight, accuracy: 0.01)
        // Never reaches past the footer: it grows up, not down.
        XCTAssertLessThanOrEqual(box.maxY, 100 - 12 + 0.01)
    }

    func testAShortLineKeepsTheOldSize() {
        XCTAssertEqual(StoryStage.legacyFontSize(text: "oi", in: CGSize(width: 350, height: 500)), 34)
    }

    func testALongTextShrinksUntilItFitsTheHeight() {
        let text = String(repeating: "Lorem ipsum dolor sit amet ", count: 10)
        let size = StoryStage.legacyFontSize(text: text, in: CGSize(width: 350, height: 300))
        XCTAssertLessThan(size, 34)
        XCTAssertGreaterThanOrEqual(size, 12)
    }

    func testALongUnbrokenWordWrapsByCharacterAndStaysReadable() {
        let word = String(repeating: "a", count: 120)
        XCTAssertGreaterThan(StoryStage.legacyFontSize(text: word, in: CGSize(width: 350, height: 300)), 20)
    }

    func testNeverBelowTheFloor() {
        let text = String(repeating: "word ", count: 500)
        XCTAssertEqual(StoryStage.legacyFontSize(text: text, in: CGSize(width: 100, height: 60)), 12)
    }
}
