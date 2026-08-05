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

    /// Creates a server and returns its name, which is unique per call so tests
    /// running against the same database cannot collide.
    @discardableResult
    static func createServer(_ test: XCTestCase, prefix: String = "UITest") -> String {
        let name = "\(prefix) \(Int.random(in: 100_000...999_999))"

        var request = URLRequest(url: URL(string: "\(apiBase)/api/servers")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer dev-local-token", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name])

        let done = XCTestExpectation(description: "seed server")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            XCTAssertTrue(
                (200..<300).contains(status),
                "Could not seed a server (\(status)). Is the dev server running with DEV_AUTH_BYPASS=true?"
            )
            done.fulfill()
        }.resume()
        test.wait(for: [done], timeout: 15)
        return name
    }
}
