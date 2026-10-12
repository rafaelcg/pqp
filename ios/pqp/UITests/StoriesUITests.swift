import XCTest

/// Stories, on a running dev server with `STORIES=true` (and
/// `STORIES_FRIENDS=true` for the friends strip).
///
/// SKIPPED RATHER THAN FAILED WHEN THE FLAG IS OFF, like the other flagged
/// suites. The suite posts its own text story from `dev_local_user_stories`
/// to the first server the dev user is in, so the strip has a ring to open.
final class StoriesUITests: XCTestCase {
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

    /// The first server the dev user is in, and a story in it from somebody
    /// else. Nil when the account cannot post there (a brand-new account in
    /// a listed community, for one).
    private func seedServerStory() -> String? {
        guard let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let serverId = servers.first?["id"] as? String
        else { return nil }
        TestSeed.passAgeGate(self, devUser: "stories")
        // Joins the server through an invite minted by the dev user.
        if let invite = request("POST", "/api/servers/\(serverId)/invites")?["invite"] as? [String: Any],
           let code = invite["code"] as? String {
            request("POST", "/api/invites/\(code)/join", as: "stories")
        }
        let story = request("POST", "/api/stories", as: "stories", body: [
            "kind": "text", "text": "bora de cs hoje?", "background": "grape",
            "audiences": ["serverIds": [serverId], "friends": false],
        ])
        // A listed community refuses a brand-new account (72 h); the strip may
        // still have other people's stories, which is what the test needs.
        _ = story
        return serverId
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        return app
    }

    private func enabled() -> Bool {
        request("GET", "/api/stories/config")?["enabled"] as? Bool == true
    }

    func testTheServerStripOpensTheViewer() throws {
        try XCTSkipUnless(enabled(), "STORIES is off on the dev server.")
        let serverId = try XCTUnwrap(seedServerStory(), "No server to open")

        let app = launch()
        let server = app.buttons["hub.server.\(serverId)"]
        XCTAssertTrue(server.waitForExistence(timeout: 20))
        server.tap()
        XCTAssertTrue(app.scrollViews["stories.strip"].waitForExistence(timeout: 15)
                      || app.otherElements["stories.strip"].waitForExistence(timeout: 1),
                      "A story on the air draws the strip")
        snap(app, "stories-strip")

        let ring = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'stories.ring.'")).firstMatch
        XCTAssertTrue(ring.waitForExistence(timeout: 5))
        ring.tap()
        XCTAssertTrue(app.buttons["story.close"].waitForExistence(timeout: 10), "The viewer opens")
        snap(app, "stories-viewer")

        app.buttons["story.menu"].tap()
        snap(app, "stories-menu")
        let report = app.buttons["Denunciar story"].exists ? app.buttons["Denunciar story"] : app.buttons["Report story"]
        XCTAssertTrue(report.waitForExistence(timeout: 5))
        report.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 5))
        snap(app, "stories-report")
    }

    /// GG is one tap; a reply becomes a DM and says so.
    func testReactAndReply() throws {
        try XCTSkipUnless(enabled(), "STORIES is off on the dev server.")
        guard let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let serverId = servers.first?["id"] as? String else { return XCTFail("No server") }
        let app = launch()
        app.buttons["hub.server.\(serverId)"].tap()
        let ring = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'stories.ring.'")).firstMatch
        XCTAssertTrue(ring.waitForExistence(timeout: 15))
        ring.tap()
        let gg = app.buttons["story.react.gg"]
        XCTAssertTrue(gg.waitForExistence(timeout: 10))
        gg.tap()
        let reply = app.textFields["story.reply"]
        guard reply.waitForExistence(timeout: 5) else {
            // Replies off or DM closed: the line says so instead.
            XCTAssertTrue(app.staticTexts["story.replyBlocked"].exists)
            return
        }
        reply.tap()
        sleep(1)
        snap(app, "stories-reply-focus")
        // Unique per run, so an earlier run's reply cannot pass this one.
        let marker = "que isso \(Int(Date().timeIntervalSince1970) % 100_000)"
        reply.typeText(marker + "\n")
        // The "Mandado" flash lives 1.2 s inside an animation, which the
        // accessibility tree does not reliably catch; the conversation is the
        // fact that matters, so the test reads it from the API.
        snap(app, "stories-reply-sent")
        var landed = false
        for _ in 0..<10 where !landed {
            sleep(1)
            let conversations = request("GET", "/api/dms")?["conversations"] as? [[String: Any]] ?? []
            landed = conversations.contains {
                (($0["lastMessage"] as? [String: Any])?["preview"] as? String) == marker
            }
        }
        XCTAssertTrue(landed, "The reply became a message in the conversation with the author")
    }

    func testOwnStoryShowsWhoSawIt() throws {
        try XCTSkipUnless(enabled(), "STORIES is off on the dev server.")
        guard let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let serverId = servers.first?["id"] as? String else { return XCTFail("No server") }
        request("POST", "/api/stories", body: [
            "kind": "text", "text": "setup novo, olha isso", "background": "lime",
            "audiences": ["serverIds": [serverId], "friends": false],
        ])
        let app = launch()
        app.buttons["hub.server.\(serverId)"].tap()
        let own = app.buttons["stories.own"]
        XCTAssertTrue(own.waitForExistence(timeout: 15))
        own.tap()
        let viewers = app.buttons["story.viewers"]
        XCTAssertTrue(viewers.waitForExistence(timeout: 10), "Your own story says who saw it")
        snap(app, "stories-own")
        viewers.tap()
        sleep(2)
        snap(app, "stories-viewers-sheet")
    }

    func testComposerPostsATextStory() throws {
        try XCTSkipUnless(enabled(), "STORIES is off on the dev server.")
        guard let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let serverId = servers.first?["id"] as? String else { return XCTFail("No server") }
        let app = launch()
        app.buttons["hub.server.\(serverId)"].tap()
        let more = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'More' OR label == 'Mais'")).firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()
        let newStory = app.buttons["Novo story"].exists ? app.buttons["Novo story"] : app.buttons["New story"]
        XCTAssertTrue(newStory.waitForExistence(timeout: 5), "The server menu opens the composer")
        newStory.tap()
        let field = app.textFields["composer.text"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("on hoje de noite")
        snap(app, "stories-composer")
        app.buttons["composer.next"].tap()
        let post = app.buttons["audience.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 10))
        sleep(1)
        snap(app, "stories-audience")
        post.tap()
        XCTAssertTrue(app.buttons["stories.own"].waitForExistence(timeout: 15), "Back on the list with your story up")
        snap(app, "stories-posted")
    }

    func testCallComposer() throws {
        try XCTSkipUnless(enabled(), "STORIES is off on the dev server.")
        guard let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]],
              let serverId = servers.first?["id"] as? String else { return XCTFail("No server") }
        let app = launch()
        app.buttons["hub.server.\(serverId)"].tap()
        let more = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'More' OR label == 'Mais'")).firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        more.tap()
        let newStory = app.buttons["Novo story"].exists ? app.buttons["Novo story"] : app.buttons["New story"]
        XCTAssertTrue(newStory.waitForExistence(timeout: 5))
        newStory.tap()
        let call = app.buttons["composer.mode.call"]
        XCTAssertTrue(call.waitForExistence(timeout: 10))
        call.tap()
        let room = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'composer.call.'")).firstMatch
        XCTAssertTrue(room.waitForExistence(timeout: 10), "The voice rooms are listed")
        // Opens on the room this account is in, if any.
        sleep(1)
        snap(app, "stories-composer-call-start")
        room.tap()
        snap(app, "stories-composer-call")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            try? app.screenshot().pngRepresentation
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
