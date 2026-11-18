import XCTest

/// Blocking, as a phone user does it (App Store guideline 1.2): long-press an
/// abusive message, Block, and the person is gone from the channel at once, a
/// message they send a second later never shows, and their DM leaves the list.
///
/// Needs a SEEDED local server rather than creating its own, because it needs
/// three people (the app's user, the one blocked, a bystander) and the blocked
/// one has to talk over a socket while the app is open. Environment:
///
///   TEST_RUNNER_PQP_TEST_API_BASE   the server (default localhost:3001)
///   TEST_RUNNER_PQP_BLOCK_SERVER    the seeded server's name
///   TEST_RUNNER_PQP_BLOCK_CHANNEL   the seeded text channel's id (for the live frame)
///   TEST_RUNNER_PQP_BLOCK_SHOTS     a directory to write screenshots to (optional)
///
/// The app signs in as dev user `alice` and the blocked person is `bob`; both
/// are the dev-bypass suffix accounts described in CLAUDE.md. Skipped when the
/// variables are not set, so a plain `xcodebuild test` is unaffected.
final class BlockUITests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    private func shot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = env["PQP_BLOCK_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(name).png"))
    }

    /// `bob` says something over the socket, the way another phone would.
    ///
    /// Plain completion handlers and a blocking wait on the test thread, with no
    /// Task and no actor hop: a detached Task capturing the expectation tripped
    /// the region-based isolation checker on CI's Xcode.
    private func bobSays(_ text: String, in channelId: String) {
        guard let base = env["PQP_TEST_API_BASE"],
              let url = URL(string: base.replacingOccurrences(of: "http", with: "ws") + "/ws")
        else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        func send(_ object: [String: Any]) {
            guard let data = try? JSONSerialization.data(withJSONObject: object),
                  let string = String(data: data, encoding: .utf8) else { return }
            let sent = DispatchSemaphore(value: 0)
            task.send(.string(string)) { _ in sent.signal() }
            _ = sent.wait(timeout: .now() + 5)
        }
        send(["type": "auth", "token": "dev-local-token:bob"])
        Thread.sleep(forTimeInterval: 1)
        send(["type": "join-channel", "channelId": channelId])
        Thread.sleep(forTimeInterval: 0.6)
        send(["type": "message-create", "channelId": channelId, "body": text,
              "nonce": "n\(Int.random(in: 1...999_999))"])
        Thread.sleep(forTimeInterval: 1)
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func tapBlockInDialog(_ app: XCUIApplication) {
        let candidates = app.buttons.matching(identifier: "Block")
        XCTAssertTrue(candidates.firstMatch.waitForExistence(timeout: 5))
        // The menu row is dismissing while the dialog rises; the dialog's
        // button is the last "Block" in the tree.
        Thread.sleep(forTimeInterval: 0.8)
        candidates.element(boundBy: candidates.count - 1).tap()
    }

    func testBlockingFromAMessageHidesThePersonEverywhereAtOnce() throws {
        try XCTSkipUnless(env["PQP_BLOCK_SERVER"] != nil && env["PQP_BLOCK_CHANNEL"] != nil,
                          "needs the seeded server (see the header)")
        let serverName = env["PQP_BLOCK_SERVER"]!
        let channelId = env["PQP_BLOCK_CHANNEL"]!
        continueAfterFailure = false

        let app = XCUIApplication()
        app.launchEnvironment["PQP_DEV_USER"] = "alice"
        if let base = env["PQP_TEST_API_BASE"] { app.launchEnvironment["PQP_API_OVERRIDE"] = base }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO", "-pqp.lastVisited", "none"]
        app.launch()
        XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 8))
        app.buttons["welcome.start"].tap()

        // The hub, with the DM from the person about to be blocked.
        let dmRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'hub.conversation.'")).firstMatch
        _ = dmRow.waitForExistence(timeout: 10)
        Thread.sleep(forTimeInterval: 1.0)
        shot(app, "01-hub-before-block")
        XCTAssertTrue(dmRow.exists, "the DM from bob should be on the hub before the block")

        let server = app.staticTexts[serverName]
        XCTAssertTrue(server.waitForExistence(timeout: 10))
        server.tap()
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 8))
        app.staticTexts["general"].tap()

        let abusive = app.staticTexts["Bob here: this is an abusive message from the person who will be blocked"]
        XCTAssertTrue(abusive.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Carol here: a perfectly friendly message that must stay visible"].exists)
        Thread.sleep(forTimeInterval: 0.8)
        shot(app, "02-channel-before-block")

        abusive.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["messageActions.quick0"].waitForExistence(timeout: 5))
        shot(app, "03-long-press-menu-with-block")
        app.buttons["Block"].tap()

        Thread.sleep(forTimeInterval: 0.8)
        shot(app, "04-confirm-block")
        tapBlockInDialog(app)

        // Gone at once: no reload, no reconnect.
        let deadline = Date().addingTimeInterval(4)
        while abusive.exists, Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
        shot(app, "05-channel-after-block")
        XCTAssertFalse(abusive.exists, "the blocked person's message must leave the transcript at once")
        XCTAssertFalse(app.staticTexts["Bob again: a second abusive line"].exists)
        XCTAssertTrue(app.staticTexts["Carol here: a perfectly friendly message that must stay visible"].exists,
                      "somebody who was not blocked stays")
        XCTAssertTrue(app.staticTexts["Alice here: my own message in the channel"].exists)

        // A message they send NOW, over the socket, to an open channel.
        let live = "Bob live: sent after the block while the channel is open"
        bobSays(live, in: channelId)
        Thread.sleep(forTimeInterval: 1.0)
        shot(app, "06-channel-after-live-message-from-blocked")
        XCTAssertFalse(app.staticTexts[live].exists, "a live frame from a blocked person must not draw")

        // Back to the hub: their DM has left the list.
        // Channel, then the server's channel list, then the hub.
        app.navigationBars.buttons.firstMatch.tap()
        Thread.sleep(forTimeInterval: 0.8)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.staticTexts[serverName].waitForExistence(timeout: 8), "back on the hub")
        Thread.sleep(forTimeInterval: 1.0)
        shot(app, "07-hub-after-block")
        XCTAssertFalse(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'hub.conversation.'")).firstMatch.exists,
            "the 1:1 with a blocked person must leave the list"
        )
    }
}
