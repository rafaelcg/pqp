import XCTest

/// Reading history is not interrupted by somebody else talking.
///
/// THE BUG THIS PINS. `ChatModel.isNearBottom` guards the transcript's
/// auto-scroll, was initialised to `true`, and was never written by anything.
/// So every arriving message pulled the view to the bottom, including while
/// somebody was two screens up reading what was said an hour ago. It is the
/// failure the comment beside that auto-scroll calls "the classic chat-app
/// sin", sitting directly underneath the flag meant to prevent it.
///
/// IT NEEDS A SECOND SPEAKER, which is why this file posts through a webhook.
/// A message sent from the app under test scrolls the sender to the bottom on
/// purpose, so it cannot show the difference; a webhook is the only way to make
/// a message arrive from outside without a second signed-in client.
///
/// Needs a running local server (`pnpm dev` with `DEV_AUTH_BYPASS=true`).
final class TranscriptScrollUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?
    private var webhookPath = ""
    private var serverName: String { seeded?.name ?? "" }

    /// Tall enough that a screenful is a handful of them, so the test can get
    /// genuinely far from the tail without paying for a hundred posts against
    /// the webhook's rate limiter.
    private func body(_ index: Int) -> String {
        let label = String(format: "line%02d", index)
        return "\(label)\n.\n.\n.\n."
    }

    private let count = 14

    override func setUp() {
        continueAfterFailure = false
        seeded = TestSeed.createServer(self, prefix: "Scroll")
        webhookPath = TestSeed.createWebhook(self, serverId: seeded?.id ?? "")
        for index in 0..<count {
            TestSeed.postThroughWebhook(self, path: webhookPath, content: body(index))
        }
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        super.tearDown()
    }

    func testAnArrivingMessageDoesNotYankSomebodyOutOfTheHistory() {
        let app = openGeneral()

        // The newest message is what the channel opens on.
        let newest = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", String(format: "line%02d", count - 1))
        ).firstMatch
        XCTAssertTrue(newest.waitForExistence(timeout: 20), "The channel never loaded its messages")

        // Read history: scroll back to the very first message.
        let oldest = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "line00")
        ).firstMatch
        var swipes = 0
        while !(oldest.exists && oldest.isHittable) && swipes < 15 {
            app.swipeDown()
            swipes += 1
        }
        XCTAssertTrue(
            oldest.exists && oldest.isHittable,
            "Could not scroll back to the start of the transcript"
        )

        // Somebody else says something while we are up here.
        TestSeed.postThroughWebhook(self, path: webhookPath, content: body(count))

        // Give the socket time to deliver it and the view time to do the wrong
        // thing if it is going to.
        let arrived = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", String(format: "line%02d", count))
        ).firstMatch
        _ = arrived.waitForExistence(timeout: 10)

        XCTAssertTrue(
            oldest.exists && oldest.isHittable,
            "A message arriving while reading history pulled the transcript to the bottom"
        )
    }

    // MARK: - Getting into the channel

    private func openGeneral() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        app.launchArguments += ["-pqp.lastVisited", "none"]
        app.launch()

        let server = app.staticTexts[serverName]
        _ = server.waitForExistence(timeout: 20)
        var attempts = 0
        let rail = app.scrollViews["hub.serverRail"]
        while !(server.exists && server.isHittable) && attempts < 8 {
            if rail.exists { rail.swipeLeft() } else { app.swipeUp() }
            _ = server.waitForExistence(timeout: 1)
            attempts += 1
        }
        XCTAssertTrue(server.exists && server.isHittable, "Seeded server never became reachable")
        server.tap()

        let general = app.staticTexts["general"]
        XCTAssertTrue(general.waitForExistence(timeout: 10))
        general.tap()
        return app
    }
}
