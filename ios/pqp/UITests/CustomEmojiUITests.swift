import XCTest

/// A custom server emoji in a message is the picture, not `<:name:id>` markup.
///
/// NEEDS an API with storage (MinIO), an emoji named `party` uploaded to Destino
/// QA and a message from a second account in its #general carrying
/// `<:party:ID>` (see the PR for the recipe); SKIPS without it. Not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/emoji-shots \
///     xcodebuild test -only-testing:pqpUITests/CustomEmojiUITests …
final class CustomEmojiUITests: XCTestCase {
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

    func testACustomEmojiIsAPictureNotMarkup() throws {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]],
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String,
              let channels = get("/api/servers/\(destino)/channels")?["channels"] as? [[String: Any]],
              let channel = channels.first(where: { $0["name"] as? String == "general" })?["id"] as? String,
              let messages = get("/api/channels/\(channel)/messages")?["messages"] as? [[String: Any]],
              messages.contains(where: { ($0["body"] as? String)?.contains("<:party:") == true })
        else { throw XCTSkip("No message with a custom emoji on \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        XCTAssertTrue(app.openServerFromHub(destino))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.tap()

        let spoken = app.staticTexts.matching(NSPredicate(format: "label CONTAINS ':party:'")).firstMatch
        XCTAssertTrue(spoken.waitForExistence(timeout: 20), "The message reads with the emoji's name")
        sleep(3)
        app.swipeUp()
        sleep(1)
        shot(app, "01-custom-emoji")
        XCTAssertFalse(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS '<:party:'")).firstMatch.exists,
            "No markup on screen"
        )
    }
}
