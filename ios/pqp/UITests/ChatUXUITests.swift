import XCTest

/// The in-chat journeys, against the live local server.
///
/// These cover the three things a phone user does constantly — react, express,
/// and find out who somebody is — because all three were either awkward or
/// impossible before, and none of them can be proven by a unit test: the bug
/// they replace was a *layout* (six quick reactions laid out as 4 + 1 + 1) and
/// two missing affordances.
final class ChatUXUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?
    private var serverName: String { seeded?.name ?? "" }

    override func setUp() {
        continueAfterFailure = false
        // A fresh server per test: XCUITest snapshots the whole accessibility
        // tree on every query, so a shared transcript makes the suite slower
        // every run until it times out.
        seeded = TestSeed.createServer(self)
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        super.tearDown()
    }

    private func openGeneral() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO"]
        app.launch()
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 5))
        app.buttons["Skip"].tap()

        // The seeded server is appended to the end of a lazy list, so on a
        // machine with leftover servers from an interrupted run it starts below
        // the fold — and a row a `LazyVStack` has not built does not exist to
        // query. Scroll until it does rather than depending on a clean database.
        let server = app.staticTexts[serverName]
        XCTAssertTrue(server.waitForExistence(timeout: 10) || scrollTo(server, in: app),
                      "A seeded server should be reachable in the list")
        server.tap()

        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 5))
        app.staticTexts["general"].tap()
        return app
    }

    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        for _ in 0..<10 {
            if element.exists { return true }
            app.swipeUp()
        }
        return element.exists
    }

    @discardableResult
    private func send(_ text: String, in app: XCUIApplication) -> XCUIElement {
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText(text)
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 3),
                      "Send should appear as soon as there is something to send")
        send.tap()
        let message = app.staticTexts[text]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        // The transcript scrolls to the tail after a send, and a press issued
        // mid-animation lands wherever the row *was* — which, now that the
        // author name is a tappable target twenty points above the body, opens
        // a profile instead of the menu. One settle rather than a polling loop:
        // every XCUITest query snapshots the whole accessibility tree.
        Thread.sleep(forTimeInterval: 0.7)
        return message
    }

    // MARK: - The long-press menu

    /// The bug this replaces, stated as a test: SwiftUI's context menu laid six
    /// quick reactions out as four on one row and then one per row. They are
    /// one row now, and "one row" is checked geometrically rather than by
    /// counting buttons — a wrapped grid has all six buttons too.
    func testQuickReactionsAreOneRowWithATailToTheFullPicker() {
        let app = openGeneral()
        let text = "react to me \(Int.random(in: 1000...9999))"
        send(text, in: app)

        app.staticTexts[text].press(forDuration: 1.2)

        let first = app.buttons["messageActions.quick0"]
        XCTAssertTrue(first.waitForExistence(timeout: 5),
                      "A long press should open the message menu")

        let row = (0..<6).map { app.buttons["messageActions.quick\($0)"] }
        for (index, button) in row.enumerated() {
            XCTAssertTrue(button.exists, "Quick reaction \(index) should be offered")
        }

        let baseline = first.frame.midY
        for (index, button) in row.enumerated() {
            XCTAssertEqual(
                button.frame.midY, baseline, accuracy: 1,
                "Quick reaction \(index) wrapped onto another row — that is the "
                + "broken grid this menu was rebuilt to fix"
            )
        }

        // Evenly spaced: the gaps between consecutive centres are equal.
        let gaps = zip(row, row.dropFirst()).map { $1.frame.midX - $0.frame.midX }
        for gap in gaps {
            XCTAssertEqual(gap, gaps[0], accuracy: 1, "Quick reactions should be evenly spaced")
        }

        XCTAssertTrue(app.buttons["messageActions.moreReactions"].exists,
                      "The row should end in a tail into the full picker")

        // The actions live below the row, not above it.
        XCTAssertTrue(app.buttons["Reply"].exists)
        XCTAssertGreaterThan(app.buttons["Reply"].frame.midY, baseline)
    }

    func testTappingAQuickReactionReactsAndClosesTheMenu() {
        let app = openGeneral()
        let text = "thumbs \(Int.random(in: 1000...9999))"
        send(text, in: app)

        app.staticTexts[text].press(forDuration: 1.2)
        let thumbs = app.buttons["messageActions.quick0"]
        XCTAssertTrue(thumbs.waitForExistence(timeout: 5))
        thumbs.tap()

        // The reaction round-trips over the WebSocket; the pill is drawn
        // optimistically and confirmed by the broadcast.
        XCTAssertTrue(app.staticTexts["👍"].waitForExistence(timeout: 10),
                      "The reaction should land on the message")

        let deadline = Date().addingTimeInterval(5)
        while app.buttons["messageActions.quick0"].exists && Date() < deadline {
            usleep(200_000)
        }
        XCTAssertFalse(app.buttons["messageActions.quick0"].exists,
                       "Reacting should close the menu")
    }

    /// The "+" tail is the whole reason the row can stay short.
    func testMoreReactionsOpensTheSearchablePicker() {
        let app = openGeneral()
        let text = "search reactions \(Int.random(in: 1000...9999))"
        send(text, in: app)

        app.staticTexts[text].press(forDuration: 1.2)
        let more = app.buttons["messageActions.moreReactions"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        more.tap()

        let search = app.textFields["picker.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5), "The full picker should be searchable")
        search.tap()
        search.typeText("fire")

        let fire = app.buttons["emoji.🔥"]
        XCTAssertTrue(fire.waitForExistence(timeout: 5), "Searching 'fire' should find 🔥")
        fire.tap()

        XCTAssertTrue(app.staticTexts["🔥"].waitForExistence(timeout: 10),
                      "Picking from the full picker should react")
    }

    // MARK: - The composer

    /// One smiley, not a smiley and a "GIF": emoji and GIFs are the same errand
    /// and now share one sheet.
    func testComposerOffersOneExpressionButtonAndNoSeparateGifButton() {
        let app = openGeneral()
        XCTAssertTrue(app.buttons["composer.express"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["composer.gif"].exists,
                       "The separate GIF button was folded into the emoji sheet")
    }

    /// The send button is furniture when there is nothing to send.
    func testSendAppearsOnlyWhenThereIsSomethingToSend() {
        let app = openGeneral()
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["composer.send"].exists,
                       "An empty composer should not show a dead send button")

        composer.tap()
        composer.typeText("hi")
        XCTAssertTrue(app.buttons["composer.send"].waitForExistence(timeout: 3))
    }

    /// The defect this replaces: the picker was a sheet, so it covered the
    /// composer it was writing into. The emoji landed in the draft and the
    /// draft was behind the sheet, which is indistinguishable from a dead
    /// button. So the assertion is not merely "the emoji reached the draft" —
    /// it is "the emoji reached the draft *while the composer was on screen*",
    /// checked before anything is dismissed.
    func testComposerEmojiPanelInsertsIntoTheDraftWithTheComposerStillVisible() {
        let app = openGeneral()
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("ship it ")

        app.buttons["composer.express"].tap()

        let panel = app.otherElements["expression.panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 5),
                      "The smiley should open the inline panel")

        let search = app.textFields["picker.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("rocket")

        let rocket = app.buttons["emoji.🚀"]
        XCTAssertTrue(rocket.waitForExistence(timeout: 5))
        rocket.tap()

        let deadline = Date().addingTimeInterval(5)
        while !(composer.value as? String ?? "").contains("🚀") && Date() < deadline {
            usleep(200_000)
        }
        XCTAssertTrue((composer.value as? String ?? "").contains("🚀"),
                      "Picking an emoji should append it to the draft")
        // The whole point: with the panel still open, the composer is visible
        // and the emoji is visibly in it.
        XCTAssertTrue(composer.exists && composer.isHittable,
                      "The composer must stay reachable while the panel is up")
    }

    /// The panel takes the keyboard's place *below* the composer, and says how
    /// to get rid of it. A sheet needed neither check; a panel does.
    func testExpressionPanelSitsBelowTheComposerAndCloses() {
        let app = openGeneral()
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))

        app.buttons["composer.express"].tap()
        let panel = app.otherElements["expression.panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        // Measured *after* the panel is up: opening it lifts the composer, so a
        // frame captured beforehand describes a layout that no longer exists.
        XCTAssertGreaterThan(
            panel.frame.minY, composer.frame.maxY - 1,
            "The panel belongs under the composer, not over it — covering the "
            + "composer is the defect it exists to fix"
        )

        let close = app.buttons["picker.close"]
        XCTAssertTrue(close.exists, "A panel with no visible way out is a trap")
        close.tap()

        let deadline = Date().addingTimeInterval(5)
        while panel.exists && Date() < deadline { usleep(200_000) }
        XCTAssertFalse(panel.exists, "Closing should collapse the panel")
        XCTAssertTrue(composer.isHittable)
    }

    /// The dead tap, as a test.
    ///
    /// A GIF cell's label is nothing but a `UIViewRepresentable` once the
    /// frames decode, and a plain `Button` derives its hit region from what
    /// SwiftUI draws — so the cell had no hit region at all and every tap fell
    /// through it. Skipped rather than failed where the deployment has no GIF
    /// provider: there is no grid to tap and pretending otherwise would make
    /// the suite depend on a third-party key.
    func testTappingAGifSendsIt() throws {
        let app = openGeneral()
        app.buttons["composer.express"].tap()
        XCTAssertTrue(app.otherElements["expression.panel"].waitForExistence(timeout: 5))

        let gifs = app.buttons["picker.tab.gifs"]
        try XCTSkipUnless(gifs.waitForExistence(timeout: 3),
                          "No GIF provider configured on the dev server")
        gifs.tap()

        let cell = app.buttons["picker.gif.0"]
        XCTAssertTrue(cell.waitForExistence(timeout: 15), "The grid should fill")
        cell.tap()

        // Picking a GIF closes the panel and posts it — the message has no body,
        // so the attachment appearing in the transcript is the evidence.
        let panel = app.otherElements["expression.panel"]
        let deadline = Date().addingTimeInterval(10)
        while panel.exists && Date() < deadline { usleep(200_000) }
        XCTAssertFalse(panel.exists, "Picking a GIF should close the panel")

        XCTAssertFalse(app.staticTexts["chat.error"].exists,
                       "Sending the GIF should not have failed")
        XCTAssertTrue(app.buttons["message.avatar"].firstMatch.waitForExistence(timeout: 15),
                      "The GIF should arrive in the transcript as a message")
    }

    // MARK: - Profiles

    /// The affordance that did not exist: who said this, and what can I do
    /// about them. Only one account exists under the dev bypass, so this proves
    /// the tap target and the sheet — the relationship states themselves are
    /// covered by `ProfileRelationsTests`.
    func testTappingAnAuthorOpensTheirProfile() {
        let app = openGeneral()
        let text = "who am i \(Int.random(in: 1000...9999))"
        send(text, in: app)

        let author = app.buttons["message.author"].firstMatch
        XCTAssertTrue(author.waitForExistence(timeout: 5),
                      "A message author should be tappable")
        author.tap()

        XCTAssertTrue(app.staticTexts["profile.displayName"].waitForExistence(timeout: 5),
                      "Tapping an author should open their profile")

        // It is our own message, so there is no relationship to act on and
        // nothing to report — offering either would be offering a refusal.
        XCTAssertTrue(app.staticTexts["This is you."].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["profile.friendAction"].exists)
        XCTAssertFalse(app.buttons["profile.more"].exists)

        app.buttons["profile.done"].tap()
        XCTAssertTrue(app.textFields["composer.input"].waitForExistence(timeout: 5),
                      "Closing the profile should return to the chat")
    }
}
