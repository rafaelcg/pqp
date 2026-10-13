import XCTest

/// The story editor on a simulator: text, drag, the bin, undo, the call
/// sticker, drawing, and a post that carries layers. Runs on the scripted
/// camera (`PQP_STORY_CAMERA=mock`) for the shot it edits; needs a dev server
/// with `STORIES=true` and a layers-aware API.
final class StoryEditorUITests: XCTestCase {
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

    private func launch() throws -> (XCUIApplication, String) {
        let config = request("GET", "/api/stories/config")
        try XCTSkipUnless(config?["enabled"] as? Bool == true, "STORIES is off on the dev server.")
        try XCTSkipUnless((config?["layersMax"] as? Int ?? 0) > 0, "The dev server predates layers.")
        let servers = request("GET", "/api/servers")?["servers"] as? [[String: Any]]
        let serverId = try XCTUnwrap(servers?.first?["id"] as? String, "No server")
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchEnvironment["PQP_STORY_CAMERA"] = "mock"
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        if ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] != nil {
            let language = ProcessInfo.processInfo.environment["PQP_QA_LANG"] ?? "pt-BR"
            app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", language.replacingOccurrences(of: "-", with: "_")]
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
        XCTAssertTrue(newStory.waitForExistence(timeout: 5))
        newStory.tap()
    }

    /// The text tool: types a line, takes the style, places it.
    private func addText(_ app: XCUIApplication, _ text: String) {
        let input = app.textViews["text.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10), "The text tool opens")
        input.typeText(text)
        app.buttons["text.done"].tap()
    }

    private func layer(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.descendants(matching: .any)[label].firstMatch
    }

    // MARK: - Tests

    /// The Text tab opens the editor on a card with the keyboard up. A line
    /// of text lands in the middle; Next, post.
    func testATextCardWithStyledText() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["composer.mode.text"].tap()
        let input = app.textViews["text.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 15))
        input.typeText("bora jogar")
        snap(app, "editor-text-typing")
        app.buttons["text.font.serif"].tap()
        app.buttons["text.color.lime"].tap()
        app.buttons["text.background"].tap()
        snap(app, "editor-text-styled")
        app.buttons["text.done"].tap()
        XCTAssertTrue(layer(app, "bora jogar").waitForExistence(timeout: 5), "The text is a layer on the canvas")
        snap(app, "editor-text-placed")
        XCTAssertTrue(app.buttons["editor.undo"].exists, "Placing it is undoable")
        app.buttons["composer.next"].tap()
        let post = app.buttons["audience.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 10))
        post.tap()
        XCTAssertTrue(app.buttons["stories.own"].waitForExistence(timeout: 20), "Posted, with the text as a layer")
    }

    /// Drag a layer and it follows the finger; drop it on the bin and it is gone.
    func testDragMovesALayerAndTheBinDeletesIt() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["composer.mode.text"].tap()
        addText(app, "arrasta")
        let element = layer(app, "arrasta")
        XCTAssertTrue(element.waitForExistence(timeout: 5))
        let before = element.frame.center
        // The canvas fills the width; the screen is the frame of reference.
        let window = app.windows.firstMatch.frame
        let canvasHeight = window.width * 16 / 9
        let canvasTop = window.minY + (window.height - canvasHeight) / 2
        func point(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
            app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: window.width * x, dy: canvasTop + canvasHeight * y))
        }
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.1, thenDragTo: point(0.25, 0.25), withVelocity: .slow, thenHoldForDuration: 0.2)
        snap(app, "editor-text-moved")
        XCTAssertGreaterThan(abs(element.frame.center.x - before.x), 40, "It moved left")
        XCTAssertGreaterThan(abs(element.frame.center.y - before.y), 40, "and up")
        // To the bin: bottom center of the canvas.
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: point(0.5, 0.94), withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(waitForGone(element), "Dropped on the bin")
        // And undo brings it back.
        app.buttons["editor.undo"].tap()
        XCTAssertTrue(layer(app, "arrasta").waitForExistence(timeout: 5))
    }

    /// Tapping a text layer opens it again.
    func testTappingTextEditsIt() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["composer.mode.text"].tap()
        addText(app, "um")
        layer(app, "um").tap()
        let input = app.textViews["text.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5), "The tool is back on that line")
        input.typeText(" dois")
        app.buttons["text.done"].tap()
        XCTAssertTrue(layer(app, "um dois").waitForExistence(timeout: 5))
    }

    /// A shot gets text on top of it, the sticker tray holds the call, and
    /// both post.
    func testAPhotoGetsTextAndACallSticker() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        XCTAssertTrue(app.buttons["camera.shutter"].waitForExistence(timeout: 15))
        app.buttons["camera.shutter"].tap()
        XCTAssertTrue(app.buttons["editor.text"].waitForExistence(timeout: 15), "The shot opens in the editor")
        snap(app, "editor-photo")
        app.buttons["editor.text"].tap()
        addText(app, "setup novo")
        XCTAssertTrue(layer(app, "setup novo").waitForExistence(timeout: 5))

        app.buttons["editor.stickers"].tap()
        snap(app, "editor-tray")
        app.buttons["tray.call"].tap()
        let room = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'composer.call.'")).firstMatch
        XCTAssertTrue(room.waitForExistence(timeout: 15), "The rooms are listed")
        sleep(1)
        snap(app, "editor-call-picker")
        room.tap()
        app.buttons["call.add"].tap()
        let sticker = app.descendants(matching: .any)["story.call.sticker"].firstMatch
        XCTAssertTrue(sticker.waitForExistence(timeout: 10), "The call is a layer on the canvas")
        snap(app, "editor-photo-layers")
        app.buttons["composer.next"].tap()
        let post = app.buttons["audience.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 10))
        post.tap()
        XCTAssertTrue(app.buttons["stories.own"].waitForExistence(timeout: 25), "Posted with a text layer and a call layer")
    }

    /// A mention: the stickers tray lists the people of the server, and the
    /// pick is a pill on the canvas.
    func testAMentionIsAStickerOnTheCanvas() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["composer.mode.text"].tap()
        addText(app, "olha quem chegou")
        app.buttons["editor.stickers"].tap()
        app.buttons["tray.mention"].tap()
        let person = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'mention.person.'")).firstMatch
        XCTAssertTrue(person.waitForExistence(timeout: 15), "The server's people are listed")
        snap(app, "editor-mention-picker")
        person.tap()
        let pill = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH '@'")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "The mention is on the canvas")
        snap(app, "editor-mention-placed")
    }

    /// Drawing: a stroke, Done, and the story has a drawing to undo.
    func testDrawingIsALayerOfItsOwn() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["camera.shutter"].tap()
        XCTAssertTrue(app.buttons["editor.draw"].waitForExistence(timeout: 15))
        app.buttons["editor.draw"].tap()
        let canvas = app.descendants(matching: .any)["draw.canvas"].firstMatch
        XCTAssertTrue(canvas.waitForExistence(timeout: 5))
        let a = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3))
        let b = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        app.buttons["draw.color.lime"].tap()
        a.press(forDuration: 0.05, thenDragTo: b)
        snap(app, "editor-drawing")
        app.buttons["draw.done"].tap()
        XCTAssertTrue(app.buttons["editor.undo"].waitForExistence(timeout: 5), "The drawing is an undoable layer")
        snap(app, "editor-drawn")
        app.buttons["composer.next"].tap()
        let post = app.buttons["audience.post"]
        XCTAssertTrue(post.waitForExistence(timeout: 10))
        post.tap()
        XCTAssertTrue(app.buttons["stories.own"].waitForExistence(timeout: 25), "Posted with the drawing uploaded as a PNG")
    }

    /// Closing an edited story asks first.
    func testClosingAnEditedStoryAsksToDiscard() throws {
        let (app, serverId) = try launch()
        openComposer(app, serverId: serverId)
        app.buttons["composer.mode.text"].tap()
        addText(app, "vai sumir")
        app.buttons["editor.close"].tap()
        let discard = app.buttons["Descartar"].exists ? app.buttons["Descartar"] : app.buttons["Discard"]
        XCTAssertTrue(discard.waitForExistence(timeout: 5))
        snap(app, "editor-discard")
        discard.tap()
        XCTAssertTrue(app.buttons["camera.shutter"].waitForExistence(timeout: 10), "Back on the camera")
    }

    // MARK: - Helpers

    private func waitForGone(_ element: XCUIElement, timeout: TimeInterval = 6) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
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

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}
