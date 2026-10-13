import XCTest

/// The viewer with layers: a story posted through the API with a text layer, a
/// mention and a call sticker is opened from the server's strip, and each of
/// them is on screen where it was placed. Needs a dev server with
/// `STORIES=true` and a layers-aware API.
final class StoryViewerLayersUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @discardableResult
    private func request(_ method: String, _ path: String, as devUser: String? = nil, body: [String: Any]? = nil) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(TestSeed.token(devUser))", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let done = XCTestExpectation(description: "\(method) \(path)")
        nonisolated(unsafe) var json: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data { json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return json
    }

    /// Posts a story as the account the app runs as (a brand-new second
    /// account is refused by a listed community): a title, a mention of
    /// another member, and a call sticker for the server's first voice room.
    private func seed() throws -> (serverId: String, name: String) {
        let config = request("GET", "/api/stories/config")
        try XCTSkipUnless(config?["enabled"] as? Bool == true, "STORIES is off on the dev server.")
        try XCTSkipUnless((config?["layersMax"] as? Int ?? 0) > 0, "The dev server predates layers.")
        let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]]
        let serverId = try XCTUnwrap(servers?.first?["id"] as? String)
        TestSeed.passAgeGate(self, devUser: "layers")
        if let invite = request("POST", "/api/servers/\(serverId)/invites")?["invite"] as? [String: Any],
           let code = invite["code"] as? String {
            request("POST", "/api/invites/\(code)/join", as: "layers")
        }
        let them = request("GET", "/api/me", as: "layers")
        let theirId = try XCTUnwrap((them?["user"] as? [String: Any] ?? them)?["id"] as? String)
        let channels = request("GET", "/api/servers/\(serverId)/channels")?["channels"] as? [[String: Any]]
        let voice = try XCTUnwrap(channels?.first { $0["type"] as? String == "voice" }?["id"] as? String, "No voice room")
        let unique = Int(Date().timeIntervalSince1970) % 100_000
        let title = "bora jogar \(unique)"
        let created = request("POST", "/api/stories", body: [
            "kind": "text", "background": "grape",
            "altText": "\(title). Call no Lobby",
            "layers": [
                ["id": UUID().uuidString.lowercased(), "type": "text", "x": 0.5, "y": 0.3, "scale": 1, "rotation": 0,
                 "text": title, "font": "bold", "color": "lime", "background": "none", "align": "center", "size": 1.4],
                ["id": UUID().uuidString.lowercased(), "type": "mention", "x": 0.5, "y": 0.5, "scale": 1, "rotation": 0, "userId": theirId],
                ["id": UUID().uuidString.lowercased(), "type": "call", "x": 0.5, "y": 0.72, "scale": 1, "rotation": 0,
                 "serverId": serverId, "channelId": voice],
            ],
            "audiences": ["serverIds": [serverId], "friends": false],
        ])
        _ = try XCTUnwrap(created?["story"], "The story was refused: \(String(describing: created))")
        return (serverId, title)
    }

    private func openViewer(serverId: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            let language = ProcessInfo.processInfo.environment["PQP_QA_LANG"] ?? "pt-BR"
            app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", language.replacingOccurrences(of: "-", with: "_")]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        app.buttons["hub.server.\(serverId)"].tap()
        let own = app.buttons["stories.own"]
        XCTAssertTrue(own.waitForExistence(timeout: 20), "The strip has the new story")
        own.tap()
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10), "The viewer opens")
        return app
    }

    /// The text layer, the call sticker and the mention are all drawn, and a
    /// screen reader hears the alt text once.
    func testLayersAreDrawnWhereTheyWerePlaced() throws {
        let seeded = try seed()
        let app = openViewer(serverId: seeded.serverId)
        let sticker = app.descendants(matching: .any)["story.call.sticker"].firstMatch
        XCTAssertTrue(sticker.waitForExistence(timeout: 15), "The call sticker is a layer")
        let mention = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open the profile' OR label BEGINSWITH 'Abrir o perfil'")).firstMatch
        XCTAssertTrue(mention.waitForExistence(timeout: 5), "The mention is a door")
        // The alt text is the story's one spoken description. (The viewer opens
        // on the oldest of your stories, which an earlier run may have posted.)
        let spoken = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'bora jogar'")).firstMatch
        XCTAssertTrue(spoken.waitForExistence(timeout: 5), "A screen reader reads the alt text")
        sleep(1)
        snap(app, "viewer-layers")
    }

    /// Tapping a mention opens that person's profile and pauses the story.
    func testATappedMentionOpensTheProfile() throws {
        let seeded = try seed()
        let app = openViewer(serverId: seeded.serverId)
        let mention = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open the profile' OR label BEGINSWITH 'Abrir o perfil'")).firstMatch
        XCTAssertTrue(mention.waitForExistence(timeout: 15))
        mention.tap()
        XCTAssertTrue(app.buttons["profile.done"].waitForExistence(timeout: 10), "The profile opens over the story")
        snap(app, "viewer-mention-profile")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            let language = ProcessInfo.processInfo.environment["PQP_QA_LANG"] ?? "pt-BR"
            try? app.screenshot().pngRepresentation
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).\(language).png"))
        }
    }
}
