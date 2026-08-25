import XCTest

/// Deleting your account, end to end against a **running local server**
/// (`pnpm dev` with `DEV_AUTH_BYPASS=true`).
///
/// WHY IT IS WORTH A UI TEST AT ALL. App Store Review Guideline 5.1.1(v) makes
/// in-app deletion the difference between a build that can be submitted and one
/// that cannot, and the thing a reviewer does is exactly this: open the app,
/// find the control, and use it. A unit test can pin the confirmation rule and
/// the wire shapes, which `AccountDeletionTests` does; only this can say the
/// control is reachable and that the account is really gone afterwards.
///
/// IT DELETES A DIFFERENT ACCOUNT FROM EVERY OTHER TEST. `PQP_DEV_USER` mints a
/// throwaway dev-bypass identity per run (see `DevTokenProvider`), so this suite
/// cannot destroy the servers, conversations and handle that the rest of the
/// suite reads from the shared `dev-local-token` account. The throwaway one is
/// created on its first authenticated request and left deleted at the end,
/// which is the whole point.
final class AccountDeletionUITests: XCTestCase {
    /// Unique per run: an account this test deletes must never be one a retry,
    /// or a parallel run, is halfway through using.
    private var devUser = ""

    override func setUp() {
        continueAfterFailure = false
        devUser = "del\(Int.random(in: 100_000...999_999))"
        // Creates the account server-side and answers the gate, so the app
        // lands on the hub rather than on the date-of-birth question.
        TestSeed.passAgeGate(self, devUser: devUser)
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchEnvironment["PQP_DEV_USER"] = devUser
        // The intro is device-local state that previous runs may have left in
        // either position, and this test is not about it.
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES"]
        app.launchArguments += ["-pqp.lastVisited", ""]
        app.launch()
        return app
    }

    /// Opens Settings and scrolls the destructive control into view.
    private func openDeleteConfirmation(_ app: XCUIApplication) {
        let profile = app.buttons["hub.profile"]
        XCTAssertTrue(profile.waitForExistence(timeout: 20), "Never reached the hub")
        profile.tap()

        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()

        // Last section of a long form, so it is below the fold on every phone.
        let delete = app.buttons["settings.data.delete"]
        scroll(app, to: delete)
        XCTAssertTrue(
            delete.exists,
            "Settings never offered 'Delete my account', which is the App Store requirement"
        )
        delete.tap()
    }

    /// Swipes until an element is in the tree.
    ///
    /// `waitForExistence` is not enough on its own here: a SwiftUI `Form` is a
    /// collection view with cell reuse, so a row far below the fold does not
    /// merely sit off screen, it is genuinely absent from the accessibility
    /// tree until it is scrolled near. Both screens this test drives are longer
    /// than a phone.
    private func scroll(_ app: XCUIApplication, to element: XCUIElement) {
        var swipes = 0
        while !element.exists && swipes < 12 {
            app.swipeUp()
            swipes += 1
        }
    }

    /// The confirmation field, scrolled into reach and ready to type into.
    private func confirmationField(_ app: XCUIApplication) -> XCUIElement {
        let field = app.textFields["settings.delete.field"]
        scroll(app, to: field)
        XCTAssertTrue(field.exists, "The delete sheet never offered its confirmation field")
        return field
    }

    /// The safeguard, which is the part a wrong implementation gets wrong: the
    /// button must not be live until the account's own tag has been typed.
    func testTheConfirmationWaitsForTheTypedTag() {
        let app = launch()
        openDeleteConfirmation(app)

        let confirm = app.buttons["settings.delete.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        XCTAssertFalse(confirm.isEnabled, "Nothing typed yet, so deletion must be refused")

        let field = confirmationField(app)
        field.tap()
        field.typeText("not my tag")
        XCTAssertFalse(confirm.isEnabled, "The wrong string must not arm the button")

        // And leaving is one tap, with the account untouched.
        app.buttons["Keep my account"].tap()
        XCTAssertTrue(
            app.buttons["settings.data.delete"].waitForExistence(timeout: 5),
            "Cancelling should return to Settings"
        )
    }

    /// The other right the same section offers: a copy of everything, as a
    /// file. On a phone that means the share sheet, because there is nowhere to
    /// "download" to.
    func testTheExportHandsOverAFile() {
        let app = launch()

        let profile = app.buttons["hub.profile"]
        XCTAssertTrue(profile.waitForExistence(timeout: 20), "Never reached the hub")
        profile.tap()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        settings.tap()

        let export = app.buttons["settings.data.export"]
        scroll(app, to: export)
        XCTAssertTrue(export.exists, "Settings never offered 'Download my data'")
        export.tap()

        // `UIActivityViewController` carries this identifier on every version
        // of iOS this app runs on. Its presence is the assertion: the bytes
        // arrived, were written to a file, and that file was handed over.
        XCTAssertTrue(
            app.otherElements["ActivityListView"].waitForExistence(timeout: 20),
            "Exporting should end in the share sheet"
        )
    }

    /// The whole flow: type the tag, delete, and find the account gone.
    ///
    /// "Gone" is asserted against the server rather than against the screen. A
    /// signed-out app proves the client did something; only a fresh `GET
    /// /api/me` carrying a *different* account id proves the row was really
    /// destroyed and rebuilt from scratch by the bypass.
    func testDeletingForRealSignsOutAndTheAccountIsGone() {
        let before = accountId()
        XCTAssertFalse(before.isEmpty, "Could not read the throwaway account")

        let app = launch()
        openDeleteConfirmation(app)

        let field = confirmationField(app)
        field.tap()
        field.typeText(tag())

        let confirm = app.buttons["settings.delete.confirm"]
        XCTAssertTrue(confirm.isEnabled, "The account's own tag should arm the button")
        confirm.tap()

        // Signing out returns the app to its first-run intro, which is the one
        // screen that cannot be reached with a session in hand.
        XCTAssertTrue(
            app.buttons["Skip"].waitForExistence(timeout: 20)
                || app.buttons["Next"].waitForExistence(timeout: 5),
            "Deleting the account should leave the app signed out"
        )

        let after = accountId()
        XCTAssertFalse(
            after.isEmpty,
            "The bypass should mint a fresh account for the same token"
        )
        XCTAssertNotEqual(
            before, after,
            "Same account id after deleting it: the row was never destroyed"
        )
    }

    // MARK: - Reading the account this test owns

    private func me() -> [String: Any] {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)/api/me")!)
        request.setValue(
            "Bearer \(TestSeed.token(devUser))", forHTTPHeaderField: "Authorization"
        )
        let done = XCTestExpectation(description: "read /api/me")
        nonisolated(unsafe) var body: [String: Any] = [:]
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                body = json
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return body
    }

    private func accountId() -> String { me()["id"] as? String ?? "" }

    /// What the screen asks to be typed. Read from the server rather than
    /// assembled here, because the discriminator is assigned at sign-up.
    private func tag() -> String { me()["tag"] as? String ?? "" }
}
