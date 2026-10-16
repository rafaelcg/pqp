import XCTest

/// "Load earlier messages" must not move what the reader was looking at: the
/// message under the button stays where it was when the older page lands above.
///
/// NEEDS a channel with more than one page of history: it looks for a server
/// the dev user is in named "Destino QA" whose #general holds messages whose
/// body starts "Mensagem numero" (seed them with SQL on a scratch database) and
/// SKIPS otherwise. Like the rest of `pqpUITests` it is not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/earlier-shots \
///     xcodebuild test -only-testing:pqpUITests/ChatEarlierUITests …
final class ChatEarlierUITests: XCTestCase {
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

    /// The top-most "Mensagem numero N" fully on screen, and where it is.
    private func topMessage(_ app: XCUIApplication) -> (label: String, y: CGFloat)? {
        let rows = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Mensagem numero'")).allElementsBoundByIndex
        let window = app.windows.firstMatch.frame
        let visible = rows.filter { $0.frame.minY > window.minY + 120 && $0.frame.maxY < window.maxY - 120 && $0.frame.height > 0 }
        guard let top = visible.min(by: { $0.frame.minY < $1.frame.minY }) else { return nil }
        return (top.label, top.frame.minY)
    }

    func testLoadingEarlierMessagesKeepsTheReadersPlace() throws {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]],
              let serverId = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String,
              let channels = get("/api/servers/\(serverId)/channels")?["channels"] as? [[String: Any]],
              let channelId = channels.first(where: { $0["name"] as? String == "general" })?["id"] as? String,
              let page = get("/api/channels/\(channelId)/messages"),
              page["hasMore"] as? Bool == true
        else { throw XCTSkip("No Destino QA #general with more than one page of history on \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        XCTAssertTrue(app.openServerFromHub(serverId))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.tap()

        let earlier = app.buttons["Load earlier messages"].firstMatch
        var swipes = 0
        while !(earlier.exists && earlier.isHittable) && swipes < 30 {
            app.swipeDown(velocity: .fast)
            swipes += 1
        }
        XCTAssertTrue(earlier.exists, "The button is at the top of the transcript")
        // Settle: a fast swipe still coasts.
        Thread.sleep(forTimeInterval: 1.0)
        // Bring the button to the middle so there is something above it to
        // arrive in, and a first message below to watch.
        shot(app, "01-before")
        guard let before = topMessage(app) else { return XCTFail("No message visible under the button") }

        earlier.tap()
        Thread.sleep(forTimeInterval: 2.0)
        shot(app, "02-after")

        let same = app.staticTexts[before.label].firstMatch
        XCTAssertTrue(same.exists, "\(before.label) is still in the transcript")
        let moved = abs(same.frame.minY - before.y)
        print("EARLIER before=\(before.y) after=\(same.frame.minY) moved=\(moved)")
        // Put back at the top edge of the transcript, not the button's exact
        // row: what matters is that it is still on screen, not 50 messages away.
        XCTAssertLessThan(moved, 200, "The message the reader was on stays in view (moved \(moved) pt)")
    }
}
