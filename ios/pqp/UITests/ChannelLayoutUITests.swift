import XCTest

/// The mixed channel list on a phone: categories are the only headers,
/// Organizar canais stages moves and sends them in one PUT, and a list that
/// moved underneath comes back as the stale message.
///
/// NEEDS A SERVER IN THE MIXED LIST. The `mixed_channel_list` flag is read
/// from the server's environment or `feature_flag_overrides`, which a test
/// cannot set over HTTP, so this finds a server the dev user owns where
/// `GET /api/servers/:id/channel-layout` says `mixed`, and SKIPS when there is
/// none. Like the rest of `pqpUITests` it is not run in CI. Locally, against an
/// API started with `MIXED_CHANNEL_LIST=true` and `DEV_AUTH_BYPASS=true`:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3121 \
///     TEST_RUNNER_PQP_QA_LANGUAGE=pt-BR \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/layout-shots \
///     xcodebuild test -only-testing:pqpUITests/ChannelLayoutUITests …
final class ChannelLayoutUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: - HTTP

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

    private func channels(_ serverId: String) -> [[String: Any]] {
        (send("GET", "/api/servers/\(serverId)/channels") as? [String: Any])?["channels"] as? [[String: Any]] ?? []
    }

    private func channelId(named name: String, in serverId: String) -> String? {
        channels(serverId).first { $0["name"] as? String == name }?["id"] as? String
    }

    /// A server the dev user owns in the mixed list, holding a voice room
    /// called Lobby and a second category to move it into.
    private func findServer() throws -> String {
        guard let servers = (send("GET", "/api/servers") as? [String: Any])?["servers"] as? [[String: Any]]
        else { throw XCTSkip("No API at \(TestSeed.apiBase)") }
        for server in servers where server["role"] as? String == "owner" {
            guard let id = server["id"] as? String,
                  (send("GET", "/api/servers/\(id)/channel-layout") as? [String: Any])?["mixed"] as? Bool == true
            else { continue }
            let rows = channels(id)
            let categories = rows.filter { $0["type"] as? String == "category" }
            if categories.count >= 2, rows.contains(where: { $0["name"] as? String == "Lobby" }) {
                return id
            }
        }
        throw XCTSkip("No owned server in the mixed list with Lobby and two categories")
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

    private func dump(_ app: XCUIApplication, _ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] else { return }
        try? app.debugDescription.write(toFile: "\(directory)/\(name).txt", atomically: true, encoding: .utf8)
    }

    private func openOrganizer(_ app: XCUIApplication) {
        let more = app.buttons["channels.menu"]
        XCTAssertTrue(more.waitForExistence(timeout: 5), "the server menu is there")
        more.tap()
        let organize = app.buttons["channels.organize"]
        XCTAssertTrue(organize.waitForExistence(timeout: 5), "Organizar canais is in the server menu")
        organize.tap()
        XCTAssertTrue(app.buttons["organize.done"].waitForExistence(timeout: 5))
    }

    /// The system's reorder handle for one row of the organizer.
    private func handle(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "(label BEGINSWITH[c] 'Reorder' OR label BEGINSWITH[c] 'Reordenar') AND label ENDSWITH %@", " \(name)")).firstMatch
    }

    // MARK: - Tests

    func testTheMixedListAndAMoveSavedFromTheOrganizer() throws {
        let serverId = try findServer()
        TestSeed.passAgeGate(self)
        let app = launch()
        app.openServerFromHub(serverId)
        XCTAssertTrue(app.buttons["channels.createCategory"].waitForExistence(timeout: 10), "Criar categoria is the last row")
        shot(app, "01-mixed-list")
        // No TEXT / VOICE pseudo-sections: categories are the only headers.
        XCTAssertFalse(app.staticTexts["TEXTO"].exists)
        XCTAssertFalse(app.staticTexts["VOZ"].exists)
        XCTAssertFalse(app.staticTexts["TEXT"].exists)
        XCTAssertFalse(app.staticTexts["VOICE"].exists)

        openOrganizer(app)
        shot(app, "02-organize")
        dump(app, "02-organize")

        let lobby = handle(app, "Lobby")
        let squad = handle(app, "Squad")
        XCTAssertTrue(lobby.waitForExistence(timeout: 5), "Lobby has a reorder handle")
        XCTAssertTrue(squad.exists)
        // Drop Lobby on the upper edge of Squad: between clipes and Squad.
        let target = squad.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        lobby.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.6, thenDragTo: target)
        shot(app, "03-organize-moved")
        let jogosId = try XCTUnwrap(channelId(named: "Jogos", in: serverId))

        app.buttons["organize.done"].tap()
        // The organizer is gone once the PUT has answered.
        XCTAssertTrue(app.buttons["organize.done"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["channels.createCategory"].waitForExistence(timeout: 10))
        shot(app, "04-after-done")

        let lobbyRow = channels(serverId).first { $0["name"] as? String == "Lobby" }
        XCTAssertEqual(lobbyRow?["parentId"] as? String, jogosId, "the saved order put Lobby in Jogos")
    }

    func testAListThatMovedUnderneathSaysSoAndStartsAgain() throws {
        let serverId = try findServer()
        TestSeed.passAgeGate(self)
        let app = launch()
        app.openServerFromHub(serverId)
        XCTAssertTrue(app.buttons["channels.createCategory"].waitForExistence(timeout: 10))
        openOrganizer(app)

        let lfg = handle(app, "lfg")
        XCTAssertTrue(lfg.waitForExistence(timeout: 5))
        let general = handle(app, "general")
        lfg.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.6, thenDragTo: general.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))

        // Somebody else changes the list while this one is staged.
        let canais = try XCTUnwrap(channelId(named: "Canais", in: serverId))
        send("POST", "/api/servers/\(serverId)/channels",
             body: ["name": "novo-\(Int.random(in: 100...999))", "type": "text", "parentId": canais])

        app.buttons["organize.done"].tap()
        let stale = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Não deu pra mover' OR label BEGINSWITH 'Couldn'")).firstMatch
        XCTAssertTrue(stale.waitForExistence(timeout: 10), "the 409 is said")
        shot(app, "05-stale")
        app.buttons.matching(NSPredicate(format: "label == 'Entendi' OR label == 'Got it'")).firstMatch.tap()
        // Still organizing, from the fresh list.
        XCTAssertTrue(app.buttons["organize.done"].exists)
        shot(app, "06-stale-fresh")
        app.buttons["organize.cancel"].tap()
    }

    func testTheCategoryPlusAndAFoldedCategory() throws {
        let serverId = try findServer()
        TestSeed.passAgeGate(self)
        let app = launch()
        app.openServerFromHub(serverId)
        XCTAssertTrue(app.buttons["channels.createCategory"].waitForExistence(timeout: 10))
        let plus = app.buttons["channels.categoryCreate.Jogos"]
        XCTAssertTrue(plus.waitForExistence(timeout: 5))
        plus.tap()
        shot(app, "07-category-plus")
        // Dismiss the menu.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        let header = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'JOGOS'")).firstMatch
        XCTAssertTrue(header.waitForExistence(timeout: 5))
        header.tap()
        shot(app, "08-folded")
        header.tap()
    }

    /// A member without MANAGE_CHANNELS: no Criar categoria, no "+", and an
    /// empty category is not drawn at all.
    func testAMemberSeesNoManagerChrome() throws {
        let serverId = try findServer()
        let invite = (send("POST", "/api/servers/\(serverId)/invites", body: [:]) as? [String: Any])?["invite"] as? [String: Any]
        let code = try XCTUnwrap(invite?["code"] as? String)
        TestSeed.passAgeGate(self, devUser: "layoutbob")
        send("POST", "/api/invites/\(code)/join", body: [:], devUser: "layoutbob")
        let app = launch(devUser: "layoutbob")
        app.openServerFromHub(serverId)
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 10))
        shot(app, "09-member")
        XCTAssertFalse(app.buttons["channels.createCategory"].exists)
        XCTAssertFalse(app.buttons["channels.categoryCreate.Jogos"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'CINEMA'")).firstMatch.exists)
    }
}
