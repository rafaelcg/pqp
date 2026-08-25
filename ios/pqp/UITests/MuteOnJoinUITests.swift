import XCTest

/// "Mute microphone when joining voice", proven from the switch to the room.
///
/// THE BUG THIS PINS. The toggle existed in Settings and wrote the preference
/// to the server; nothing ever read it back. Somebody who ticked it joined with
/// a live microphone, and no screen anywhere said otherwise. That is invisible
/// to every test that does not actually join a voice channel, which is why this
/// file joins one.
///
/// BOTH DIRECTIONS ARE ASSERTED. A test that only checks the ticked case passes
/// just as happily against a client that joins muted always, which would be a
/// worse bug than the one being fixed.
///
/// NEEDS a running local server (`pnpm dev` with `DEV_AUTH_BYPASS=true`) and a
/// simulator that has granted the microphone:
///
///     xcrun simctl privacy booted grant microphone gg.pqp.app
///
/// Without that, joining fails on permission and the assertion below reports
/// the mute button never appearing.
final class MuteOnJoinUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?
    private var serverName: String { seeded?.name ?? "" }

    override func setUp() {
        continueAfterFailure = false
        // Every new server comes with a `Lobby` voice channel, which is the
        // room these tests join.
        seeded = TestSeed.createServer(self, prefix: "MuteOnJoin")
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        // Never leave the shared dev account carrying a preference a later test
        // did not ask for.
        setMuteOnJoin(false)
        super.tearDown()
    }

    func testTickedMeansTheRoomIsJoinedMuted() {
        setMuteOnJoin(true)
        let app = joinTheLobby()
        XCTAssertEqual(
            app.buttons["voice.mute"].label, "Unmute",
            "With 'mute on join' set, the room should be joined muted"
        )
    }

    func testUntickedMeansTheMicrophoneIsLive() {
        setMuteOnJoin(false)
        let app = joinTheLobby()
        XCTAssertEqual(
            app.buttons["voice.mute"].label, "Mute",
            "Without the preference, joining must not mute anybody"
        )
    }

    // MARK: - Getting into a voice channel

    /// Launches, opens the seeded server, and enters its `Lobby`.
    ///
    /// The preference is read at join time from the account the app loaded at
    /// launch, so it has to be set on the server *before* this runs.
    private func joinTheLobby() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        // Otherwise the app restores whichever channel a previous run left open
        // and the hub, where the seeded server is, is never reached.
        app.launchArguments += ["-pqp.lastVisited", "none"]
        app.launch()

        let server = app.staticTexts[serverName]
        _ = server.waitForExistence(timeout: 20)
        XCTAssertTrue(
            scrollIntoReach(server, in: app),
            "A seeded server should be reachable on the hub"
        )
        server.tap()

        let lobby = app.staticTexts["Lobby"]
        XCTAssertTrue(lobby.waitForExistence(timeout: 10), "Seeded server has no voice channel")
        lobby.tap()

        XCTAssertTrue(
            app.buttons["voice.mute"].waitForExistence(timeout: 20),
            "Never got into the voice room. Has the simulator granted the microphone?"
        )
        return app
    }

    /// The rail scrolls horizontally, and a seeded server is appended to the
    /// end of it. Same dance as `ChatUXUITests`, and for the same reason.
    private func scrollIntoReach(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        let rail = app.scrollViews["hub.serverRail"]
        for _ in 0..<8 {
            if element.exists, element.isHittable { return true }
            if rail.exists {
                rail.swipeLeft()
            } else {
                app.swipeUp()
            }
            _ = element.waitForExistence(timeout: 1)
        }
        return element.exists && element.isHittable
    }

    /// Sets the preference over HTTP rather than through the Settings screen.
    ///
    /// The switch itself is not what is in doubt: it has always saved. What was
    /// missing is anything reading the saved value, so the test that matters
    /// starts from a value already on the server.
    private func setMuteOnJoin(_ on: Bool) {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)/api/me/preferences")!)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["muteOnJoin": on])

        let done = XCTestExpectation(description: "set muteOnJoin")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            XCTAssertTrue(
                (200..<300).contains(status),
                "Could not set muteOnJoin (\(status)). Is the dev server running?"
            )
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
    }
}
