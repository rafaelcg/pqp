import XCTest

/// Seeds server-side state over HTTP so a UI test does not depend on whatever
/// previous runs left behind.
///
/// This exists because they *did* depend on it: the message tests shared one
/// channel, so every run added to the same transcript until it held eighteen
/// messages and an inline image. XCUITest snapshots the whole accessibility
/// tree on every query, so the suite degraded from 20s to over three minutes
/// and then began failing with "Timed out while evaluating UI query" — a
/// message that says nothing about the actual cause.
extension XCUIApplication {
    /// Opens a server from the hub's rail.
    ///
    /// The rail scrolls horizontally, and XCUITest only auto-scrolls to reach a
    /// tap in the *vertical* direction — a seeded server sitting past the right
    /// edge is found by a query but cannot be tapped. The dev database holds
    /// whatever previous runs left in it, so which side of the edge it lands on
    /// is not something a test can assume.
    @discardableResult
    func openServerFromHub(
        _ id: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Bool {
        let tile = buttons["hub.server.\(id)"]
        guard tile.waitForExistence(timeout: 10) else {
            XCTFail("Server \(id) never appeared on the hub", file: file, line: line)
            return false
        }
        // Swiped on the rail itself, which is why it carries an identifier.
        // The loop compares frames rather than asking `isHittable` — that
        // property *throws* for an element outside the screen ("Activation
        // point invalid"), which is precisely the case being scrolled into.
        let rail = scrollViews["hub.serverRail"]
        var attempts = 0
        while !frame.contains(tile.frame) && attempts < 10 && rail.exists {
            rail.swipeLeft()
            attempts += 1
        }
        guard frame.contains(tile.frame) else {
            XCTFail("Server \(id) never scrolled into reach on the rail", file: file, line: line)
            return false
        }
        tile.tap()
        return true
    }
}

enum TestSeed {
    static let apiBase = "http://localhost:3001"

    struct SeededServer: Sendable {
        let id: String
        let name: String
    }

    /// Answers the 18+ gate for the dev-bypass user.
    ///
    /// The gate outranks every other route — a freshly reset database leaves
    /// the dev user `pending` and every seed call (and the app itself) answers
    /// 403 until a date of birth is on file. Idempotent by design: a 200 means
    /// it just passed, a 409 means it was already answered; both are fine and
    /// anything else will surface as the seed failure it causes.
    static func passAgeGate(_ test: XCTestCase) {
        var request = URLRequest(url: URL(string: "\(apiBase)/api/me/age-check")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["dateOfBirth": "1990-01-01"])

        let done = XCTestExpectation(description: "pass age gate")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        test.wait(for: [done], timeout: 15)
        dismissFirstRun(test)
    }

    /// Put the hub's first-run checklist away for the dev-bypass account.
    ///
    /// Rides along with the age gate for the same reason the web suite's
    /// `ensureServer` stamps it: the shared dev account reliably has a server but
    /// may have no friend and no avatar, so the checklist reads as outstanding and
    /// draws itself at the top of the hub — above the server rail and the
    /// conversation rows the hub tests measure and tap. Only a test about first run
    /// should see it, and such a test can clear the flag itself.
    ///
    /// Best effort and unasserted: a failure here costs a card on a screen, not a
    /// wrong result.
    static func dismissFirstRun(_ test: XCTestCase) {
        var request = URLRequest(url: URL(string: "\(apiBase)/api/me/preferences")!)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "firstRunDismissedAt": "2026-01-01T00:00:00.000Z"
        ])

        let done = XCTestExpectation(description: "dismiss first run")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        test.wait(for: [done], timeout: 15)
    }

    /// Creates a server and returns it. Unique per call so concurrent tests
    /// cannot collide — and **must be deleted again** in `tearDown`, or the
    /// server list grows every run and this whole problem simply moves up a
    /// level. It did: seeding without cleanup put 24 servers in the list and
    /// reintroduced the timeouts that seeding was meant to fix.
    static func createServer(_ test: XCTestCase, prefix: String = "UITest") -> SeededServer {
        // Every seed path needs the gate passed first; doing it here means no
        // test can forget.
        passAgeGate(test)
        let name = "\(prefix) \(Int.random(in: 100_000...999_999))"

        var request = URLRequest(url: URL(string: "\(apiBase)/api/servers")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])

        let done = XCTestExpectation(description: "seed server")
        // `nonisolated(unsafe)` rather than a captured local: the completion
        // handler runs off the test's thread and XCTestCase is not Sendable.
        nonisolated(unsafe) var createdId: String?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            XCTAssertTrue(
                (200..<300).contains(status),
                "Could not seed a server (\(status)). Is the dev server running with DEV_AUTH_BYPASS=true?"
            )
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let server = json["server"] as? [String: Any] {
                createdId = server["id"] as? String
            }
            done.fulfill()
        }.resume()
        test.wait(for: [done], timeout: 15)
        return SeededServer(id: createdId ?? "", name: name)
    }

    /// Removes a seeded server. Best effort — a failure here should not fail
    /// the test that already passed, but it is asserted loudly enough to notice
    /// if cleanup silently stops working and the list starts growing again.
    static func deleteServer(_ test: XCTestCase, id: String) {
        guard !id.isEmpty else { return }
        var request = URLRequest(url: URL(string: "\(apiBase)/api/servers/\(id)")!)
        request.httpMethod = "DELETE"
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")

        let done = XCTestExpectation(description: "delete server")
        URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }.resume()
        test.wait(for: [done], timeout: 15)
    }
}
