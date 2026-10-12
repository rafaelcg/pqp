import XCTest

/// Chamar a atenção, on a running dev server with `NUDGE=true`.
///
/// SKIPPED RATHER THAN FAILED WHEN THE FLAG IS OFF: `nudge` defaults to off,
/// and turning it on means restarting the dev server, which a test may not do.
/// The suite makes its own friend (`dev_local_user_nudge`) and 1:1, so it does
/// not depend on what an earlier run left behind.
final class NudgeUITests: XCTestCase {
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

    /// A fresh friend and their 1:1, returned as the conversation id.
    private func seedFriendDm() -> String? {
        TestSeed.passAgeGate(self, devUser: "nudge")
        guard let friend = request("GET", "/api/me", as: "nudge")?["id"] as? String,
              let me = request("GET", "/api/me")?["id"] as? String
        else { return nil }
        request("PATCH", "/api/me", as: "nudge", body: ["displayName": "Lu"])
        request("PATCH", "/api/me/preferences", as: "nudge", body: ["allowNudges": true])
        request("PATCH", "/api/me/preferences", body: ["allowNudges": true])
        request("POST", "/api/friends", body: ["userId": friend])
        request("POST", "/api/friends/\(me)/accept", as: "nudge")
        let opened = request("POST", "/api/dms", body: ["userIds": [friend]])
        return (opened?["conversation"] as? [String: Any])?["channelId"] as? String
    }

    private func launch(conversation channelId: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += [
            "-pqp.hasCompletedOnboarding", "YES",
            "-pqp.lastVisited", "conversation|\(channelId)",
        ]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        return app
    }

    func testNudgeAFriendThenARefusalSaysWhy() throws {
        let config = request("GET", "/api/fun/config")
        try XCTSkipUnless(config?["nudge"] as? Bool == true, "NUDGE is off on the dev server.")
        let channelId = try XCTUnwrap(seedFriendDm(), "Could not seed a friend's DM")

        let app = launch(conversation: channelId)
        let button = app.buttons["chat.nudge"]
        XCTAssertTrue(button.waitForExistence(timeout: 20), "A friend's 1:1 has the nudge button")
        snap(app, "nudge-header")

        button.tap()
        XCTAssertTrue(app.otherElements["chat.nudgeLine"].waitForExistence(timeout: 10)
                      || app.staticTexts["chat.nudgeLine"].waitForExistence(timeout: 1),
                      "The sent nudge leaves its line")
        XCTAssertFalse(button.isEnabled, "The button rests for the cooldown")
        snap(app, "nudge-sent")

        // The other person turns nudges off: the next one is refused, with a
        // line. (Não perturbe would need their socket online.)
        request("PATCH", "/api/me/preferences", as: "nudge", body: ["allowNudges": false])
        let deadline = Date().addingTimeInterval(15)
        while !button.isEnabled && Date() < deadline { sleep(1) }
        XCTAssertTrue(button.isEnabled, "The button comes back after the cooldown")
        button.tap()
        let notice = app.staticTexts["chat.nudgeNotice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 10), "A refusal says why")
        snap(app, "nudge-refused")
        request("PATCH", "/api/me/preferences", as: "nudge", body: ["allowNudges": true])
    }

    /// The two-way opt-out lives in Settings, only while the flag is on.
    func testSettingsOffersTheSwitch() throws {
        let config = request("GET", "/api/fun/config")
        try XCTSkipUnless(config?["nudge"] as? Bool == true, "NUDGE is off on the dev server.")
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        let profile = app.buttons["hub.profile"]
        XCTAssertTrue(profile.waitForExistence(timeout: 20))
        profile.tap()
        let settings = app.buttons["Ajustes"].exists ? app.buttons["Ajustes"] : app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()
        let toggle = app.switches["settings.allowNudges"]
        for _ in 0..<4 where !toggle.exists { app.swipeUp() }
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "Settings has the nudge switch")
        snap(app, "nudge-settings")
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
