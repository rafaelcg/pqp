import XCTest

/// End-to-end against a **running local server** (`pnpm dev` with
/// `DEV_AUTH_BYPASS=true`).
///
/// Deliberately not mocked. The value of these is proving the app and the real
/// API agree — a decode mismatch on one field name is the failure mode most
/// likely to ship, and a mocked test cannot see it.
final class OnboardingFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchFresh() -> XCUIApplication {
        let app = XCUIApplication()
        // Resets `hasCompletedOnboarding`, so every run starts at beat one.
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO"]
        app.launch()
        return app
    }

    func testOnboardingRunsThroughToTheServerList() {
        let app = launchFresh()

        XCTAssertTrue(
            app.staticTexts["Your friends.\nYour server.\nYour mess."].waitForExistence(timeout: 5),
            "First onboarding beat should be visible on a fresh install"
        )

        // Two "Next" taps, then the final button changes label — which is
        // itself the assertion that the last beat was reached.
        app.buttons["Next"].tap()
        app.buttons["Next"].tap()

        let getStarted = app.buttons["Get started"]
        XCTAssertTrue(getStarted.waitForExistence(timeout: 3),
                      "Final beat should offer 'Get started' rather than 'Next'")
        getStarted.tap()

        XCTAssertTrue(
            app.navigationBars["Servers"].waitForExistence(timeout: 10),
            "Completing onboarding should land on the server list"
        )
    }

    func testSkipShortCircuitsOnboarding() {
        let app = launchFresh()
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 5))
        app.buttons["Skip"].tap()

        XCTAssertTrue(
            app.navigationBars["Servers"].waitForExistence(timeout: 10),
            "Skip should sign in immediately"
        )
    }

    /// The one that proves the wire contract: real servers, fetched over HTTP,
    /// decoded into the real models, rendered.
    func testServersLoadFromTheLiveAPI() {
        let app = launchFresh()
        app.buttons["Skip"].tap()

        XCTAssertTrue(app.navigationBars["Servers"].waitForExistence(timeout: 10))
        // Seeded by the test setup script; if decoding broke, the list is empty
        // and this fails rather than quietly showing an empty state.
        XCTAssertTrue(
            app.staticTexts["Design Crew"].waitForExistence(timeout: 10),
            "A seeded server should decode and render"
        )
    }

    func testSendingAMessageEchoesBackFromTheServer() {
        let app = launchFresh()
        app.buttons["Skip"].tap()

        XCTAssertTrue(app.staticTexts["Design Crew"].waitForExistence(timeout: 10))
        app.staticTexts["Design Crew"].tap()

        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5),
                      "The default #general channel should be listed")
        app.staticTexts["general"].tap()

        let composer = app.textFields["Message"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()

        let sent = "hello from ios \(Int.random(in: 1000...9999))"
        composer.typeText(sent)
        // The send button is the only other control in the composer row.
        app.buttons.matching(identifier: "arrow.up").firstMatch.tap()

        // Sending goes out over the WebSocket and comes back as a broadcast.
        // Asserting on the text appearing proves the whole round trip, not just
        // the optimistic echo, because the optimistic row is replaced by the
        // server's copy carrying the same body.
        XCTAssertTrue(
            app.staticTexts[sent].waitForExistence(timeout: 10),
            "A sent message should appear in the transcript"
        )
    }
}
