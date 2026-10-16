import XCTest

/// Voice note transcripts: the text under a note, "ver mais" on a long one,
/// "Transcrever" on a note with none, and the two Settings switches.
///
/// NEEDS an API started with `VOICE_NOTES=true VOICE_NOTE_TRANSCRIPTION=true`
/// and three notes from a second account in Destino QA #general (a `done` with
/// text, one with `none`, a long `done`), seeded in the database; SKIPS without
/// them. Not run in CI:
///
///     TEST_RUNNER_PQP_TEST_API_BASE=http://localhost:3110 \
///     TEST_RUNNER_PQP_QA_SHOTS=/tmp/transcript-shots \
///     xcodebuild test -only-testing:pqpUITests/VoiceTranscriptUITests …
final class VoiceTranscriptUITests: XCTestCase {
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

    private func shot(_ app: XCUIApplication, _ name: String) {
        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["PQP_QA_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: "\(directory)/\(name).png"))
        }
    }

    func testTranscriptsShowWithMoreAndTranscribe() throws {
        guard get("/api/attachments/config")?["voiceTranscription"] as? Bool == true,
              let servers = get("/api/servers")?["servers"] as? [[String: Any]],
              let destino = servers.first(where: { $0["name"] as? String == "Destino QA" })?["id"] as? String,
              let channels = get("/api/servers/\(destino)/channels")?["channels"] as? [[String: Any]],
              let channel = channels.first(where: { $0["name"] as? String == "general" })?["id"] as? String,
              let messages = get("/api/channels/\(channel)/messages")?["messages"] as? [[String: Any]],
              messages.contains(where: { (($0["attachments"] as? [[String: Any]])?.first?["voice"] as? [String: Any])?["transcript"] != nil })
        else { throw XCTSkip("No transcript flag or no seeded voice notes on \(TestSeed.apiBase)") }
        TestSeed.passAgeGate(self)

        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        XCTAssertTrue(app.openServerFromHub(destino))
        let general = app.buttons.matching(NSPredicate(format: "label CONTAINS 'general'")).firstMatch
        XCTAssertTrue(general.waitForExistence(timeout: 15))
        general.tap()

        let text = app.staticTexts.matching(identifier: "voice.transcript.text").firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 20), "A note with a transcript shows its text")
        XCTAssertTrue(text.label.contains("bora jogar") || text.label.contains("audio bem longo"), text.label)
        shot(app, "01-transcripts")
        let more = app.buttons["voice.transcript.more"].firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 5), "A long transcript offers Show more")
        more.tap()
        shot(app, "02-expanded")
        XCTAssertTrue(app.buttons["voice.transcript.request"].firstMatch.exists, "A note with none yet offers Transcribe")
    }

    func testTheSettingsHaveBothTranscriptionSwitchesOnByDefault() throws {
        guard get("/api/attachments/config")?["voiceTranscription"] as? Bool == true else {
            throw XCTSkip("No transcript flag on \(TestSeed.apiBase)")
        }
        TestSeed.passAgeGate(self)
        let app = XCUIApplication()
        app.launchEnvironment.merge(TestSeed.launchEnvironment) { _, new in new }
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES", "-pqp.lastVisited", ""]
        app.launch()
        // You > the gear.
        let dock = app.staticTexts["Dev User"].firstMatch
        XCTAssertTrue(dock.waitForExistence(timeout: 20))
        dock.tap()
        let gear = app.buttons.matching(NSPredicate(format: "label IN %@", ["Settings", "Ajustes", "Configurações"])).firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 10))
        gear.tap()
        let show = app.switches["settings.showTranscripts"]
        // A form draws its rows lazily: scroll to it.
        var swipes = 0
        while !show.waitForExistence(timeout: 2), swipes < 6 {
            app.swipeUp()
            swipes += 1
        }
        shot(app, "03-settings")
        XCTAssertTrue(show.exists, "The switches are there where transcription exists")
        XCTAssertEqual(show.value as? String, "1", "On until turned off")
        XCTAssertTrue(app.switches["settings.transcribeMine"].exists)
    }
}
