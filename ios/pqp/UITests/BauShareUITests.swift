import XCTest

/// Compartilhar on a public Baú post: the control is on a post the server gave
/// a `publicUrl`, not on one it did not, and a tap opens the system sheet.
///
/// READ ONLY, and it seeds nothing: a post only has a public page in a
/// community with an address and the `bau_public_posts` flag on, neither of
/// which a test can set over HTTP. It looks for a server the dev user belongs
/// to whose feed carries a `publicUrl`, and SKIPS when there is none. Like the
/// rest of `pqpUITests` it is not run in CI. Locally, against an API with
/// `COMMUNITIES_ENABLED`, `COMMUNITY_HOME_ENABLED`, `DEV_AUTH_BYPASS` and the flag:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3001 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/bau-share-shots \
///     xcodebuild test -only-testing:pqpUITests/BauShareUITests …
final class BauShareUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func get(_ path: String) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
        let done = XCTestExpectation(description: path)
        nonisolated(unsafe) var result: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    /// A server whose Baú has at least one post with a public page, and how
    /// many of its posts do and do not.
    private func findServer() throws -> (id: String, shareable: Int, total: Int) {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]] else {
            throw XCTSkip("No API at \(TestSeed.apiBase)")
        }
        for server in servers {
            guard let id = server["id"] as? String,
                  let posts = get("/api/servers/\(id)/home/posts")?["posts"] as? [[String: Any]]
            else { continue }
            let shareable = posts.filter {
                ($0["publicUrl"] as? String).map { !$0.isEmpty } == true && $0["locked"] as? Bool != true
            }.count
            if shareable > 0 { return (id, shareable, posts.count) }
        }
        throw XCTSkip("No Baú post with a publicUrl on \(TestSeed.apiBase)")
    }

    func testAPublicPostOffersCompartilharAndOpensTheSheet() throws {
        let server = try findServer()

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()

        XCTAssertTrue(app.openServerFromHub(server.id))
        let bau = app.buttons["channels.bau"].firstMatch
        XCTAssertTrue(bau.waitForExistence(timeout: 15), "The server has a Baú")
        bau.tap()

        // The card's own `bau.post` identifier wins over its children's, so
        // the control is found by its accessibility label.
        let share = app.buttons.matching(
            NSPredicate(format: "label IN %@", ["Compartilhar esse post", "Share this post"])
        ).firstMatch
        let found = share.waitForExistence(timeout: 15)
        if !found {
            snap(app, "ios-bau-share-missing")
            print(app.debugDescription)
        }
        XCTAssertTrue(found, "A public post offers Compartilhar")
        snap(app, "ios-01-bau-share-control")
        if server.total > server.shareable {
            // Scroll to the end so every card has been built, then count:
            // a post with no public page has no control.
            let feed = app.scrollViews["bau.feed"]
            for _ in 0..<4 { feed.swipeUp() }
            snap(app, "ios-02-bau-no-share-on-private")
            for _ in 0..<4 { feed.swipeDown() }
        }

        XCTAssertTrue(share.waitForExistence(timeout: 5))
        share.tap()
        // The system sheet: its own process, so it is found by what it shows.
        let sheet = app.otherElements["ActivityListView"].firstMatch
        let copy = app.descendants(matching: .any)["Copiar"].firstMatch
        let copyEn = app.descendants(matching: .any)["Copy"].firstMatch
        XCTAssertTrue(
            sheet.waitForExistence(timeout: 10) || copy.waitForExistence(timeout: 2) || copyEn.exists,
            "The share sheet opened"
        )
        snap(app, "ios-03-share-sheet")
        // Copy, and read back the link the sheet was handed: the page the
        // server named, with the native campaign on it.
        let copyButton = copy.waitForExistence(timeout: 5) ? copy : copyEn
        XCTAssertTrue(copyButton.exists, "The sheet offers Copy")
        copyButton.tap()

        // The runner may not read another app's pasteboard, so the link is
        // pasted into the card's comment box (never sent) and read from there.
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.press(forDuration: 1.0)
        let paste = app.menuItems.matching(NSPredicate(format: "label IN %@", ["Colar", "Paste"])).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "The edit menu offers Paste")
        paste.tap()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            .buttons.matching(NSPredicate(format: "label IN %@", ["Permitir Colar", "Allow Paste"])).firstMatch
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        let link = (field.value as? String) ?? ""
        print("BAU_SHARE_COPIED \(link)")
        XCTAssertTrue(link.contains("/p/"), "The public page was shared: \(link)")
        XCTAssertTrue(link.hasSuffix("utm_source=native&utm_medium=share&utm_campaign=bau"), link)
        snap(app, "ios-04-copied-link-pasted")
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
