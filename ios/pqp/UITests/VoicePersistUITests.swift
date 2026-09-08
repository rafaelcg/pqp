import XCTest

/// A voice channel survives leaving its screen.
///
/// THE BUG THIS PINS. `VoiceView` owned the session and left the room on
/// disappear, so the one gesture everybody makes after joining, going back to
/// read the transcript, hung up on them. Now the stage collapses to a banner
/// and the room goes on; the banner brings the stage back; only Leave leaves.
///
/// NEEDS a running local server (`pnpm dev` with `DEV_AUTH_BYPASS=true`) and a
/// simulator that has granted the microphone:
///
///     xcrun simctl privacy booted grant microphone gg.pqp.app
final class VoicePersistUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?
    private var serverName: String { seeded?.name ?? "" }

    override func setUp() {
        continueAfterFailure = false
        seeded = TestSeed.createServer(self, prefix: "VoicePersist")
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        super.tearDown()
    }

    func testCollapsingTheStageKeepsTheRoomAndTheBannerBringsItBack() {
        let app = joinTheLobby()

        app.buttons["voice.collapse"].tap()

        // Back on the transcript, with the room still up: the banner is there,
        // Join is not, and the stage's own controls are gone.
        let banner = app.buttons["voice.expand"]
        XCTAssertTrue(banner.waitForExistence(timeout: 10), "Collapsing should leave a banner on the transcript")
        XCTAssertFalse(app.buttons["chat.joinVoice"].exists, "Join must not be offered for the room we are in")
        XCTAssertFalse(app.buttons["voice.mute"].exists, "The stage should be gone while collapsed")

        banner.tap()
        XCTAssertTrue(
            app.buttons["voice.mute"].waitForExistence(timeout: 10),
            "Tapping the banner should bring the stage back"
        )
        // Reopening is not rejoining: the mute control is enabled at once,
        // which it is not during `.joining`.
        XCTAssertTrue(app.buttons["voice.mute"].isEnabled, "Reopening the stage must not rejoin the room")
    }

    func testLeavingFromTheBannerEndsTheRoom() {
        let app = joinTheLobby()
        app.buttons["voice.collapse"].tap()
        let leave = app.buttons["voice.bannerLeave"]
        XCTAssertTrue(leave.waitForExistence(timeout: 10))
        leave.tap()

        let join = app.buttons["chat.joinVoice"]
        XCTAssertTrue(join.waitForExistence(timeout: 10), "After leaving, Join should be offered again")
        XCTAssertFalse(app.buttons["voice.expand"].exists, "No banner once the room is left")
    }

    // MARK: - Getting into a voice channel

    /// Same path as `MuteOnJoinUITests`: hub, seeded server, Lobby's chat, Join.
    private func joinTheLobby() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        app.launchArguments += ["-pqp.lastVisited", "none"]
        app.launch()

        let server = app.staticTexts[serverName]
        _ = server.waitForExistence(timeout: 20)
        XCTAssertTrue(scrollIntoReach(server, in: app), "A seeded server should be reachable on the hub")
        server.tap()

        let lobby = app.staticTexts["Lobby"]
        XCTAssertTrue(lobby.waitForExistence(timeout: 10), "Seeded server has no voice channel")
        lobby.tap()

        let join = app.buttons["chat.joinVoice"]
        XCTAssertTrue(join.waitForExistence(timeout: 10), "Opening a voice channel should show its chat first")
        join.tap()

        let mute = app.buttons["voice.mute"]
        XCTAssertTrue(
            mute.waitForExistence(timeout: 20),
            "Never got into the voice room. Has the simulator granted the microphone?"
        )
        let connected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: mute
        )
        XCTAssertEqual(XCTWaiter().wait(for: [connected], timeout: 30), .completed, "The room never connected")
        return app
    }

    private func scrollIntoReach(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        let rail = app.scrollViews["hub.serverRail"]
        for _ in 0..<8 {
            if element.exists, element.isHittable { return true }
            if rail.exists { rail.swipeLeft() } else { app.swipeUp() }
            _ = element.waitForExistence(timeout: 1)
        }
        return element.exists && element.isHittable
    }
}
