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
        // The 18+ gate outranks every route. A reset database leaves the dev
        // user pending, at which point the app (correctly) shows the age gate
        // instead of the server list — so the answer is put on file before
        // any launch, exactly as a real signed-in user would have done.
        TestSeed.passAgeGate(self)
    }

    private func launchFresh() -> XCUIApplication {
        let app = XCUIApplication()
        // Resets `hasCompletedOnboarding`, so every run starts at beat one.
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO"]
        // …and forgets where the last run was reading, so these tests land on
        // the hub rather than in whichever channel a previous test opened.
        // "none" is not a valid encoding, so it reads as no destination.
        app.launchArguments += ["-pqp.lastVisited", "none"]
        app.launch()
        return app
    }

    func testOnboardingRunsThroughToTheHub() {
        let app = launchFresh()

        XCTAssertTrue(
            app.staticTexts["Your friends.\nYour community.\nYour mess."].waitForExistence(timeout: 5),
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
            app.buttons["hub.profile"].waitForExistence(timeout: 10),
            "Completing onboarding should land on the hub"
        )
    }

    func testSkipShortCircuitsOnboarding() {
        let app = launchFresh()
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 5))
        app.buttons["Skip"].tap()

        XCTAssertTrue(
            app.buttons["hub.profile"].waitForExistence(timeout: 10),
            "Skip should sign in immediately"
        )
    }

    /// The hub is one screen, not three tabs: servers, direct messages and the
    /// profile/friends dock are all reachable without a mode switch. Asserting
    /// on all four anchors is what stops one of them quietly disappearing
    /// behind a redesign.
    func testTheHubShowsServersConversationsAndYouAtOnce() {
        let server = TestSeed.createServer(self)
        defer { TestSeed.deleteServer(self, id: server.id) }
        let app = launchFresh()
        app.buttons["Skip"].tap()

        XCTAssertTrue(app.buttons["hub.profile"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["hub.friends"].exists, "Friends keeps an entry point on the hub")
        XCTAssertTrue(app.buttons["hub.newConversation"].exists)
        XCTAssertTrue(
            app.buttons["hub.server.\(server.id)"].waitForExistence(timeout: 10),
            "Servers are on the hub, not behind a tab"
        )
        // There is no tab bar any more; if one comes back, this fails.
        XCTAssertEqual(app.tabBars.count, 0, "The hub must not reintroduce a tab bar")
    }

    /// The profile lives on the hub and must not follow you into a channel —
    /// the whole point of dropping the tab bar.
    func testTheProfileDockDoesNotFollowYouIntoAChannel() {
        let server = TestSeed.createServer(self)
        defer { TestSeed.deleteServer(self, id: server.id) }
        let app = launchFresh()
        app.buttons["Skip"].tap()

        app.openServerFromHub(server.id)
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["hub.profile"].exists,
                       "The profile dock belongs to the hub only")

        app.staticTexts["general"].tap()
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["hub.profile"].exists)

        // Back out the way a person would, one push at a time.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["hub.profile"].waitForExistence(timeout: 5),
                      "Back from a channel returns to the hub")
    }

    /// Launch lands you where you left off. Written as two launches on purpose:
    /// the pointer is only worth anything if it survives the process.
    func testTheLastChannelIsReopenedOnTheNextLaunch() {
        let server = TestSeed.createServer(self)
        defer { TestSeed.deleteServer(self, id: server.id) }
        let app = launchFresh()
        app.buttons["Skip"].tap()

        app.openServerFromHub(server.id)
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5))
        app.staticTexts["general"].tap()
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 5))
        app.terminate()

        // No reset argument this time, so the recorded channel is on file.
        let relaunched = XCUIApplication()
        relaunched.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        relaunched.launch()

        XCTAssertTrue(
            relaunched.navigationBars["#general"].waitForExistence(timeout: 15),
            "The last channel read should be where the app opens"
        )
        // And the way back is still obvious: the channel list, then the hub.
        relaunched.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(relaunched.staticTexts["general"].waitForExistence(timeout: 5))
        relaunched.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(relaunched.buttons["hub.profile"].waitForExistence(timeout: 5),
                      "A restored channel must still have the hub underneath it")
    }

    /// The one that proves the wire contract: real servers, fetched over HTTP,
    /// decoded into the real models, rendered.
    func testServersLoadFromTheLiveAPI() {
        let server = TestSeed.createServer(self)
        defer { TestSeed.deleteServer(self, id: server.id) }
        let app = launchFresh()
        app.buttons["Skip"].tap()

        XCTAssertTrue(app.buttons["hub.profile"].waitForExistence(timeout: 10))
        // If decoding broke, the rail is empty and this fails rather than
        // quietly showing an empty state. Scrolled to by id rather than assumed
        // on screen: leftovers from an interrupted run can push the newest
        // server past the rail's right edge.
        app.openServerFromHub(server.id)
        XCTAssertTrue(
            app.staticTexts["general"].waitForExistence(timeout: 10),
            "A seeded server should decode, render and open"
        )
    }

    func testSendingAMessageEchoesBackFromTheServer() {
        // Its own server, so the transcript is empty. Sharing one made this
        // test slower every run until XCUITest timed out snapshotting the tree.
        let server = TestSeed.createServer(self)
        defer { TestSeed.deleteServer(self, id: server.id) }
        let app = launchFresh()
        app.buttons["Skip"].tap()

        app.openServerFromHub(server.id)

        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5),
                      "The default #general channel should be listed")
        app.staticTexts["general"].tap()

        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()

        let sent = "hello from ios \(Int.random(in: 1000...9999))"
        composer.typeText(sent)
        // Send only exists once there is something to send, so it is waited for
        // rather than assumed to be sitting there greyed out.
        let sendButton = app.buttons["composer.send"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 3))
        sendButton.tap()

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

/// Launch resilience.
///
/// The splash screen has no controls on it, so anything that can hang during
/// `restore()` strands the app on a logo with no way out. That shipped once:
/// `waitsForConnectivity` parked the first request until the network returned,
/// bounded only by a seven-day resource timeout.
final class LaunchResilienceUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testReachesOnboardingEvenWhenTheServerIsUnreachable() {
        let app = XCUIApplication()
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        // A port nothing is listening on, so the bootstrap call cannot succeed.
        app.launchEnvironment["PQP_API_OVERRIDE"] = "http://127.0.0.1:9"
        let started = Date()
        app.launch()

        XCTAssertTrue(
            app.buttons["Skip"].waitForExistence(timeout: 25),
            "An unreachable server must land on onboarding, never hang on the splash"
        )

        // Bounded on *time*, not just on eventually arriving. There are two
        // independent guards here — the URLSession config, and a 12s deadline
        // in `restore()` — and without a bound the deadline alone satisfies the
        // test, so a regression in the network config would pass unnoticed.
        // A connection refused on a dead local port resolves in well under a
        // second; 8s leaves room for simulator launch and nothing else.
        let elapsed = Date().timeIntervalSince(started)
        XCTAssertLessThan(
            elapsed, 8,
            "Reached onboarding in \(elapsed)s — that is the deadline backstop firing, "
            + "not a fast connection failure. Check waitsForConnectivity."
        )
    }
}

/// Message interactions, against the live server.
///
/// Reactions and edits both round-trip through the server, so these prove the
/// wire calls as much as the UI: a reaction goes out over the WebSocket, an
/// edit over HTTP, and both come back as broadcasts.
final class MessageActionUITests: XCTestCase {
    // `createServer` passes the age gate itself, so no extra setup here.
    private var seeded: TestSeed.SeededServer?
    private var serverId: String { seeded?.id ?? "" }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        super.tearDown()
    }

    override func setUp() {
        continueAfterFailure = false
        // A fresh server per test. These used to run against whichever channel
        // previous runs had filled up, so the transcript grew every time —
        // including an inline image — and the accessibility tree with it, until
        // the suite took minutes. Hermetic is also simply correct: a test that
        // depends on leftover state fails for reasons that have nothing to do
        // with what it claims to check.
        seeded = TestSeed.createServer(self)
    }

    private func openGeneral() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO"]
        // Start on the hub, not in whatever channel the last run restored.
        app.launchArguments += ["-pqp.lastVisited", "none"]
        app.launch()
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 5))
        app.buttons["Skip"].tap()
        app.openServerFromHub(serverId)
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5))
        app.staticTexts["general"].tap()
        return app
    }

    private func send(_ text: String, in app: XCUIApplication) {
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText(text)
        let sendButton = app.buttons["composer.send"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 3))
        sendButton.tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10))
        // Let the scroll-to-tail animation finish before anything presses on
        // the row: a press issued mid-animation lands where the row *was*, and
        // the author name directly above the body is now a profile link.
        Thread.sleep(forTimeInterval: 0.7)
    }

    func testEditingAMessageUpdatesItAndMarksItEdited() {
        let app = openGeneral()
        let original = "edit me \(Int.random(in: 1000...9999))"
        send(original, in: app)

        app.staticTexts[original].press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5))
        app.buttons["Edit"].tap()

        // `beginEdit` sets the draft and SwiftUI propagates it into the field a
        // beat later; typing into that gap gets clobbered by the prefill. One
        // settle rather than a polling loop — every XCUITest query snapshots
        // the whole accessibility tree, so polling `.value` at 10Hz against a
        // long transcript costs minutes, which is how the "fix" for this race
        // first made the test 10x slower.
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertEqual(composer.value as? String, original,
                       "Composer should be prefilled with the original body before typing")
        composer.tap()
        composer.typeText(" v2")
        let sendButton = app.buttons["composer.send"]
        XCTAssertTrue(sendButton.waitForExistence(timeout: 3))
        sendButton.tap()

        XCTAssertTrue(
            app.staticTexts["\(original) v2"].waitForExistence(timeout: 10),
            "The edited body should replace the original"
        )
        XCTAssertTrue(app.staticTexts["edited"].waitForExistence(timeout: 5),
                      "An edited message should be labelled as such")
    }

    func testDeletingAMessageRemovesIt() {
        let app = openGeneral()
        let doomed = "delete me \(Int.random(in: 1000...9999))"
        send(doomed, in: app)

        app.staticTexts[doomed].press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 5))
        app.buttons["Delete"].tap()

        // Polls for absence rather than asserting immediately: the optimistic
        // removal and the broadcast are two different moments. A plain loop
        // rather than an NSPredicate expectation, which Swift 6 rejects here
        // because XCTestCase is not Sendable.
        let deadline = Date().addingTimeInterval(10)
        while app.staticTexts[doomed].exists && Date() < deadline {
            usleep(200_000)
        }
        XCTAssertFalse(app.staticTexts[doomed].exists, "Deleted message should disappear")
    }
}
