import XCTest

/// Three phone gaps against the web, with real taps and a second account:
/// the server list following another device's order, a folded section that
/// hides a mention, and "Mandar um oi" after a friend accepts.
///
/// NEEDS "Fonte QA" and "Destino QA" (the dev user owns both) and a second
/// account `dev-local-token:bob` who is a member of both and has sent one
/// message naming the dev user in Fonte QA's #general (see
/// `ServerUnreadUITests`); each test SKIPS without them. Not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/gaps-shots \
///     xcodebuild test -only-testing:pqpUITests/PhoneGapsUITests …
final class PhoneGapsUITests: XCTestCase {
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

    private func serverIds() throws -> (fonte: String, destino: String) {
        guard let servers = send("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let fonte = servers.first(where: { $0["name"] as? String == "Fonte QA" })?["id"] as? String,
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String
        else { throw XCTSkip("No Fonte QA / Destino QA on \(TestSeed.apiBase)") }
        return (fonte, destino)
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

    private func tile(_ app: XCUIApplication, _ id: String) -> XCUIElement {
        let rail = app.buttons["hub.server.\(id)"]
        return rail.exists ? rail : app.buttons["servers.server.\(id)"]
    }

    // MARK: - The server list follows another device

    func testTheServerListFollowsAnOrderSavedOnAnotherDevice() throws {
        let ids = try serverIds()
        TestSeed.passAgeGate(self)
        // Start from Fonte, Destino.
        send("PUT", "/api/servers/order", body: ["serverIds": [ids.fonte, ids.destino], "origin": "setup"])
        let app = launch()
        XCTAssertTrue(tile(app, ids.fonte).waitForExistence(timeout: 20))
        XCTAssertTrue(tile(app, ids.destino).waitForExistence(timeout: 20))
        XCTAssertLessThan(tile(app, ids.fonte).frame.minX, tile(app, ids.destino).frame.minX)
        shot(app, "10-order-before")
        sleep(2)

        // The web (another origin) drags Destino to the front.
        send("PUT", "/api/servers/order", body: ["serverIds": [ids.destino, ids.fonte], "origin": "web-tab"])
        let deadline = Date().addingTimeInterval(20)
        var followed = false
        while Date() < deadline, !followed {
            followed = tile(app, ids.destino).frame.minX < tile(app, ids.fonte).frame.minX
            if !followed { Thread.sleep(forTimeInterval: 1) }
        }
        shot(app, "11-order-after")
        XCTAssertTrue(followed, "The phone's list follows an order saved elsewhere, live")
        send("PUT", "/api/servers/order", body: ["serverIds": [ids.fonte, ids.destino], "origin": "setup"])
    }

    // MARK: - A folded section that hides a mention

    func testAFoldedSectionShowsTheMentionInsideIt() throws {
        let ids = try serverIds()
        let unread = (send("GET", "/api/servers/\(ids.fonte)/unread")?["unread"] as? [[String: Any]]) ?? []
        guard unread.contains(where: { ($0["mentions"] as? Int ?? 0) > 0 }) else {
            throw XCTSkip("Fonte QA has no unread mention for the dev user")
        }
        TestSeed.passAgeGate(self)
        let app = launch()
        XCTAssertTrue(app.openServerFromHub(ids.fonte))
        let header = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] 'TEXT' OR label BEGINSWITH[c] 'TEXTO'")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 15), "The Text section header")
        shot(app, "20-section-open")
        header.tap()
        let pill = app.staticTexts["channels.section.mentions"].exists
            ? app.staticTexts["channels.section.mentions"]
            : app.descendants(matching: .any)["channels.section.mentions"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "A folded section that hides a mention says '@N', not a dot")
        shot(app, "21-section-folded")
        header.tap()
    }

    // MARK: - Mandar um oi

    func testAFriendWhoAcceptsOffersAHiAndTheTapOpensTheConversation() throws {
        _ = try serverIds()
        TestSeed.passAgeGate(self)
        TestSeed.passAgeGate(self, devUser: "bob")
        guard let me = send("GET", "/api/me")?["id"] as? String,
              let bob = send("GET", "/api/me", as: "bob")?["id"] as? String
        else { throw XCTSkip("No second account") }
        // From nothing: not friends, no request either way.
        send("DELETE", "/api/friends/\(bob)")
        send("DELETE", "/api/friends/\(me)", as: "bob")
        send("POST", "/api/friends", body: ["userId": bob])

        let app = launch()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'hub.server.' OR identifier BEGINSWITH 'servers.server.'")).firstMatch.waitForExistence(timeout: 20))
        sleep(4)
        XCTAssertFalse(app.otherElements["friend.accepted"].exists, "Nothing yet: bob has not accepted")

        send("POST", "/api/friends/\(me)/accept", as: "bob")
        let card = app.otherElements["friend.accepted"]
        XCTAssertTrue(card.waitForExistence(timeout: 20), "The card appears when the friend accepts")
        shot(app, "30-say-hi-card")
        let sayHi = app.buttons["friend.accepted.sayHi"]
        XCTAssertTrue(sayHi.exists)
        sayHi.tap()
        // The conversation with bob: its composer, and bob's name in the bar.
        let title = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'bob'")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 15), "Mandar um oi opens the conversation with the new friend")
        shot(app, "31-conversation-opened")
        XCTAssertFalse(app.otherElements["friend.accepted"].exists, "The card is gone once used")

        send("DELETE", "/api/friends/\(bob)")
    }
}
