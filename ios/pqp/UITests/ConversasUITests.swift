import XCTest

/// Conversas on a phone: the tab bar, the list, Nova conversa, and the ways
/// into a conversation that were missing (call buttons from Friends, Message
/// from the members list).
///
/// SKIPPED RATHER THAN FAILED WHEN THE FLAGS ARE OFF, like the communities
/// suite: `conversations_home` and `conversations_home_phone_tabs` default to
/// off, and turning them on means restarting the dev server with
/// `CONVERSATIONS_HOME=true CONVERSATIONS_HOME_PHONE_TABS=true`, which a test
/// may not do to somebody's machine.
///
/// The suite opens its own conversation with `dev_local_user_conversas` so a
/// fresh database still has a row to tap.
final class ConversasUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func dmsConfig() -> (home: Bool, phoneTabs: Bool) {
        let json = request("GET", "/api/dms/config")
        return (json?["home"] as? Bool ?? false, json?["phoneTabs"] as? Bool ?? false)
    }

    @discardableResult
    private func request(_ method: String, _ path: String, as devUser: String? = nil, body: [String: Any]? = nil) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(devUser.map { "dev-local-token:\($0)" } ?? "dev-local-token")", forHTTPHeaderField: "Authorization")
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

    /// A friend with a 1:1, so the list, Friends and Nova conversa all have
    /// somebody in them.
    private func seedFriendConversation() {
        // A brand-new dev account has to clear the age gate before it can
        // accept anything.
        TestSeed.passAgeGate(self, devUser: "conversas")
        guard let friend = request("GET", "/api/me", as: "conversas")?["id"] as? String else { return }
        request("POST", "/api/friends", body: ["userId": friend])
        if let me = request("GET", "/api/me")?["id"] as? String {
            request("POST", "/api/friends/\(me)/accept", as: "conversas")
        }
        request("POST", "/api/dms", body: ["userIds": [friend]])
    }

    private func launch(tab: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", "", "-pqp.phoneTab", tab]
        // Screenshots for a review are taken in pt-BR, the app's audience.
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        return app
    }

    func testConversasTabListsConversationsAndOpensNovaConversa() throws {
        let config = dmsConfig()
        try XCTSkipUnless(config.phoneTabs, "conversations_home_phone_tabs is off on the dev server.")
        seedFriendConversation()

        let app = launch(tab: "conversas")
        let newButton = app.buttons["conversas.new"]
        XCTAssertTrue(newButton.waitForExistence(timeout: 20), "Conversas should open on its own tab")
        XCTAssertTrue(app.tabBars.buttons.count >= 3, "The bar has Conversas, Servidores and Tu")
        XCTAssertTrue(app.buttons["conversas.filter.unread"].exists)
        snap(app, "conversas-list")

        newButton.tap()
        XCTAssertTrue(app.buttons["nova.group"].waitForExistence(timeout: 10), "Nova conversa lists before asking")
        snap(app, "nova-conversa")
        app.buttons["nova.group"].tap()
        snap(app, "nova-conversa-group")
    }

    /// The bug in the iOS audit: a DM opened from Friends had no call buttons.
    func testADmOpenedFromFriendsCanBeCalled() throws {
        try XCTSkipUnless(dmsConfig().phoneTabs, "conversations_home_phone_tabs is off on the dev server.")
        seedFriendConversation()

        let app = launch(tab: "conversas")
        let friends = app.buttons["conversas.friends"]
        XCTAssertTrue(friends.waitForExistence(timeout: 20))
        friends.tap()
        // The seeded friend has no socket, so they are under Tudo, not Online.
        let all = app.buttons["Tudo"].exists ? app.buttons["Tudo"] : app.buttons["All"]
        if all.waitForExistence(timeout: 10) { all.tap() }
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "conversas#")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The seeded friend should be listed")
        row.tap()
        XCTAssertTrue(app.buttons["chat.callVoice"].waitForExistence(timeout: 10), "A friend's DM rings")
        snap(app, "friends-dm-call")
    }

    func testServidoresAndTuTabs() throws {
        try XCTSkipUnless(dmsConfig().phoneTabs, "conversations_home_phone_tabs is off on the dev server.")
        let app = launch(tab: "servidores")
        XCTAssertTrue(app.buttons["servers.createOrJoin"].waitForExistence(timeout: 20), "Servidores lists servers as rows")
        snap(app, "servidores")
        app.tabBars.buttons.element(boundBy: 2).tap()
        XCTAssertTrue(app.buttons["Sair"].waitForExistence(timeout: 10) || app.buttons["Sign out"].exists)
        snap(app, "tu")
    }

    /// Message from the members list: a bubble on each row with Conversas on.
    func testMessageFromTheMembersList() throws {
        try XCTSkipUnless(dmsConfig().home, "conversations_home is off on the dev server.")
        let app = launch(tab: "servidores")
        let server = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'servers.server.'")).firstMatch
        XCTAssertTrue(server.waitForExistence(timeout: 20))
        server.tap()
        let more = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'More' OR label == 'Mais'")).firstMatch
        if more.waitForExistence(timeout: 5) { more.tap() } else { app.navigationBars.buttons.element(boundBy: app.navigationBars.buttons.count - 1).tap() }
        let members = app.buttons["Membros"].exists ? app.buttons["Membros"] : app.buttons["Members"]
        XCTAssertTrue(members.waitForExistence(timeout: 5))
        members.tap()
        let bubble = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'members.message.'")).firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), "Each member but you has a Message bubble")
        snap(app, "members")
        bubble.tap()
        XCTAssertTrue(app.buttons["chat.callVoice"].waitForExistence(timeout: 10), "Message opens the conversation on the sheet's stack")
        snap(app, "members-dm")
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
