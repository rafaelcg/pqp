import XCTest

/// Baú video subtitles: a video whose post says `captions` offers the CC
/// control, the control flips, and the line is drawn over the playing picture
/// (seen in the screenshots, not asserted: the overlay is deliberately not an
/// accessibility element).
///
/// READ ONLY, and it seeds nothing: a post only has captions on a server with
/// `community_home_video_captions` on and a transcribed video, which is a
/// worker job. It looks for a server the dev user belongs to whose feed has a
/// post with `captions` and SKIPS when there is none. Like the rest of
/// `pqpUITests` it is not run in CI. Locally:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/bau-captions-shots \
///     xcodebuild test -only-testing:pqpUITests/BauCaptionsUITests …
final class BauCaptionsUITests: XCTestCase {
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

    private func findServer() throws -> String {
        guard let servers = get("/api/servers")?["servers"] as? [[String: Any]] else {
            throw XCTSkip("No API at \(TestSeed.apiBase)")
        }
        for server in servers {
            guard let id = server["id"] as? String,
                  let posts = get("/api/servers/\(id)/home/posts")?["posts"] as? [[String: Any]]
            else { continue }
            if posts.contains(where: { $0["captions"] is [String: Any] && $0["locked"] as? Bool != true }) {
                return id
            }
        }
        throw XCTSkip("No Baú video with captions on \(TestSeed.apiBase)")
    }

    func testTheCaptionsButtonFlipsAndTheLineShowsOverThePicture() throws {
        let serverId = try findServer()

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()

        XCTAssertTrue(app.openServerFromHub(serverId))
        let bau = app.buttons["channels.bau"].firstMatch
        XCTAssertTrue(bau.waitForExistence(timeout: 15), "The server has a Baú")
        bau.tap()

        let labels = ["Turn subtitles on", "Turn subtitles off", "Ligar legendas", "Desligar legendas"]
        let toggle = app.buttons.matching(NSPredicate(format: "label IN %@", labels)).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 15), "A video with captions offers CC")
        let before = toggle.label
        snap(app, "ios-captions-01-feed")

        // Play: the system's own controls come up on a tap.
        // The card's own identifier hides its children, so the picture is
        // reached by where it sits: the first card's media, a third down.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.39)).tap()
        let play = app.buttons.matching(NSPredicate(format: "label IN %@", ["Play", "Reproduzir"])).firstMatch
        if play.waitForExistence(timeout: 5) { play.tap() }
        // Cue 1 runs 0.5 to 3 s, cue 3 (two lines) 6.5 to 9.5 s.
        Thread.sleep(forTimeInterval: 1.5)
        snap(app, "ios-captions-02-playing-line-one")
        Thread.sleep(forTimeInterval: 5.2)
        snap(app, "ios-captions-03-playing-two-lines")

        // Flip it: the label changes, and the same moment shows or loses the line.
        toggle.tap()
        XCTAssertNotEqual(toggle.label, before, "CC flips")
        snap(app, "ios-captions-04-flipped")
        // And back, so the next run starts from where this one did.
        toggle.tap()
        XCTAssertEqual(toggle.label, before)
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
