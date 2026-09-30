import XCTest

/// First run V2, walked end to end by brand-new accounts against a **running
/// local server** (`pnpm dev` with `DEV_AUTH_BYPASS=true`).
///
/// Each test signs in as a fresh `dev_user_<suffix>` (`PQP_DEV_USER`), which is
/// a real row with its age gate pending and no `onboardedAt`, so it sees the
/// whole flow exactly as a new person would: welcome, age, you, and then the
/// room or the doors. Nothing is mocked; the point is that the app and the
/// real API agree on every step.
///
/// Set `TEST_RUNNER_PQP_SHOT_DIR` to a folder to also get every step as a PNG
/// there (the PR's screenshots come from it). Unset, screenshots are only
/// attached to the test result.
final class FirstRunV2UITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private var shotPrefix = ""

    private func launchNewAccount(inviteCode: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = TestSeed.launchEnvironment
        app.launchEnvironment["PQP_DEV_USER"] = "ob\(Int.random(in: 10_000_000...99_999_999))"
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO", "-pqp.lastVisited", "none"]
        if let inviteCode {
            // What tapping the link before signing in leaves behind.
            app.launchArguments += ["-pqp.pendingInvite", inviteCode]
        }
        if let languages = ProcessInfo.processInfo.environment["PQP_UI_LANGUAGE"], !languages.isEmpty {
            app.launchArguments += ["-AppleLanguages", "(\(languages))", "-AppleLocale", languages.replacingOccurrences(of: "-", with: "_")]
        }
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        // Let springs settle so the picture is the resting state.
        Thread.sleep(forTimeInterval: 0.9)
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "\(shotPrefix)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["PQP_SHOT_DIR"], !dir.isEmpty {
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(shotPrefix)-\(name).png")
            try? screenshot.pngRepresentation.write(to: url)
        }
    }

    /// Polls rather than using a predicate expectation, which strict
    /// concurrency refuses to hand a non-Sendable test case to.
    private func waitForLabel(of element: XCUIElement, containing text: String, timeout: TimeInterval = 10) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists, element.label.contains(text) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return false
    }

    /// Day, month, year, continue. Month is a menu, found by position so the
    /// test reads the same in any language.
    private func answerAgeGate(_ app: XCUIApplication) {
        let day = app.textFields["ageGate.day"]
        XCTAssertTrue(day.waitForExistence(timeout: 15), "A new account starts at the age gate")
        shot("02-age")
        day.tap()
        day.typeText("14")
        app.buttons["ageGate.month"].tap()
        let march = app.buttons.matching(NSPredicate(format: "label ==[c] %@ OR label ==[c] %@", "March", "março")).firstMatch
        XCTAssertTrue(march.waitForExistence(timeout: 5))
        march.tap()
        let year = app.textFields["ageGate.year"]
        year.tap()
        year.typeText("1994")
        shot("03-age-filled")
        app.buttons["ageGate.submit"].tap()
    }

    // MARK: - The invitee

    func testAnInviteeSeesTheRoomBeforeSigningUpAndLandsInIt() {
        shotPrefix = "invitee"
        let server = TestSeed.createServer(self, prefix: "Galera do Bar")
        defer { TestSeed.deleteServer(self, id: server.id) }
        let code = TestSeed.createInvite(self, serverId: server.id)

        let app = launchNewAccount(inviteCode: code)

        // The public preview, before any account exists.
        let title = app.descendants(matching: .any)["welcome.inviteTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertTrue(waitForLabel(of: title, containing: server.name), "The welcome names the room")
        shot("01-welcome")
        app.buttons["welcome.start"].tap()

        answerAgeGate(app)

        // Two screens, and the second one names the room.
        let next = app.buttons["you.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 15))
        XCTAssertEqual(app.descendants(matching: .any)["onboarding.dots"].label.isEmpty, false)
        let arrival = app.descendants(matching: .any)["you.arrival"]
        XCTAssertTrue(arrival.waitForExistence(timeout: 5), "The room that is waiting is on the you step")
        XCTAssertTrue(waitForLabel(of: next, containing: server.name), "The button says which room")
        shot("04-you")

        app.buttons["you.preset.2"].tap()
        shot("05-you-avatar")
        next.tap()

        // In the room, with the arrival moment on top of it.
        XCTAssertTrue(app.buttons["arrival.dismiss"].waitForExistence(timeout: 15))
        shot("06-arrived")
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 10), "The joined room is open underneath")
    }

    // MARK: - The cold organizer

    func testAColdOrganizerMakesARoomAndLeavesWithTheInvite() {
        shotPrefix = "organizer"
        let app = launchNewAccount()

        XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 15))
        shot("01-welcome")
        app.buttons["welcome.start"].tap()

        answerAgeGate(app)

        let next = app.buttons["you.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 15))
        shot("04-you")
        app.buttons["you.handle"].tap()
        shot("05-you-copied")
        next.tap()

        // The three doors.
        let create = app.buttons["door.create"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["door.discord"].exists)
        XCTAssertTrue(app.buttons["door.invite"].exists)
        shot("06-room")
        create.tap()
        let field = app.textFields["door.create.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        let name = "Os Crias \(Int.random(in: 100...999))"
        field.typeText(name)
        shot("07-room-create")
        app.buttons["door.create.action"].tap()

        // Ready: the invite is in hand before the room is.
        let link = app.staticTexts["ready.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        XCTAssertTrue(link.label.contains("/app/invite/"), "The ready step shows a real invite link")
        XCTAssertTrue(link.label.contains("ref=onboarding"), "The wizard's invite is counted apart")
        shot("08-ready")
        app.buttons["ready.copyLink"].tap()
        shot("09-ready-copied")
        app.swipeUp()
        shot("10-ready-below")

        app.buttons["ready.enter"].tap()
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 15), "Go into the room opens the room")
        shot("11-in-the-room")
    }

    // MARK: - The Discord door

    /// Reaches Discord's public template API through the local server, so it
    /// needs the network. Skipped rather than failed when Discord cannot be
    /// reached, which is a fact about the machine, not about the app.
    func testTheDiscordDoorCopiesATemplateAndHandsBackTheInvite() throws {
        shotPrefix = "discord"
        let app = launchNewAccount()

        XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 15))
        app.buttons["welcome.start"].tap()
        answerAgeGate(app)

        let next = app.buttons["you.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 15))
        next.tap()

        let door = app.buttons["door.discord"]
        XCTAssertTrue(door.waitForExistence(timeout: 10))
        door.tap()
        shot("06-room-discord")
        let field = app.textFields["door.import.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        // Discord's own "Friends & Family" template, public since 2020.
        field.typeText("https://discord.new/hgM48av5Q69A")
        app.buttons["door.import.preview"].tap()

        let confirm = app.buttons["door.import.confirm"]
        try XCTSkipUnless(confirm.waitForExistence(timeout: 20), "Discord's template API was not reachable")
        shot("07-discord-preview")
        confirm.tap()

        let link = app.staticTexts["ready.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 20))
        shot("08-ready")
        app.swipeUp()
        XCTAssertTrue(app.buttons["ready.copyDiscord"].waitForExistence(timeout: 5), "An import also gets the paste-back text")
        shot("09-ready-discord-paste")
        app.buttons["ready.enter"].tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 15))
        shot("10-in-the-room")
    }

    // MARK: - Skip

    func testLaterClosesTheWizardForGood() {
        shotPrefix = "skip"
        let app = launchNewAccount()
        XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 15))
        app.buttons["welcome.start"].tap()
        answerAgeGate(app)

        let later = app.buttons["onboarding.later"]
        XCTAssertTrue(later.waitForExistence(timeout: 15))
        later.tap()
        XCTAssertTrue(app.buttons["hub.profile"].waitForExistence(timeout: 10), "Skipping lands on the hub")
        let card = app.descendants(matching: .any)["firstRun.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 10), "The checklist picks up from there")
        shot("hub-checklist")
    }
}
