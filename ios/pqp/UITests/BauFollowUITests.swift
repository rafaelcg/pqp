import XCTest

/// Seguir on a phone: the owner's switch, the bell on the Baú, the sheet that
/// sets a follow up, and the destination channel's own list.
///
/// NEEDS TWO SERVERS the dev user owns, named "Fonte QA" (its Baú on) and
/// "Destino QA", on an API started with `COMMUNITIES_ENABLED`,
/// `COMMUNITY_HOME_ENABLED`, `BAU_FOLLOW` and `DEV_AUTH_BYPASS`, and SKIPS when
/// they are not there: the flag, like the Baú itself, is read from the server's
/// environment and cannot be set over HTTP. Like the rest of `pqpUITests` it is
/// not run in CI. Locally:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/seguir-shots \
///     xcodebuild test -only-testing:pqpUITests/BauFollowUITests …
final class BauFollowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: - HTTP

    @discardableResult
    private func send(_ method: String, _ path: String, body: [String: Any]? = nil) -> Any? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
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

    private struct Pair { let sourceId: String; let targetId: String; let targetChannelId: String }

    private func findServers() throws -> Pair {
        guard let servers = (send("GET", "/api/servers") as? [String: Any])?["servers"] as? [[String: Any]]
        else { throw XCTSkip("No API at \(TestSeed.apiBase)") }
        func id(_ name: String) -> String? {
            servers.first { $0["name"] as? String == name }?["id"] as? String
        }
        guard let source = id("Fonte QA"), let target = id("Destino QA"),
              let channels = (send("GET", "/api/servers/\(target)/channels") as? [String: Any])?["channels"] as? [[String: Any]],
              let general = channels.first(where: { $0["name"] as? String == "general" })?["id"] as? String
        else { throw XCTSkip("No Fonte QA / Destino QA on \(TestSeed.apiBase)") }
        return Pair(sourceId: source, targetId: target, targetChannelId: general)
    }

    /// Start from nothing: the owner's switch off, no follow into the target.
    private func reset(_ pair: Pair) {
        // An empty Baú draws a compose prompt instead of the feed.
        let posts = (send("GET", "/api/servers/\(pair.sourceId)/home/posts") as? [String: Any])?["posts"] as? [[String: Any]] ?? []
        if posts.isEmpty,
           let made = (send("POST", "/api/servers/\(pair.sourceId)/home/posts", body: ["title": "Primeiro post", "body": "Teste de Seguir"]) as? [String: Any])?["post"] as? [String: Any],
           let postId = made["id"] as? String {
            send("POST", "/api/servers/\(pair.sourceId)/home/posts/\(postId)/publish", body: [:])
        }
        send("PATCH", "/api/servers/\(pair.sourceId)/home/follow-config", body: ["allowed": false])
        let follows = (send("GET", "/api/channels/\(pair.targetChannelId)/bau-follows") as? [String: Any])?["follows"] as? [[String: Any]] ?? []
        for follow in follows {
            if let id = follow["id"] as? String { send("DELETE", "/api/bau-follows/\(id)") }
        }
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
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

    private func openBau(_ app: XCUIApplication, _ serverId: String) {
        XCTAssertTrue(app.openServerFromHub(serverId))
        let bau = app.buttons["channels.bau"].firstMatch
        let found = bau.waitForExistence(timeout: 15)
        if !found { shot(app, "00-no-bau-row") }
        XCTAssertTrue(found, "The server has a Baú")
        bau.tap()
        XCTAssertTrue(app.scrollViews["bau.feed"].waitForExistence(timeout: 15))
    }

    private func follow(_ pair: Pair) {
        send("PATCH", "/api/servers/\(pair.sourceId)/home/follow-config", body: ["allowed": true])
        send("POST", "/api/servers/\(pair.sourceId)/home/follow", body: ["channelId": pair.targetChannelId])
    }

    // MARK: - The source's staff: the list, Remover e bloquear, Desbloquear

    func testStaffRemoveAndBlockAFollowerThenUnblockIt() throws {
        let pair = try findServers()
        TestSeed.passAgeGate(self)
        reset(pair)
        follow(pair)

        let app = launch()
        openBau(app, pair.sourceId)
        let menu = app.buttons["bau.follow.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10))
        menu.tap()
        app.buttons["bau.follow.followers"].tap()
        XCTAssertTrue(app.otherElements["bau.followers.row"].waitForExistence(timeout: 10), "The follower is listed")
        shot(app, "20-followers-list")

        app.buttons["bau.followers.rowMenu"].tap()
        app.buttons["bau.followers.block"].tap()
        // The block asks first.
        let confirm = app.buttons["bau.followers.confirmBlock"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "Blocking asks for a confirmation")
        shot(app, "21-confirm-block")
        confirm.tap()
        shot(app, "21b-after-confirm")
        XCTAssertTrue(app.buttons["bau.followers.unblock"].waitForExistence(timeout: 10), "The server is listed as blocked")
        XCTAssertFalse(app.otherElements["bau.followers.row"].exists, "and no longer as a follower")
        shot(app, "22-blocked")

        // A blocked server cannot follow again: the API refuses, naming the block.
        let refused = send("POST", "/api/servers/\(pair.sourceId)/home/follow", body: ["channelId": pair.targetChannelId]) as? [String: Any]
        XCTAssertNotNil(refused?["error"])

        app.buttons["bau.followers.unblock"].tap()
        XCTAssertTrue(app.buttons["bau.followers.unblock"].waitForNonExistence(timeout: 10), "Unblock empties the blocked list")
        shot(app, "23-unblocked")
        reset(pair)
    }

    // MARK: - A paused follow (set up by hand: UPDATE bau_follows SET paused_at = now(), paused_reason = 'permissions')

    func testAPausedFollowOfTheChannelCanBeResumed() throws {
        let pair = try findServers()
        let follows = (send("GET", "/api/channels/\(pair.targetChannelId)/bau-follows") as? [String: Any])?["follows"] as? [[String: Any]] ?? []
        guard follows.contains(where: { $0["status"] as? String == "paused" }) else {
            throw XCTSkip("No paused follow into Destino QA; pause one in the database first")
        }
        let app = launch()
        XCTAssertTrue(app.openServerFromHub(pair.targetId))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.press(forDuration: 1.0)
        app.buttons["channel.menu.following"].tap()
        XCTAssertTrue(app.otherElements["bau.follow.paused"].waitForExistence(timeout: 10) || app.staticTexts["bau.follow.paused"].waitForExistence(timeout: 5))
        shot(app, "30-paused")
        app.buttons["bau.follow.resume"].tap()
        XCTAssertTrue(app.buttons["bau.follow.resume"].waitForNonExistence(timeout: 10), "Resuming clears the paused state")
        shot(app, "31-resumed")
        let after = (send("GET", "/api/channels/\(pair.targetChannelId)/bau-follows") as? [String: Any])?["follows"] as? [[String: Any]]
        XCTAssertEqual(after?.first?["status"] as? String, "active")
        reset(pair)
    }

    // MARK: - The journey

    func testTheOwnerOpensTheSwitchFollowsFromTheBellAndUnfollowsFromTheChannel() throws {
        let pair = try findServers()
        TestSeed.passAgeGate(self)
        reset(pair)

        // 1. Switch off: no bell. The owner's menu holds the follower list.
        var app = launch()
        openBau(app, pair.sourceId)
        let menu = app.buttons["bau.follow.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "Staff get the menu while the flag is on")
        XCTAssertFalse(app.buttons["bau.follow"].exists, "No bell while the owner's switch is off")
        shot(app, "01-bau-switch-off")

        menu.tap()
        app.buttons["bau.follow.followers"].tap()
        XCTAssertTrue(app.otherElements["bau.followers.sheet"].waitForExistence(timeout: 10))
        let allow = app.switches["bau.follow.allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10), "The owner's switch is in the followers sheet")
        XCTAssertEqual(allow.value as? String, "0")
        shot(app, "02-followers-sheet-switch-off")
        allow.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        let on = NSPredicate(format: "value == '1'")
        let flipped = XCTNSPredicateExpectation(predicate: on, object: allow)
        XCTAssertEqual(XCTWaiter().wait(for: [flipped], timeout: 10), .completed, "The switch follows the server's answer")
        shot(app, "03-followers-sheet-switch-on")
        app.buttons["bau.followers.close"].tap()

        // 2. The bell is there now. Follow into Destino QA.
        let bell = app.buttons["bau.follow"]
        XCTAssertTrue(bell.waitForExistence(timeout: 10), "The bell appears once the owner allows following")
        shot(app, "04-bau-bell")
        bell.tap()
        XCTAssertTrue(app.otherElements["bau.follow.sheet"].waitForExistence(timeout: 10))
        let submit = app.buttons["bau.follow.submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["bau.follow.server"].exists || app.otherElements["bau.follow.server"].exists)
        shot(app, "05-picker")
        submit.tap()
        XCTAssertTrue(app.staticTexts["bau.follow.notice"].waitForExistence(timeout: 10), "Done. says where")
        XCTAssertTrue(app.otherElements["bau.follow.row"].waitForExistence(timeout: 10), "What you follow lists the follow")
        shot(app, "06-followed")
        app.buttons["bau.follow.close"].tap()

        let following = app.buttons.matching(NSPredicate(format: "label IN %@", ["Following this Baú", "Seguindo este Baú"])).firstMatch
        XCTAssertTrue(following.waitForExistence(timeout: 10), "The bell now reads as following")
        shot(app, "07-bau-following")

        // The server agrees.
        let follows = (send("GET", "/api/channels/\(pair.targetChannelId)/bau-follows") as? [String: Any])?["follows"] as? [[String: Any]]
        XCTAssertEqual(follows?.count, 1)

        // 3. The destination channel's own list, from its menu.
        app.terminate()
        app = launch()
        XCTAssertTrue(app.openServerFromHub(pair.targetId))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.press(forDuration: 1.0)
        let item = app.buttons["channel.menu.following"]
        XCTAssertTrue(item.waitForExistence(timeout: 10), "A manager sees Following in a text channel's menu")
        shot(app, "08-channel-menu")
        item.tap()
        XCTAssertTrue(app.otherElements["channel.follows.sheet"].waitForExistence(timeout: 10))
        let row = app.otherElements["bau.follow.row"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The channel lists the Baú it follows")
        shot(app, "09-channel-follows")
        app.buttons["bau.follow.unfollow"].tap()
        XCTAssertTrue(app.staticTexts["channel.follows.empty"].waitForExistence(timeout: 10), "Unfollowing empties the list")
        shot(app, "10-channel-unfollowed")

        let after = (send("GET", "/api/channels/\(pair.targetChannelId)/bau-follows") as? [String: Any])?["follows"] as? [[String: Any]]
        XCTAssertEqual(after?.count, 0)
        reset(pair)
    }
}
