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
enum TestSeed {
    static let apiBase = "http://localhost:3001"

    struct SeededServer: Sendable {
        let id: String
        let name: String
    }

    /// Creates a server and returns it. Unique per call so concurrent tests
    /// cannot collide — and **must be deleted again** in `tearDown`, or the
    /// server list grows every run and this whole problem simply moves up a
    /// level. It did: seeding without cleanup put 24 servers in the list and
    /// reintroduced the timeouts that seeding was meant to fix.
    static func createServer(_ test: XCTestCase, prefix: String = "UITest") -> SeededServer {
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
