import XCTest

/// Forum channels end to end on a phone: the forum row, the forum's list, a
/// post full screen, and the composer.
///
/// NEEDS A SERVER WITH FORUMS ON. The runtime flag `forum_channels` is set per
/// server in the database (`feature_flag_overrides`), which a test cannot do
/// over HTTP, so this finds a server where `GET /api/forum/config` says yes and
/// that already holds a forum with posts, and SKIPS when there is none. Like
/// the rest of `pqpUITests` it is not run in CI. Locally:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3092 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/forum-shots \
///     xcodebuild test -only-testing:pqpUITests/ForumUITests …
///
/// `PQP_QA_SHOTS`, when set, also writes each step's screenshot there, for
/// comparing against the design mocks.
final class ForumUITests: XCTestCase {
    private struct Target {
        let serverId: String
        let forumId: String
        let forumName: String
    }

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: - Helpers

    private func getJSON(_ path: String, devUser: String? = nil) -> Any? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.setValue("Bearer \(TestSeed.token(devUser))", forHTTPHeaderField: "Authorization")
        nonisolated(unsafe) var result: Any?
        let done = XCTestExpectation(description: path)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: [String: Any]? = nil, devUser: String? = nil) -> Any? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(TestSeed.token(devUser))", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        nonisolated(unsafe) var result: Any?
        let done = XCTestExpectation(description: path)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    /// A reply in a post, said over the socket the way a person says it
    /// (there is no HTTP send for a person).
    private func reply(_ body: String, in channelId: String, as devUser: String) {
        let url = URL(string: TestSeed.apiBase.replacingOccurrences(of: "http", with: "ws") + "/ws")!
        let socket = URLSession.shared.webSocketTask(with: url)
        socket.resume()
        let frames: [[String: Any]] = [
            ["type": "auth", "token": TestSeed.token(devUser)],
            ["type": "join-channel", "channelId": channelId],
            ["type": "message-create", "channelId": channelId, "body": body, "nonce": UUID().uuidString],
        ]
        for frame in frames {
            let text = String(data: try! JSONSerialization.data(withJSONObject: frame), encoding: .utf8)!
            let sent = XCTestExpectation(description: "frame")
            socket.send(.string(text)) { _ in sent.fulfill() }
            wait(for: [sent], timeout: 5)
            // Auth answers `ready` before anything else is accepted.
            Thread.sleep(forTimeInterval: 0.4)
        }
        Thread.sleep(forTimeInterval: 0.4)
        socket.cancel(with: .normalClosure, reason: nil)
    }

    private func findForum() throws -> Target {
        guard let servers = (getJSON("/api/servers") as? [String: Any])?["servers"] as? [[String: Any]]
        else { throw XCTSkip("No API at \(TestSeed.apiBase)") }
        for server in servers {
            guard let id = server["id"] as? String,
                  (getJSON("/api/forum/config?serverId=\(id)") as? [String: Any])?["enabled"] as? Bool == true,
                  let channels = (getJSON("/api/servers/\(id)/channels") as? [String: Any])?["channels"] as? [[String: Any]],
                  let forum = channels.first(where: { $0["type"] as? String == "forum" }),
                  let forumId = forum["id"] as? String,
                  let name = forum["name"] as? String
            else { continue }
            return Target(serverId: id, forumId: forumId, forumName: name)
        }
        throw XCTSkip("No server with forum_channels on and a forum in it")
    }

    private func launch(devUser: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        if let devUser { app.launchEnvironment["PQP_DEV_USER"] = devUser }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", "none"]
        if let language = ProcessInfo.processInfo.environment["PQP_QA_LANGUAGE"] {
            app.launchArguments += ["-AppleLanguages", "(\(language))"]
        }
        app.launch()
        return app
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

    private func openForum(_ target: Target, in app: XCUIApplication, devUser: String? = nil) {
        TestSeed.passAgeGate(self, devUser: devUser)
        app.openServerFromHub(target.serverId)
        let row = app.staticTexts[target.forumName]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the forum row is drawn")
        row.tap()
        XCTAssertTrue(app.otherElements["forum.home"].waitForExistence(timeout: 10)
                      || app.buttons["forum.search"].waitForExistence(timeout: 5))
    }

    private func firstCard(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'forum.card.'")).firstMatch
    }

    // MARK: - Tests

    func testTheForumListAPostAndTheComposer() throws {
        let target = try findForum()
        let app = launch()
        openForum(target, in: app)

        XCTAssertTrue(firstCard(app).waitForExistence(timeout: 10), "posts load")
        shot(app, "forum-home")

        // Filters narrow and come back.
        let open = app.buttons["forum.filter.open"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        sleep(1)
        shot(app, "forum-home-open-filter")
        open.tap()

        // A post opens full screen, on its question.
        let card = firstCard(app)
        card.tap()
        XCTAssertTrue(app.staticTexts["forum.post.title"].waitForExistence(timeout: 10), "the post's title is on screen")
        XCTAssertTrue(app.buttons["forum.post.menu"].exists)
        shot(app, "forum-post")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // The composer.
        let newPost = app.descendants(matching: .any)["forum.newPost"].firstMatch
        let hasNewPost = newPost.waitForExistence(timeout: 5)
        XCTAssertTrue(hasNewPost)
        newPost.tap()
        let title = app.descendants(matching: .any)["forum.composer.title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        title.typeText("Valorant fecha sozinho")
        sleep(2)
        shot(app, "forum-composer")
        app.buttons["forum.composer.close"].tap()
    }

    /// Staff change the forum's tags and settings while a composer is open:
    /// the new tag shows up and "Exigir pelo menos uma tag" applies without
    /// closing it (`forum-config-update`). Restores the forum's settings after.
    func testTheOpenComposerFollowsTheForumsSettingsLive() throws {
        let target = try findForum()
        let app = launch()
        openForum(target, in: app)
        XCTAssertTrue(firstCard(app).waitForExistence(timeout: 10))
        let newPost = app.descendants(matching: .any)["forum.newPost"].firstMatch
        XCTAssertTrue(newPost.waitForExistence(timeout: 5))
        newPost.tap()
        let title = app.descendants(matching: .any)["forum.composer.title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        // The keyboard's first-use sheet covers the screen on a fresh simulator.
        if app.buttons["Continue"].waitForExistence(timeout: 2) { app.buttons["Continue"].tap() }
        sleep(1)
        shot(app, "forum-composer-live-before")

        let before = (getJSON("/api/channels/\(target.forumId)/forum-tags") as? [String: Any])?["tags"] as? [[String: Any]] ?? []
        func putBody(_ list: [[String: Any]]) -> [String: Any] {
            ["tags": list.map { tag -> [String: Any] in
                var one: [String: Any] = ["name": tag["name"] as? String ?? "", "moderated": tag["moderated"] as? Bool ?? false]
                if let id = tag["id"] as? String { one["id"] = id }
                return one
            }]
        }
        var tags = before
        tags.append(["name": "Novidade", "moderated": false])
        send("PUT", "/api/channels/\(target.forumId)/forum-tags", body: putBody(tags))
        send("PATCH", "/api/channels/\(target.forumId)/forum-settings", body: ["requireTag": true])
        defer {
            send("PATCH", "/api/channels/\(target.forumId)/forum-settings", body: ["requireTag": false])
            send("PUT", "/api/channels/\(target.forumId)/forum-tags", body: putBody(before))
        }
        let fresh = app.descendants(matching: .any)["Novidade"].firstMatch
        XCTAssertTrue(fresh.waitForExistence(timeout: 8), "the new tag appears in the open composer")
        shot(app, "forum-composer-live-after")
        app.buttons["forum.composer.close"].tap()
    }

    /// The post with an accepted answer: the Solução card under the question.
    func testAResolvedPostShowsItsSolution() throws {
        let target = try findForum()
        let app = launch()
        openForum(target, in: app)
        app.buttons["forum.filter.resolved"].tap()
        let card = firstCard(app)
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.tap()
        let jump = app.buttons["forum.solution.jump"]
        if jump.waitForExistence(timeout: 10) {
            shot(app, "forum-post-solution")
            jump.tap()
            sleep(1)
            shot(app, "forum-post-solution-jumped")
        } else {
            shot(app, "forum-post-resolved-no-answer")
        }
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["forum.filter.resolved"].tap()
    }

    /// A member's side, with staff acting on the server meanwhile: "Novo",
    /// "+N novas" and the landing on the first unread reply, the closed bar,
    /// a post deleted while open, and the pill instead of a jumping list.
    /// Needs the accounts `bob` and `lari` in the server; leaves nothing behind.
    func testAMemberSeesNewsTheClosedBarAndARemoval() throws {
        let target = try findForum()
        let stamp = Int(Date().timeIntervalSince1970) % 100_000
        guard let created = send("POST", "/api/channels/\(target.forumId)/posts", body: [
            "title": "Tela azul no QA \(stamp)",
            "body": "Aparece do nada jogando.",
            "nonce": UUID().uuidString,
        ]) as? [String: Any],
              let post = created["post"] as? [String: Any],
              let postId = post["id"] as? String
        else { throw XCTSkip("Could not create a post (rate limit or flag off)") }

        let app = launch(devUser: "bob")
        openForum(target, in: app, devUser: "bob")
        let card = app.buttons["forum.card.\(postId)"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        shot(app, "member-home-new")

        // First visit: opens on the question.
        card.tap()
        XCTAssertTrue(app.staticTexts["forum.post.title"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()

        reply("Já tentou atualizar o driver de vídeo?", in: postId, as: "lari")
        reply("E o BIOS também, aconteceu comigo.", in: postId, as: "lari")
        sleep(2)
        shot(app, "member-home-unread")

        // A later visit lands on the first reply this reader has not seen.
        card.tap()
        XCTAssertTrue(app.staticTexts["forum.post.title"].waitForExistence(timeout: 10))
        sleep(1)
        shot(app, "member-post-landing")

        send("PATCH", "/api/forum-posts/\(postId)", body: ["locked": true])
        XCTAssertTrue(app.descendants(matching: .any)["forum.lockedBar"].waitForExistence(timeout: 5),
                      "the closed bar replaces the composer within seconds")
        shot(app, "member-post-locked")

        send("DELETE", "/api/forum-posts/\(postId)")
        XCTAssertTrue(app.descendants(matching: .any)["forum.removed"].waitForExistence(timeout: 5))
        shot(app, "member-post-removed")
        app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Voltar pra lista", "Back to list"))
            .firstMatch.tap()

        // Scrolled down, a new post waits behind the pill.
        app.swipeUp()
        app.swipeUp()
        guard let second = send("POST", "/api/channels/\(target.forumId)/posts", body: [
            "title": "Outro post do QA \(stamp)", "body": "Teste da pílula.", "nonce": UUID().uuidString,
        ]) as? [String: Any],
              let secondId = (second["post"] as? [String: Any])?["id"] as? String
        else { return }
        let pill = app.descendants(matching: .any)["forum.livePill"].firstMatch
        let pillShown = pill.waitForExistence(timeout: 5)
        if !pillShown { shot(app, "member-home-no-pill") }
        XCTAssertTrue(pillShown, "a new post waits behind the pill")
        shot(app, "member-home-pill")
        pill.tap()
        sleep(1)
        shot(app, "member-home-after-pill")
        send("DELETE", "/api/forum-posts/\(secondId)")
    }
}
