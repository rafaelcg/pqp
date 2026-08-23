import XCTest

/// The rating card, on screen, against the live local server.
///
/// WHAT THIS COVERS THAT `CallRatingTests` CANNOT. Those pin the rules that
/// decide whether to ask; none of them proves the question is reachable. The
/// card is rendered from the app root rather than from a voice screen precisely
/// because that screen has already been popped by the time a call ends, and
/// "the overlay was attached to the wrong view" is a mistake that passes every
/// unit test and shows nothing to the user.
///
/// The call behind it is synthetic (`-pqp.fakeCallRating`). A real one needs two
/// people in one room for over a minute, which one simulator cannot arrange.
final class CallRatingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += [
            "-pqp.hasCompletedOnboarding", "NO",
            // Same reason the chat tests carry it: a restored channel lands on
            // top of everything and the card would be behind it.
            "-pqp.lastVisited", "none",
            "-pqp.fakeCallRating",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 10))
        app.buttons["Skip"].tap()
        return app
    }

    func testTheCardIsReachableFromWhereverTheAppLands() {
        let app = launch()
        XCTAssertTrue(
            app.otherElements["callRating.card"].waitForExistence(timeout: 20),
            "The question has to survive the screen the call was on"
        )
        XCTAssertTrue(app.staticTexts["How was that call?"].exists)
        // The ends are labelled because a bare row of numbers does not say
        // which direction is good.
        XCTAssertTrue(app.staticTexts["Unusable"].exists)
        XCTAssertTrue(app.staticTexts["Perfect"].exists)
    }

    func testAGoodScoreSendsImmediatelyAndThanksYou() {
        let app = launch()
        XCTAssertTrue(app.otherElements["callRating.card"].waitForExistence(timeout: 20))

        XCTAssertFalse(
            app.textFields["callRating.note"].exists,
            "The note is only asked for where the number leaves a question open"
        )
        app.buttons["callRating.score.5"].tap()

        // This posts to the live local server. A failure here is a real one:
        // the body is built from the shared schema's field names and a
        // mismatched one would 400.
        XCTAssertTrue(
            app.staticTexts["callRating.thanks"].waitForExistence(timeout: 10),
            "A score that went nowhere still has to close the loop for the person"
        )
    }

    func testALowScoreAsksWhatWentWrong() {
        let app = launch()
        XCTAssertTrue(app.otherElements["callRating.card"].waitForExistence(timeout: 20))

        app.buttons["callRating.score.2"].tap()

        XCTAssertTrue(
            app.textFields["callRating.note"].waitForExistence(timeout: 5),
            "A 2 needs to say whether it was the voice, the picture or the joining"
        )
        app.textFields["callRating.note"].typeText("audio cut out")
        app.buttons["callRating.send"].tap()

        // The card going away is what is asserted here, NOT the thank-you.
        //
        // The thank-you shows for 1.4s and then dismisses itself, and
        // XCUITest's `tap()` does not return until the app stops animating —
        // which on this path means waiting out the keyboard dismissal. That
        // routinely consumes the whole window, so asserting on it produced a
        // test that failed while the row it was checking for landed in the
        // database every single time. The version above, with no keyboard in
        // the way, still pins the thank-you.
        XCTAssertTrue(
            app.otherElements["callRating.card"].waitForNonExistence(timeout: 10),
            "Sending a note has to close the card rather than leave it sitting there"
        )
    }

    func testDismissingIsFreeAndFinal() {
        let app = launch()
        let card = app.otherElements["callRating.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 20))

        app.buttons["callRating.dismiss"].tap()

        // Gone, and not replaced by a "remind me later": there is no later for
        // a call that has already ended.
        XCTAssertTrue(card.waitForNonExistence(timeout: 5))
    }
}
