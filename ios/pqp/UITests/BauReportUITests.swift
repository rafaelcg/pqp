import XCTest

/// Report a Baú post and a Baú comment, then block a commenter, as a phone user
/// does it (App Store guideline 1.2: every kind of user content is reportable in
/// two taps). The post's ellipsis, Report, a reason, Send; the same on a comment.
///
/// SEEDS ITS OWN SERVER over HTTP as three dev-bypass accounts (CLAUDE.md,
/// "A second local user"): `bob` owns a community-home server and publishes a
/// post, `carol` and `bob` comment under it, and the app runs as `alice`, who
/// joins by invite. Needs a local API started with `COMMUNITY_HOME_ENABLED=true`
/// and `DEV_AUTH_BYPASS=true`; SKIPS when the Baú is off or no API answers. Like
/// the rest of `pqpUITests` it is not run in CI. Locally:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3115 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/bau-report-shots \
///     xcodebuild test -only-testing:pqpUITests/BauReportUITests …
final class BauReportUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func call(_ user: String, _ method: String, _ path: String, _ body: [String: Any]? = nil) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(TestSeed.token(user))", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let done = XCTestExpectation(description: "\(method) \(path)")
        nonisolated(unsafe) var result: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    /// A Baú with one published post by bob, and a comment each from carol and bob.
    private func seedBau() throws -> (serverId: String, postId: String) {
        guard (call("bob", "GET", "/api/community-home/config")) != nil else {
            throw XCTSkip("No API at \(TestSeed.apiBase)")
        }
        for user in ["alice", "bob", "carol"] {
            TestSeed.passAgeGate(self, devUser: user)
        }
        guard let config = call("alice", "GET", "/api/community-home/config"),
              config["enabled"] as? Bool == true else {
            throw XCTSkip("The Baú is off on \(TestSeed.apiBase) (COMMUNITY_HOME_ENABLED)")
        }
        let name = "Baú QA \(Int.random(in: 100_000...999_999))"
        let serverId = (call("bob", "POST", "/api/servers", ["name": name])?["server"] as? [String: Any])?["id"] as? String
        let serverIdValue = try XCTUnwrap(serverId, "could not seed a server")
        _ = call("bob", "PATCH", "/api/servers/\(serverIdValue)/home/config", ["enabled": true])
        let invite = (call("bob", "POST", "/api/servers/\(serverIdValue)/invites", ["expiresInHours": 168])?["invite"]
            as? [String: Any])?["code"] as? String
        let code = try XCTUnwrap(invite)
        _ = call("alice", "POST", "/api/invites/\(code)/join")
        _ = call("carol", "POST", "/api/invites/\(code)/join")
        let post = call("bob", "POST", "/api/servers/\(serverIdValue)/home/posts", [
            "title": "Welcome to the Baú",
            "body": "First post of the season. Be kind in the comments.",
            "visibility": "free",
            "status": "published",
        ])
        let postId = try XCTUnwrap((post?["post"] as? [String: Any])?["id"] as? String, "could not seed a post")
        _ = call("carol", "POST", "/api/servers/\(serverIdValue)/home/posts/\(postId)/comments",
                 ["body": "Looks great, thanks for sharing."])
        _ = call("bob", "POST", "/api/servers/\(serverIdValue)/home/posts/\(postId)/comments",
                 ["body": "Glad you like it."])
        return (serverIdValue, postId)
    }

    /// Text inside the post card, found by label on any element type: the
    /// card's own identifier hides its children from `staticTexts`.
    private func item(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", label)).firstMatch
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    /// Every "More" ellipsis on the screen, the post's first and then one per
    /// comment (the card's own identifier hides its children's, as in
    /// `BauShareUITests`, so they are found by label).
    private func menus(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label IN %@", ["More", "Mais"]))
    }

    private func sendReport(_ app: XCUIApplication, subject: String, shot: String) {
        XCTAssertTrue(app.staticTexts[subject].waitForExistence(timeout: 8), "the sheet names what is reported")
        app.buttons["Spam"].tap()
        snap(app, "\(shot)-sheet")
        app.buttons["Send report"].tap()
        XCTAssertTrue(app.staticTexts["Report sent"].waitForExistence(timeout: 10), "the confirmation is the same one")
        snap(app, "\(shot)-sent")
        app.buttons["Done"].tap()
    }

    func testAPostAndACommentCanBeReportedInTwoTapsAndACommenterBlocked() throws {
        let seeded = try seedBau()

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchEnvironment["PQP_DEV_USER"] = "alice"
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()

        XCTAssertTrue(app.openServerFromHub(seeded.serverId))
        let bau = app.buttons["channels.bau"].firstMatch
        XCTAssertTrue(bau.waitForExistence(timeout: 15), "The server has a Baú")
        bau.tap()

        XCTAssertTrue(item(app, "Welcome to the Baú").waitForExistence(timeout: 15))
        // The card shows the author's replies first; the rest is "See all".
        let seeAll = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'See all'")).firstMatch
        XCTAssertTrue(seeAll.waitForExistence(timeout: 5))
        seeAll.tap()
        XCTAssertTrue(item(app, "Looks great, thanks for sharing.").waitForExistence(timeout: 8))

        // The post: ellipsis, Report.
        let all = menus(app)
        XCTAssertGreaterThanOrEqual(all.count, 3, "one menu on the post and one on each comment")
        all.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["Report"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Block"].exists, "Block is offered beside Report")
        snap(app, "ios-01-post-menu")
        app.buttons["Report"].tap()
        sendReport(app, subject: "Report a post by Dev User bob", shot: "ios-02-post-report")

        // A comment (carol's, the first): ellipsis, Report.
        XCTAssertTrue(item(app, "Looks great, thanks for sharing.").waitForExistence(timeout: 5))
        menus(app).element(boundBy: 1).tap()
        XCTAssertTrue(app.buttons["Report"].waitForExistence(timeout: 5))
        snap(app, "ios-03-comment-menu")
        app.buttons["Report"].tap()
        sendReport(app, subject: "Report a comment by Dev User carol", shot: "ios-04-comment-report")

        // Block the commenter from the same menu: her comment goes at once,
        // bob's stays, and the question is the same one every surface asks.
        XCTAssertTrue(item(app, "Looks great, thanks for sharing.").waitForExistence(timeout: 5))
        menus(app).element(boundBy: 1).tap()
        XCTAssertTrue(app.buttons["Block"].waitForExistence(timeout: 5))
        app.buttons["Block"].tap()
        let dialog = app.buttons.matching(identifier: "Block")
        XCTAssertTrue(dialog.firstMatch.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 0.8)
        snap(app, "ios-05-block-confirm")
        dialog.element(boundBy: dialog.count - 1).tap()

        let gone = item(app, "Looks great, thanks for sharing.")
        let deadline = Date().addingTimeInterval(5)
        while gone.exists, Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
        XCTAssertFalse(gone.exists, "a blocked person's comment leaves the card at once")
        XCTAssertTrue(item(app, "Glad you like it.").exists, "somebody who was not blocked stays")
        snap(app, "ios-06-after-block")
    }
}
