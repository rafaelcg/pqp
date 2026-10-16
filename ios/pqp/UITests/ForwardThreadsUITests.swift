import XCTest

/// Encaminhar: a thread is a place a forward can go. The picker lists the
/// server's threads after its channels with `#parent · server` under the name,
/// a search finds one by its parent channel, and the send goes to the thread
/// like to any channel.
///
/// NEEDS an API started with `FORWARD_MESSAGES=true` and `COMMUNITY_HOME_ENABLED`,
/// two servers "Fonte QA" (its Baú holding a published post) and "Destino QA"
/// with a thread under #general named "duvida do patch", and SKIPS without them.
/// Not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/forward-shots \
///     xcodebuild test -only-testing:pqpUITests/ForwardThreadsUITests …
final class ForwardThreadsUITests: XCTestCase {
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

    func testAThreadIsAnEncaminharDestination() throws {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]],
              let fonte = servers.first(where: { $0["name"] as? String == "Fonte QA" })?["id"] as? String,
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String,
              get("/api/forwards/config")?["enabled"] as? Bool == true,
              let threads = get("/api/servers/\(destino)/forward-destinations")?["threads"] as? [[String: Any]],
              let thread = threads.first(where: { $0["name"] as? String == "duvida do patch" }),
              let threadId = thread["id"] as? String
        else { throw XCTSkip("No forward flag, or no thread in Destino QA, on \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        XCTAssertTrue(app.openServerFromHub(fonte))
        let bau = app.buttons["channels.bau"].firstMatch
        XCTAssertTrue(bau.waitForExistence(timeout: 15))
        bau.tap()
        // The card's own `bau.post` identifier wins over its children's, so the
        // menu is found by its label.
        let menu = app.buttons.matching(NSPredicate(format: "label IN %@", ["More", "Mais"])).firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 15), "A published Baú post with the Encaminhar flag on has its menu")
        menu.tap()
        let forward = app.buttons.matching(NSPredicate(format: "label IN %@", ["Forward", "Encaminhar"])).firstMatch
        XCTAssertTrue(forward.waitForExistence(timeout: 5))
        forward.tap()
        XCTAssertTrue(app.otherElements["forward.picker"].waitForExistence(timeout: 10))

        let search = app.textFields["forward.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("general")
        let row = app.buttons["forward.row.\(threadId)"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), "The thread is listed, found by its parent channel's name")
        shot(app, "01-thread-in-picker")
        XCTAssertTrue(row.label.contains("duvida do patch"), "Its own name: \(row.label)")
        XCTAssertTrue(row.label.contains("#general"), "and the channel it hangs off: \(row.label)")

        row.tap()
        let send = app.buttons["forward.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        XCTAssertTrue(app.otherElements["forward.toast"].waitForExistence(timeout: 20) || app.buttons["forward.toast.view"].waitForExistence(timeout: 5), "Sent")
        shot(app, "02-sent")

        let page = get("/api/channels/\(threadId)/messages")?["messages"] as? [[String: Any]] ?? []
        XCTAssertTrue(page.contains { $0["forward"] != nil }, "The forward card is in the thread")
    }
}
