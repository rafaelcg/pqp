import XCTest

/// The communities directory, on a running dev server.
///
/// SKIPPED RATHER THAN FAILED WHEN THE FLAG IS OFF, and that is the honest
/// result. `COMMUNITIES_ENABLED` defaults to false — deliberately, because a
/// public directory is a legal category change and not a convenience switch —
/// so the dev server this suite talks to usually has no directory behind it. A
/// test that failed in that state would be reporting on the operator's
/// configuration rather than on the app, and the seeding helper has no way to
/// change it: the flag is read from the process environment, so turning it on
/// means restarting the server, which is not a thing a test may do to somebody's
/// machine.
///
/// To exercise these, run the dev server with `COMMUNITIES_ENABLED=true`.
final class CommunitiesUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Whether this deployment has the directory. The same question the app
    /// asks, against the same route, so the skip and the app's own behaviour
    /// cannot disagree.
    private func communitiesEnabled() -> Bool {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)/api/communities/config")!)
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")

        let done = XCTestExpectation(description: "read the communities config")
        nonisolated(unsafe) var enabled = false
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                enabled = json["enabled"] as? Bool ?? false
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return enabled
    }

    /// The compass, the chip row, and a directory that answered.
    ///
    /// Deliberately does NOT assert on any particular community: the dev
    /// database holds whatever previous runs left in it, and a directory with a
    /// member floor may legitimately be empty. What is asserted is that the
    /// surface exists, is reachable in one tap from the hub, and renders one of
    /// its two honest states.
    func testDirectoryOpensFromTheHub() throws {
        try XCTSkipUnless(
            communitiesEnabled(),
            "COMMUNITIES_ENABLED is off on the dev server; the directory does not exist here."
        )

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        // Land on the hub rather than wherever this device was last reading:
        // every assertion below starts from the hub, and a restored channel is
        // a state a previous run leaves behind.
        app.launchArguments += ["-pqp.lastVisited", ""]
        app.launch()
        TestSeed.passAgeGate(self)

        let compass = app.buttons["hub.communities"]
        XCTAssertTrue(
            compass.waitForExistence(timeout: 15),
            "The compass should be on the hub when the flag is on"
        )
        capture(app, as: "hub")
        compass.tap()

        XCTAssertTrue(
            app.otherElements["communities.chips"].waitForExistence(timeout: 10)
                || app.scrollViews["communities.chips"].waitForExistence(timeout: 1),
            "The category chips should be up"
        )
        // The sweep chip, and one real category — the row is built from the
        // shared slug list, so if it renders at all it renders all ten.
        XCTAssertTrue(app.buttons["communities.chip.all"].exists)
        XCTAssertTrue(app.buttons["communities.chip.games"].exists)
        XCTAssertTrue(app.textFields["communities.search"].exists)

        // Either cards or the empty state; both are correct answers, and which
        // one arrives depends on a database this test does not own.
        let card = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'communities.card.'"))
            .firstMatch
        let empty = app.staticTexts["Nothing here yet"]
        XCTAssertTrue(
            card.waitForExistence(timeout: 10) || empty.exists,
            "The directory should show cards or say it is empty"
        )
        capture(app, as: "directory")

        app.buttons["communities.done"].tap()
        XCTAssertTrue(app.buttons["hub.communities"].waitForExistence(timeout: 10))
    }

    /// Tapping a category filters without emptying the screen of chrome — the
    /// failure this catches is a filter that navigates away or wedges on its
    /// spinner.
    func testPickingACategoryKeepsTheDirectoryUp() throws {
        try XCTSkipUnless(
            communitiesEnabled(),
            "COMMUNITIES_ENABLED is off on the dev server; the directory does not exist here."
        )

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        // Land on the hub rather than wherever this device was last reading:
        // every assertion below starts from the hub, and a restored channel is
        // a state a previous run leaves behind.
        app.launchArguments += ["-pqp.lastVisited", ""]
        app.launch()
        TestSeed.passAgeGate(self)

        let compass = app.buttons["hub.communities"]
        XCTAssertTrue(compass.waitForExistence(timeout: 15))
        compass.tap()

        let games = app.buttons["communities.chip.games"]
        XCTAssertTrue(games.waitForExistence(timeout: 10))
        games.tap()

        XCTAssertTrue(app.textFields["communities.search"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["communities.chip.all"].exists)
    }

    /// The whole point of the surface: a card, tapped, puts you inside.
    ///
    /// Goes through SEARCH rather than the grid, because the grid's first row
    /// depends on which community happens to be biggest on this database — and
    /// because searching is the path that reaches a community the member floor
    /// keeps out of the grid entirely.
    func testOpeningACommunityLandsInIt() throws {
        try XCTSkipUnless(
            communitiesEnabled(),
            "COMMUNITIES_ENABLED is off on the dev server; the directory does not exist here."
        )

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.lastVisited", ""]
        app.launch()
        TestSeed.passAgeGate(self)

        let compass = app.buttons["hub.communities"]
        XCTAssertTrue(compass.waitForExistence(timeout: 15))
        compass.tap()

        let card = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'communities.card.'"))
            .firstMatch
        try XCTSkipUnless(
            card.waitForExistence(timeout: 10),
            "This database has no listed communities to open."
        )

        // The first card's own button. Matched by prefix rather than composed
        // from the card's identifier: the card is one accessibility container
        // and its id is not reliably readable back off the matched element.
        let enter = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'communities.join.'"))
            .firstMatch
        XCTAssertTrue(enter.waitForExistence(timeout: 5))
        enter.tap()

        // The directory closes and the app is inside: a channel list, with the
        // community's own name on it.
        XCTAssertTrue(
            app.staticTexts["general"].waitForExistence(timeout: 20),
            "Opening a community should land in its channel list"
        )
        capture(app, as: "channel-list")
    }
}

/// The profile card's two new blocks.
///
/// Reached the only way a profile sheet is reachable — a tap on a message author
/// — and opened on the account's OWN card, which is where a seeded depoimento
/// can be observed without needing a second signed-in person.
///
/// BOTH BLOCKS HIDE THEMSELVES WHEN EMPTY, so this asserts the card still opens
/// and leaves the presence of either to the database. Asserting "there is a
/// depoimento here" would be asserting a fixture nobody guarantees.
final class ProfileCardUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?

    override func setUp() {
        continueAfterFailure = false
        seeded = TestSeed.createServer(self)
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
        seeded = nil
        super.tearDown()
    }

    func testYourOwnCardOpensFromAMessage() {
        guard let seeded else { return XCTFail("No seeded community") }

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += [
            "-pqp.hasCompletedOnboarding", "YES",
            "-pqp.lastVisited", "",
        ]
        app.launch()

        XCTAssertTrue(app.openServerFromHub(seeded.id))
        XCTAssertTrue(app.staticTexts["general"].waitForExistence(timeout: 10))
        app.staticTexts["general"].tap()

        let text = "oi \(Int.random(in: 1000...9999))"
        let composer = app.textFields["composer.input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap()
        composer.typeText(text)
        // The button, not a newline: the composer is a single-line field whose
        // return key inserts nothing and sends nothing.
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        send.tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10))
        // The transcript scrolls to the tail after a send, and a tap issued
        // mid-animation lands wherever the row *was*.
        Thread.sleep(forTimeInterval: 0.7)

        let author = app.buttons["message.author"].firstMatch
        XCTAssertTrue(author.waitForExistence(timeout: 10))
        author.tap()

        XCTAssertTrue(app.staticTexts["profile.displayName"].waitForExistence(timeout: 10))
        // Give the two decorative reads — they run after the spinner clears —
        // a moment to land before the picture is taken.
        _ = app.otherElements["profile.depoimentos"].waitForExistence(timeout: 5)
        capture(app, as: "profile")

        app.buttons["profile.done"].tap()
    }
}

/// Writes a screenshot beside the ones the store-screenshot suite produces.
///
/// A file rather than an XCTAttachment: an attachment lives inside an
/// `.xcresult` that has to be opened in Xcode to look at, and the point of these
/// is to be looked at. Best effort — a failed write must not fail a test that is
/// about behaviour.
func capture(_ app: XCUIApplication, as name: String) {
    let data = app.screenshot().pngRepresentation
    let directory = URL(fileURLWithPath: "/tmp")
    try? data.write(to: directory.appendingPathComponent("ios-communities-\(name).png"))
}

/// The handle claim in Settings.
///
/// NOT gated on a flag — handles exist on every deployment — but deliberately
/// read-only about the *claim*: the dev-bypass account is shared between runs
/// and a handle carries a 30-day rename cooldown, so a test that claimed one
/// would make itself unrepeatable for a month and would take a name out of the
/// namespace for good.
final class HandleSettingsUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSettingsOffersThePublicLink() {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        // Land on the hub rather than wherever this device was last reading:
        // every assertion below starts from the hub, and a restored channel is
        // a state a previous run leaves behind.
        app.launchArguments += ["-pqp.lastVisited", ""]
        app.launch()
        TestSeed.passAgeGate(self)

        let profile = app.buttons["hub.profile"]
        XCTAssertTrue(profile.waitForExistence(timeout: 15))
        profile.tap()

        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()

        // One of the two states, and which one depends on whether this shared
        // account has ever claimed one: the field, or the link with its copy and
        // share affordances beside it.
        let field = app.textFields["settings.handle.field"]
        let claimed = app.staticTexts["settings.handle.url"]
        XCTAssertTrue(
            field.waitForExistence(timeout: 10) || claimed.exists,
            "Settings should offer the handle field or show the claimed link"
        )
        capture(app, as: "settings-handle")
    }
}
