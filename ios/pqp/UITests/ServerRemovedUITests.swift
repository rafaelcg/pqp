import XCTest

/// A server this account is removed from leaves the phone at once: the screens
/// of that server close (the channel list, and a chat above it), the tile goes,
/// and one sentence says why.
///
/// NEEDS "Destino QA" owned by the dev user, with a second account
/// `dev-local-token:bob` as a member (see `ServerUnreadUITests`), and SKIPS
/// without it. The test kicks bob from the dev account over HTTP while the app
/// runs as bob. Not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/removed-shots \
///     xcodebuild test -only-testing:pqpUITests/ServerRemovedUITests …
final class ServerRemovedUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: [String: Any]? = nil, as devUser: String? = nil) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(TestSeed.token(devUser))", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        let done = XCTestExpectation(description: path)
        nonisolated(unsafe) var result: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "\(directory)/\(name).png"))
        }
    }

    /// `own-status`: a status picked on another device shows on the You screen
    /// without reopening it.
    func testAStatusPickedOnAnotherDeviceShowsOnTheYouScreen() throws {
        guard send("GET", "/api/me") != nil else { throw XCTSkip("No API at \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)
        send("PATCH", "/api/me/preferences", body: ["status": "online"])
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        let dock = app.staticTexts["Dev User"].firstMatch
        XCTAssertTrue(dock.waitForExistence(timeout: 20), "The profile dock")
        dock.tap()
        let online = app.staticTexts["Online"].firstMatch
        XCTAssertTrue(online.waitForExistence(timeout: 10), "The You screen starts on Online")
        shot(app, "10-status-online")
        sleep(2)
        // Another device picks Do not disturb.
        send("PATCH", "/api/me/preferences", body: ["status": "dnd"])
        XCTAssertTrue(app.staticTexts["Do not disturb"].firstMatch.waitForExistence(timeout: 20), "The menu follows the other device")
        shot(app, "11-status-dnd")
        send("PATCH", "/api/me/preferences", body: ["status": "online"])
    }

    func testBeingKickedClosesTheServerWhereverThePersonIs() throws {
        guard let servers = send("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String,
              let bobId = send("GET", "/api/me", as: "bob")?["id"] as? String
        else { throw XCTSkip("No Destino QA or no second account on \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)
        TestSeed.passAgeGate(self, devUser: "bob")

        func rejoin() {
            guard let code = (send("POST", "/api/servers/\(destino)/invites")?["invite"] as? [String: Any])?["code"] as? String else { return }
            send("POST", "/api/invites/\(code)/join", body: [:], as: "bob")
        }
        // Bob is in the server to start with.
        rejoin()

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchEnvironment["PQP_DEV_USER"] = "bob"
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()

        // 1. In the channel list.
        XCTAssertTrue(app.openServerFromHub(destino))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        shot(app, "01-in-the-list")
        send("DELETE", "/api/servers/\(destino)/members/\(bobId)")
        let tile = app.buttons["hub.server.\(destino)"]
        XCTAssertTrue(general.waitForNonExistence(timeout: 20), "The server's screen closes itself")
        shot(app, "02-after-kick-in-list")
        XCTAssertTrue(app.staticTexts["hub.removalNotice"].waitForExistence(timeout: 10), "and says why")
        XCTAssertFalse(tile.exists, "The tile is gone")
        shot(app, "02-after-kick-in-list")

        // 2. Inside a channel, one screen deeper.
        rejoin()
        app.terminate()
        app.launch()
        XCTAssertTrue(app.openServerFromHub(destino))
        let again = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(again.waitForExistence(timeout: 15))
        again.tap()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 15) || app.staticTexts.firstMatch.waitForExistence(timeout: 15))
        sleep(2)
        shot(app, "03-in-the-chat")
        send("DELETE", "/api/servers/\(destino)/members/\(bobId)")
        XCTAssertTrue(app.buttons["hub.server.\(destino)"].waitForNonExistence(timeout: 20), "The tile goes")
        XCTAssertTrue(app.staticTexts["hub.removalNotice"].waitForExistence(timeout: 10), "the hub says why: the chat above the list was closed too")
        shot(app, "04-after-kick-in-chat")

        // Leave things as they were.
        rejoin()
    }
}
