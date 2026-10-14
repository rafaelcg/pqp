import XCTest

/// The story camera on a simulator, which has no capture device: the scripted
/// camera (`PQP_STORY_CAMERA=mock`, debug builds only) stands in for the
/// hardware, and everything above it is the real code. A real-device pass on a
/// phone is still owed for the capture itself.
///
/// Needs a dev server with `STORIES=true`; skipped when it is off.
final class StoryCameraUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @discardableResult
    private func request(_ method: String, _ path: String) -> [String: Any]? {
        var request = URLRequest(url: URL(string: "\(TestSeed.apiBase)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(TestSeed.token())", forHTTPHeaderField: "Authorization")
        let done = XCTestExpectation(description: "\(method) \(path)")
        nonisolated(unsafe) var json: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data { json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return json
    }

    private func launch(_ extra: [String: String] = ["PQP_STORY_CAMERA": "mock"]) throws -> (XCUIApplication, String) {
        try XCTSkipUnless(request("GET", "/api/stories/config")?["enabled"] as? Bool == true, "STORIES is off on the dev server.")
        let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]]
        let serverId = try XCTUnwrap(servers?.first?["id"] as? String, "No server")
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchEnvironment.merge(extra) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            let language = ProcessInfo.processInfo.environment["PQP_QA_LANG"] ?? "pt-BR"
            let locale = language.replacingOccurrences(of: "-", with: "_")
            app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", locale]
        }
        app.launch()
        TestSeed.passAgeGate(self)
        return (app, serverId)
    }

    private func openComposer(_ app: XCUIApplication, serverId: String) {
        app.buttons["hub.server.\(serverId)"].tap()
        let more = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'More' OR label == 'Mais'")).firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 15))
        more.tap()
        let newStory = app.buttons["Novo story"].exists ? app.buttons["Novo story"] : app.buttons["New story"]
        XCTAssertTrue(newStory.waitForExistence(timeout: 5), "The server menu opens the composer")
        newStory.tap()
    }

    private func preview(_ app: XCUIApplication) -> XCUIElement {
        app.staticTexts["camera.mock.preview"]
    }

    // MARK: - Tests

    /// Opens on the camera; a tap on the shutter is a photo; the photo posts.
    func testTapForAPhotoThenPost() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        XCTAssertTrue(preview(app).waitForExistence(timeout: 15), "The composer opens on the camera")
        XCTAssertFalse(app.buttons["composer.next"].exists, "Nothing to post yet")
        snap(app, "camera-live")
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 5))
        shutter.tap()
        let next = app.buttons["composer.next"]
        XCTAssertTrue(next.waitForExistence(timeout: 15), "The shot is a draft")
        XCTAssertFalse(shutter.exists, "The camera is released while the draft is up")
        snap(app, "camera-photo-draft")
        next.tap()
        let post = app.buttons["audience.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 10))
        post.tap()
        XCTAssertTrue(app.buttons["stories.own"].waitForExistence(timeout: 20), "Back on the list with the photo up")
    }

    /// Post closes the composer at once; when the connection fails the draft is
    /// kept on the own ring, with "Try again" and "Discard", and a retry posts it.
    func testAFailedPostKeepsItsDraftUntilItIsRetried() throws {
        let (app, serverId) = try launch(["PQP_STORY_CAMERA": "mock", "PQP_STORY_POST_FAIL": "once"])
        openComposer(app, serverId: serverId)
        app.buttons["camera.shutter"].tap()
        XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 15))
        app.buttons["composer.next"].tap()
        let post = app.buttons["audience.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 10))
        post.tap()
        XCTAssertTrue(post.waitForNonExistence(timeout: 5), "The composer is gone as soon as Post is tapped")
        XCTAssertFalse(app.buttons["camera.shutter"].exists)
        let own = app.buttons["stories.own"]
        XCTAssertTrue(own.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label CONTAINS[c] \"didn't post\" OR label CONTAINS[c] 'não postou'")).firstMatch.waitForExistence(timeout: 10),
            "The failure shows on the own ring"
        )
        snap(app, "post-failed-ring")
        own.tap()
        let retry = app.buttons["Try again"].exists ? app.buttons["Try again"] : app.buttons["Tentar de novo"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5), "Tentar de novo is offered")
        XCTAssertTrue((app.buttons["Discard"].exists ? app.buttons["Discard"] : app.buttons["Descartar"]).exists, "So is Descartar")
        retry.tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label == 'Your story' OR label == 'Teu story'")).firstMatch.waitForExistence(timeout: 30),
            "The retry posts the same draft"
        )
    }

    /// The X over a draft goes back to the camera, not out of the composer.
    func testDiscardingAShotGoesBackToTheCamera() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["camera.shutter"].tap()
        XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 15))
        // The editor's X (the composer's own X is under the camera).
        (app.buttons["editor.close"].exists ? app.buttons["editor.close"] : app.buttons["composer.close"]).tap()
        XCTAssertTrue(app.buttons["camera.shutter"].waitForExistence(timeout: 10), "Back on the camera")
        XCTAssertFalse(app.buttons["composer.next"].exists)
    }

    func testFlipAndDoubleTapSwitchCameras() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        let view = preview(app)
        XCTAssertTrue(view.waitForExistence(timeout: 15))
        XCTAssertEqual(view.value as? String, "back")
        app.buttons["camera.flip"].tap()
        XCTAssertTrue(waitForValue(view, "front"), "The flip button turns to the selfie camera")
        snap(app, "camera-front")
        // Double tap anywhere on the preview flips back.
        view.doubleTap()
        XCTAssertTrue(waitForValue(view, "back"), "Double tap flips")
    }

    func testHoldForAVideo() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 15))
        shutter.press(forDuration: 2.2)
        XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 20), "A held shutter makes a video draft")
        snap(app, "camera-video-draft")
    }

    /// A video longer than 30 s is trimmed, not refused.
    func testALongVideoOpensTheTrimmer() throws {
        let (app, serverId) = try launch(["PQP_STORY_CAMERA": "mock", "PQP_STORY_FIXTURE_VIDEO": "36"])
        openComposer(app, serverId: serverId)
        let strip = app.otherElements["trim.strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 30), "A 36 s clip asks which 30 s")
        XCTAssertTrue(app.staticTexts["trim.range"].exists)
        sleep(2)
        snap(app, "camera-trim")
        strip.swipeRight()
        app.buttons["trim.use"].tap()
        XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 30), "The chosen part is the draft")
    }

    /// No camera at all: the screen says so and still offers the gallery and files.
    func testNoCameraStillOffersTheGalleryAndFiles() throws {
        let (app, serverId) = try launch([:])
        openComposer(app, serverId: serverId)
        XCTAssertTrue(app.staticTexts["camera.refusal.title"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["composer.gallery"].exists)
        XCTAssertTrue(app.buttons["camera.files"].exists)
        snap(app, "camera-no-device")
    }

    /// A refused permission sends the person to Settings.
    func testDeniedCameraOffersSettings() throws {
        let (app, serverId) = try launch(["PQP_STORY_CAMERA_ACCESS": "denied"])
        openComposer(app, serverId: serverId)
        XCTAssertTrue(app.staticTexts["camera.refusal.title"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["camera.openSettings"].exists)
        XCTAssertTrue(app.buttons["composer.gallery"].exists)
        snap(app, "camera-denied")
    }

    // MARK: - Leaving a video (freeze reports)

    /// A recorded clip, then the editor's X: back on a camera that answers a
    /// touch, again and again.
    func testDiscardingAVideoGoesBackToALiveCamera() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 15))
        for round in 1...3 {
            shutter.press(forDuration: 1.6)
            XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 20), "Round \(round): the clip is a draft")
            snap(app, "freeze-draft-\(round)")
            app.buttons["editor.close"].tap()
            XCTAssertTrue(shutter.waitForExistence(timeout: 10), "Round \(round): back on the camera")
            snap(app, "freeze-camera-\(round)")
            XCTAssertTrue(preview(app).waitForExistence(timeout: 10), "Round \(round): the preview is up")
            XCTAssertTrue(app.buttons["camera.flip"].isHittable, "Round \(round): the camera answers")
        }
        // And it still shoots.
        shutter.tap()
        XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 15), "A photo after the clips")
    }

    /// The composer's own X, after a clip was shot and discarded: the list
    /// answers, nothing is left over the screen.
    func testClosingTheComposerAfterDiscardingAVideo() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 15))
        shutter.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["editor.close"].waitForExistence(timeout: 20))
        app.buttons["editor.close"].tap()
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))
        XCTAssertTrue(preview(app).waitForExistence(timeout: 10))
        app.buttons["composer.close"].tap()
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: shutter)
        XCTAssertEqual(XCTWaiter().wait(for: [closed], timeout: 20), .completed, "The composer is gone")
        snap(app, "freeze-closed-after-discard")
        XCTAssertFalse(app.buttons["composer.close"].exists)
        // What is underneath answers a touch again.
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'hub.server.'")).firstMatch.waitForExistence(timeout: 10)
            || app.navigationBars.firstMatch.waitForExistence(timeout: 10))
    }

    /// X twice in a row on the editor, then a new clip.
    func testDoubleTapOnTheEditorCloseThenRecordAgain() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        let shutter = app.buttons["camera.shutter"]
        XCTAssertTrue(shutter.waitForExistence(timeout: 15))
        shutter.press(forDuration: 1.6)
        let close = app.buttons["editor.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 20))
        close.doubleTap()
        XCTAssertTrue(shutter.waitForExistence(timeout: 10), "Back on the camera")
        sleep(1)
        snap(app, "freeze-after-double-x")
        shutter.press(forDuration: 1.6)
        XCTAssertTrue(app.buttons["composer.next"].waitForExistence(timeout: 20), "A second clip is a draft")
    }

    // MARK: - Helpers

    private func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 8) -> Bool {
        let predicate = NSPredicate(format: "value == %@", value)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            let language = ProcessInfo.processInfo.environment["PQP_QA_LANG"] ?? "pt-BR"
            try? app.screenshot().pngRepresentation
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).\(language).png"))
        }
    }
}
