import XCTest

/// A YouTube post in the Baú plays in the card instead of leaving the app.
///
/// Needs a dev server started with `COMMUNITY_HOME_ENABLED=true` and the
/// network (the player is YouTube's). Skipped when the Baú is off there, since
/// turning it on means restarting somebody's server.
final class BauYoutubeUITests: XCTestCase {
    private var serverId = ""

    override func setUp() {
        continueAfterFailure = false
    }

    override func tearDown() {
        TestSeed.deleteServer(self, id: serverId)
    }

    @discardableResult
    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) -> (Int, [String: Any]?) {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let done = XCTestExpectation(description: "\(method) \(path)")
        nonisolated(unsafe) var result: (Int, [String: Any]?) = (0, nil)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            result = ((response as? HTTPURLResponse)?.statusCode ?? 0, json)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    func testAYoutubePostPlaysInTheCard() throws {
        let server = TestSeed.createServer(self, prefix: "Baú YouTube")
        serverId = server.id
        let (status, _) = request("PATCH", "/api/servers/\(server.id)/home/config", body: ["enabled": true])
        try XCTSkipUnless(status == 200, "The Baú is off on the dev server (\(status)).")
        let (created, _) = request("POST", "/api/servers/\(server.id)/home/posts", body: [
            "title": "Big Buck Bunny",
            "body": "Toca aqui mesmo",
            "youtubeUrl": "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
            "visibility": "free",
            "status": "published",
        ])
        XCTAssertTrue((200..<300).contains(created), "Could not seed the post (\(created))")

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            app.launchArguments += ["-AppleLanguages", "(pt-BR)", "-AppleLocale", "pt_BR"]
        }
        app.launch()
        TestSeed.passAgeGate(self)

        XCTAssertTrue(app.openServerFromHub(server.id))
        let bau = app.buttons["channels.bau"].firstMatch
        XCTAssertTrue(bau.waitForExistence(timeout: 15), "The server has a Baú")
        bau.tap()

        // The card's own `bau.post` identifier wins over its children's, so
        // the poster is found by its label: the media name, "YouTube".
        let poster = app.buttons["YouTube"].firstMatch
        let found = poster.waitForExistence(timeout: 15)
        if !found {
            snap(app, "bau-youtube-missing")
            print(app.debugDescription)
        }
        XCTAssertTrue(found, "The YouTube card shows its poster")
        XCTAssertTrue(app.buttons["Abrir no YouTube"].exists || app.buttons["Open on YouTube"].exists,
                      "The way out is explicit")
        XCTAssertEqual(poster.frame.width / poster.frame.height, 16 / 9, accuracy: 0.05, "16:9 card")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Nothing from YouTube loads before the tap")
        snap(app, "bau-youtube-poster")

        poster.tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15), "The tap builds the player")
        // Give the IFrame Player time to load and start.
        sleep(12)
        snap(app, "bau-youtube-playing")
        XCTAssertEqual(app.state, .runningForeground, "The tap did not leave the app")
        XCTAssertFalse(app.descendants(matching: .any)["bau.media.youtube.failed"].exists, "The player did not refuse")

        // Leaving the Baú lets the player go; coming back shows the poster.
        app.buttons["BackButton"].firstMatch.tap()
        XCTAssertTrue(bau.waitForExistence(timeout: 10), "Back on the channel list")
        XCTAssertFalse(app.webViews.firstMatch.exists, "The web view went with the card")
        bau.tap()
        XCTAssertTrue(app.buttons["YouTube"].firstMatch.waitForExistence(timeout: 15), "The card is its poster again")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Nothing from YouTube until the next tap")
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
