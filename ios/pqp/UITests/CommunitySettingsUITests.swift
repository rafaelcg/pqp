import XCTest

/// The owner's walk through "Public access" in server settings, on a running
/// dev server started with `COMMUNITIES_ENABLED=true`.
///
/// Skipped rather than failed when the directory is off, like
/// `CommunitiesUITests`: the flag is the operator's, and the block is hidden
/// without it by design.
///
/// Real taps all the way: menu, settings, the address switch, the confirmation
/// that says who gets in, the directory switch, and the badge on the header.
final class CommunitySettingsUITests: XCTestCase {
    private var seeded: TestSeed.SeededServer?

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        if let seeded { TestSeed.deleteServer(self, id: seeded.id) }
    }

    private func communitiesEnabled() -> Bool {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)/api/communities/config")!)
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")
        let done = XCTestExpectation(description: "communities config")
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

    func testTheOwnerSeesPrivateThenTurnsOnTheAddressAndTheDirectoryWithAWarning() throws {
        TestSeed.passAgeGate(self)
        try XCTSkipUnless(communitiesEnabled(), "COMMUNITIES_ENABLED is off on the dev server.")
        let server = TestSeed.createServer(self, prefix: "Public")
        seeded = server

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", "none"]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        capture(app, as: "hub")
        XCTAssertTrue(app.openServerFromHub(server.id))

        // Private to begin with: no badge on the header.
        XCTAssertTrue(app.buttons["channels.menu"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.otherElements["server.publicBadge"].exists)
        app.buttons["channels.menu"].tap()
        let settingsItem = app.buttons.matching(NSPredicate(
            format: "label CONTAINS 'settings' OR label CONTAINS 'Ajustes'"
        )).firstMatch
        XCTAssertTrue(settingsItem.waitForExistence(timeout: 5))
        settingsItem.tap()

        // The status says what the room is, in words.
        let status = app.descendants(matching: .any)["community.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 15), "The public block should be drawn")
        capture(app, as: "settings-private")
        let addressToggle = app.switches["community.address.toggle"]
        XCTAssertTrue(addressToggle.exists)
        XCTAssertEqual(addressToggle.value as? String, "0")

        // The directory waits for the address.
        let directoryToggle = app.switches["community.directory.toggle"]
        XCTAssertFalse(directoryToggle.isEnabled)

        // One tap on the switch asks first; nothing has changed yet.
        addressToggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        capture(app, as: "after-tap")
        let alert = app.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5), "Turning the address on should ask first")
        capture(app, as: "confirm-address")
        XCTAssertEqual(addressToggle.value as? String, "0", "The switch must not flip before confirming")
        alert.buttons.element(boundBy: 0).tap() // Cancel
        XCTAssertFalse(app.alerts.firstMatch.waitForExistence(timeout: 1))
        XCTAssertEqual(addressToggle.value as? String, "0")

        // Confirm this time.
        addressToggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
        app.alerts.firstMatch.buttons.element(boundBy: 1).tap()
        capture(app, as: "after-confirm")
        let address = app.descendants(matching: .any)["community.status.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 10), "The public address should be shown")
        XCTAssertEqual(addressToggle.value as? String, "1")
        capture(app, as: "settings-public-link")

        // The directory is the second, separate step, and asks too.
        XCTAssertTrue(directoryToggle.isEnabled)
        directoryToggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
        capture(app, as: "confirm-directory")
        app.alerts.firstMatch.buttons.element(boundBy: 1).tap()
        // The save is a round trip; the switch only turns once it landed.
        var polls = 0
        while directoryToggle.value as? String != "1" && polls < 40 {
            Thread.sleep(forTimeInterval: 0.25)
            polls += 1
        }
        XCTAssertEqual(directoryToggle.value as? String, "1", "The directory switch should be on")
        capture(app, as: "settings-listed")

        // And the room says so from the outside: the header carries the badge.
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["server.publicBadge"].waitForExistence(timeout: 10),
            "A public room should be flagged on its header"
        )
        capture(app, as: "header-public")
    }
}
