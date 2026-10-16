import XCTest

/// Unread channel messages on the server list: a server with something new
/// lights its tile (and says so to VoiceOver), a mention says "@N", opening the
/// channel clears it, and a message that arrives while the list is up lights it
/// again, live.
///
/// NEEDS two servers the dev user is in, "Fonte QA" holding one unread message
/// that names them and "Destino QA" holding unread messages, both from a second
/// account (seed with the WebSocket: join the channel, send `message-create`),
/// and SKIPS when they are not. For the live half the test writes
/// `/tmp/pqp-unread-ready` once the tile is clear and waits for a message sent
/// by hand after that. Like the rest of `pqpUITests` it is not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/unread-shots \
///     xcodebuild test -only-testing:pqpUITests/ServerUnreadUITests …
final class ServerUnreadUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func get(_ path: String) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
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

    /// The tile (rail) or the row (Servidores tab) of a server.
    private func tile(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let rail = app.buttons["hub.server.\(id)"]
        return rail.exists ? rail : app.buttons["servers.server.\(id)"]
    }

    private func value(of element: XCUIElement) -> String {
        (element.value as? String) ?? ""
    }

    private func waitForValue(_ element: XCUIElement, timeout: TimeInterval, _ matches: @escaping (String) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if matches(value(of: element)) { return true }
            Thread.sleep(forTimeInterval: 1)
        }
        return false
    }

    func testTheServerListLightsClearsAndLightsAgainLive() throws {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]],
              let fonte = servers.first(where: { $0["name"] as? String == "Fonte QA" })?["id"] as? String,
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String
        else { throw XCTSkip("No Fonte QA / Destino QA on \(TestSeed.apiBase)") }
        func unreadCount(_ server: String) -> Int {
            let rows = get("/api/servers/\(server)/unread")?["unread"] as? [[String: Any]] ?? []
            return rows.reduce(0) { $0 + ($1["count"] as? Int ?? 0) }
        }
        guard unreadCount(fonte) > 0, unreadCount(destino) > 0 else {
            throw XCTSkip("Seed unread messages from a second account in both servers first")
        }
        TestSeed.passAgeGate(self)
        try? FileManager.default.removeItem(atPath: "/tmp/pqp-unread-ready")

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if let language = ProcessInfo.processInfo.environment["PQP_QA_LANGUAGE"] {
            app.launchArguments += ["-AppleLanguages", "(\(language))"]
        }
        app.launch()

        // 1. Both tiles light after the hydration read: Destino as unread,
        //    Fonte with its mention.
        XCTAssertTrue(tile(app, destino).waitForExistence(timeout: 20))
        XCTAssertTrue(
            waitForValue(tile(app, destino), timeout: 30) { !$0.isEmpty },
            "A server with unread messages lights its tile without being opened"
        )
        XCTAssertTrue(waitForValue(tile(app, fonte), timeout: 30) { !$0.isEmpty })
        shot(app, "01-hub-lit")
        print("UNREAD destino=\(value(of: tile(app, destino))) fonte=\(value(of: tile(app, fonte)))")
        XCTAssertTrue(
            value(of: tile(app, fonte)).contains("1"),
            "The mention is counted: '\(value(of: tile(app, fonte)))'"
        )

        // 2. Open Destino and read its channel; back on the hub the tile is clear.
        XCTAssertTrue(app.openServerFromHub(destino))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.tap()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 15) || app.staticTexts["oi da bob 1"].waitForExistence(timeout: 15))
        sleep(2)
        app.navigationBars.buttons.firstMatch.tap()
        sleep(1)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(tile(app, destino).waitForExistence(timeout: 15))
        XCTAssertTrue(
            waitForValue(tile(app, destino), timeout: 20) { $0.isEmpty },
            "Reading the channel clears the server's tile"
        )
        shot(app, "02-hub-cleared")

        // 3. Live: a message that arrives while the hub is up lights it again.
        try "ready".write(toFile: "/tmp/pqp-unread-ready", atomically: true, encoding: .utf8)
        XCTAssertTrue(
            waitForValue(tile(app, destino), timeout: 120) { !$0.isEmpty },
            "A message that arrives while the list is up lights the tile live"
        )
        shot(app, "03-hub-live")
    }
}
