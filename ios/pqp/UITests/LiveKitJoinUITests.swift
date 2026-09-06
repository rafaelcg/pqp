import XCTest

/// Joining a LiveKit room, proven from the tap to the connected toolbar.
///
/// THE BUG THIS PINS. Every build before `feat/ios-livekit` declared
/// `transports: ["mesh"]` and was refused from every room the server pinned to
/// the SFU, which on production is most of them. A unit test can pin the
/// decision (`VoiceTransportTests`); only a real join can prove that the token
/// is minted for the right peer id, that the LiveKit room connects, and that
/// the screen reaches "connected" rather than sitting on "Connecting" until the
/// 45 second clock gives up. On the SFU transport the mute button is enabled
/// only once media is up, so its enabled state is the assertion.
///
/// NEEDS a running local server started with LiveKit configured, and the SFU
/// itself:
///
///     docker compose --profile livekit up -d livekit
///     LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret pnpm dev
///     xcrun simctl privacy booted grant microphone gg.pqp.app
///
/// SKIPPED, not failed, against a mesh-only server: `GET /api/voice/backend`
/// is asked first, and a deployment that answers `mesh` has nothing for this
/// file to prove.
final class LiveKitJoinUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?
    private var serverName: String { seeded?.name ?? "" }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            Self.backend() == "livekit",
            "The local server is not configured for LiveKit; nothing to prove here"
        )
        seeded = TestSeed.createServer(self, prefix: "LiveKitJoin")
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        super.tearDown()
    }

    func testJoiningALiveKitRoomReachesConnected() {
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

        let mute = app.buttons["voice.mute"]
        XCTAssertTrue(mute.waitForExistence(timeout: 20), "Never reached the voice room")
        // `.joining` keeps the toolbar disabled. On LiveKit that state lasts
        // until the SFU room is connected and the microphone is published, so
        // an enabled button is the room, not the welcome.
        let connected = NSPredicate(format: "isEnabled == true")
        let expectation = XCTNSPredicateExpectation(predicate: connected, object: mute)
        XCTAssertEqual(
            XCTWaiter().wait(for: [expectation], timeout: 50), .completed,
            "The LiveKit room never came up; the app should have left with 'Could not reach the voice server'"
        )
        XCTAssertFalse(
            app.staticTexts["Connecting…"].exists,
            "Still 'Connecting' with an enabled toolbar: status and media disagree"
        )
        XCTAssertEqual(mute.label, "Mute")
    }

    /// A second participant, published straight into the SFU, shows up on the
    /// roster and is drawn. Proves the subscribe half: the participant is not in
    /// the WS roster (nothing joined `/ws`), so it renders under the SDK's name
    /// for it, or as "Someone" when it has none.
    ///
    /// SKIPPED unless something is going to provide that participant. Run with
    ///
    ///     TEST_RUNNER_PQP_TEST_LIVEKIT_PEER=bot xcodebuild test ...
    ///
    /// and, once `lk room list` shows the room, from another shell:
    ///
    ///     lk room join --url ws://localhost:7880 --api-key devkey --api-secret secret \
    ///        --identity bot --publish-demo <room>
    func testARemoteParticipantAppearsOnTheRoster() throws {
        let label = try XCTUnwrap(
            ProcessInfo.processInfo.environment["PQP_TEST_LIVEKIT_PEER"],
            "set PQP_TEST_LIVEKIT_PEER to the identity a second participant will join with"
        )
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        app.launchArguments += ["-pqp.lastVisited", "none"]
        app.launch()

        let server = app.staticTexts[serverName]
        _ = server.waitForExistence(timeout: 20)
        XCTAssertTrue(scrollIntoReach(server, in: app))
        server.tap()
        let lobby = app.staticTexts["Lobby"]
        XCTAssertTrue(lobby.waitForExistence(timeout: 10))
        lobby.tap()
        let mute = app.buttons["voice.mute"]
        XCTAssertTrue(mute.waitForExistence(timeout: 20))
        let connected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: mute
        )
        XCTAssertEqual(XCTWaiter().wait(for: [connected], timeout: 50), .completed)

        // The operator has up to two minutes to run `lk room join`.
        let someone = NSPredicate { _, _ in
            app.staticTexts[label].exists || app.staticTexts["Someone"].exists
        }
        let appeared = XCTNSPredicateExpectation(predicate: someone, object: nil)
        XCTAssertEqual(
            XCTWaiter().wait(for: [appeared], timeout: 120), .completed,
            "A participant published into the SFU never reached the roster"
        )
        // Left on screen for a moment so the run can be watched or captured.
        sleep(8)
        XCTAssertTrue(app.staticTexts[label].exists || app.staticTexts["Someone"].exists)
    }

    /// `GET /api/voice/backend`, so the file can skip itself on a mesh server.
    private static func backend() -> String? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)/api/voice/backend")!)
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
        let done = DispatchSemaphore(value: 0)
        var backend: String?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                backend = json["backend"] as? String
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        return backend
    }

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
}
