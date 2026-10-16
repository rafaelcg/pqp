import XCTest

/// Typing `@` in a channel offers the members; a tap puts `@username ` in the
/// draft in place of the half-typed token.
///
/// NEEDS "Destino QA" with a second account `dev-local-token:bob` as a member
/// (username `dev_user_bob`); SKIPS without it. Not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/mention-shots \
///     xcodebuild test -only-testing:pqpUITests/MentionAutocompleteUITests …
final class MentionAutocompleteUITests: XCTestCase {
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

    func testAnAtOffersTheMembersAndATapInsertsTheUsername() throws {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]],
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String,
              let members = get("/api/servers/\(destino)/members")?["members"] as? [[String: Any]],
              members.contains(where: { $0["username"] as? String == "dev_user_bob" })
        else { throw XCTSkip("No Destino QA with bob on \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        XCTAssertTrue(app.openServerFromHub(destino))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.tap()

        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15), "The composer")
        field.tap()
        field.typeText("oi @dev_user_b")
        let suggestion = app.buttons["mention.suggestion.dev_user_bob"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 15), "Bob is offered")
        shot(app, "01-suggestions")
        XCTAssertFalse(app.buttons["mention.suggestion.dev_user"].exists, "You are not offered to yourself")
        suggestion.tap()
        let value = (field.value as? String) ?? ""
        XCTAssertEqual(value, "oi @dev_user_bob ", "The token is replaced by the username and a space")
        XCTAssertFalse(app.buttons["mention.suggestion.dev_user_bob"].exists, "The strip closes once it is used")
        shot(app, "02-inserted")
    }
}
