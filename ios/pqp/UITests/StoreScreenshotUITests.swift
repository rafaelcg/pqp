import XCTest

/// Drives the app through the screens that make up the App Store listing and
/// writes each one out at native resolution.
///
/// Not an assertion suite — it is a capture harness, so every step is
/// best-effort and logged rather than fatal: a screen that cannot be reached
/// should cost one screenshot, not the whole set. It needs a running local
/// server (`pnpm dev` with `DEV_AUTH_BYPASS=true`) seeded with the content
/// described in `/tmp/asc/ids.json`, and it writes PNGs to `outDir`.
final class StoreScreenshotUITests: XCTestCase {
    private let outDir = ProcessInfo.processInfo.environment["PQP_SHOT_DIR"]
        ?? "/tmp/asc/shots"
    // "en" or "pt-BR". Drives both the simulator's system language (so the
    // app itself renders in that language, the same override
    // `LocalizationUITests` uses) and the handful of plain-text lookups below
    // that cannot be identifier-based because the view never gave them one.
    private let locale = ProcessInfo.processInfo.environment["PQP_SHOT_LOCALE"] ?? "en"
    private var ids: [String: String] = [:]

    override func setUp() {
        continueAfterFailure = true
        let data = FileManager.default.contents(atPath: "/tmp/asc/ids.json") ?? Data()
        ids = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] ?? [:]
        print("SHOT-IDS: \(ids) locale=\(locale)")
    }

    /// One of the exact strings `Localizable.xcstrings` carries for `key`,
    /// picked by `locale`. Only for the few lookups in this file that have no
    /// accessibility identifier to match on instead.
    private func t(_ key: String) -> String {
        let table: [String: [String: String]] = [
            "Settings": ["en": "Settings", "pt-BR": "Ajustes"],
            "All": ["en": "All", "pt-BR": "Tudo"],
            "Skip": ["en": "Skip", "pt-BR": "Pular"],
        ]
        return table[key]?[locale] ?? table[key]?["en"] ?? key
    }

    private var localeLaunchArguments: [String] {
        locale == "en" ? [] : ["-AppleLanguages", "(\(locale))", "-AppleLocale", locale.replacingOccurrences(of: "-", with: "_")]
    }

    private func shoot(_ name: String) {
        // Let animations land: a screenshot taken mid-transition catches a
        // half-faded sheet, which is worse than no screenshot at all.
        Thread.sleep(forTimeInterval: 4.0)   // AsyncImage avatars + inline images
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let path = "\(outDir)/\(name).png"
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print("SHOT-OK: \(path) bytes=\(png.count)")
        } catch {
            print("SHOT-FAIL: \(path) \(error)")
        }
    }

    private func back(_ app: XCUIApplication) {
        let bar = app.navigationBars.firstMatch
        if bar.buttons.count > 0 {
            bar.buttons.element(boundBy: 0).tap()
        } else {
            app.swipeRight()
        }
        Thread.sleep(forTimeInterval: 0.8)
    }

    /// Signals the host to place a call to this device, then waits for the
    /// incoming-call UI. The marker file is the handshake: the simulator and
    /// the host share a filesystem, so a watcher on the host can fire the
    /// WebSocket `call-ring` at exactly the moment the app is looking at the
    /// conversation.
    private func requestRing(_ app: XCUIApplication) -> Bool {
        let marker = "\(outDir)/RING_NOW"
        try? "ring".write(toFile: marker, atomically: true, encoding: .utf8)
        print("SHOT-RING: marker written")
        return app.buttons["call.accept"].waitForExistence(timeout: 45)
    }

    func testCaptureStoreScreenshots() {
        let app = XCUIApplication()
        // `-pqp.lastVisited ""` matters as much as the onboarding flag: the app
        // restores the screen you left, so without this the first capture is
        // whatever the previous run was looking at rather than the hub.
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "YES",
                               "-pqp.lastVisited", ""] + localeLaunchArguments
        app.launch()

        // 1 — the hub: server rail plus direct messages.
        XCTAssertTrue(app.scrollViews["hub.serverRail"].waitForExistence(timeout: 20),
                      "the hub should load against the local server")
        shoot("01-hub")

        // 2 — a lively text channel.
        if let serverId = ids["serverId"], app.openServerFromHub(serverId) {
            // 2a — the channel list: text channels plus a voice channel that
            // already has people sitting in it.
            Thread.sleep(forTimeInterval: 2.0)
            shoot("02-channels")

            let general = app.staticTexts[ids["generalName"] ?? "geral"]
            if general.waitForExistence(timeout: 10) {
                general.tap()
                Thread.sleep(forTimeInterval: 3.0)   // transcript + inline image
                shoot("03-channel")
                back(app)
            } else { print("SHOT-SKIP: text channel not found") }

            // 3 — a voice channel with people already in it. Selecting the row
            // only opens its thread (see the comment on `chat.joinVoice`); this
            // app's own account has to actually join to see the call stage
            // with the roster the seed script seated ahead of time.
            let voice = app.staticTexts[ids["voiceName"] ?? "bar-do-ze"]
            if voice.waitForExistence(timeout: 10) {
                voice.tap()
                Thread.sleep(forTimeInterval: 1.5)
                let join = app.buttons["chat.joinVoice"]
                if join.waitForExistence(timeout: 5) {
                    join.tap()
                    Thread.sleep(forTimeInterval: 4.0)   // roster arrives over the socket
                    shoot("04-voice")
                    if app.buttons["voice.leave"].waitForExistence(timeout: 3) {
                        app.buttons["voice.leave"].tap()
                        Thread.sleep(forTimeInterval: 1.0)
                    }
                } else {
                    print("SHOT-SKIP: chat.joinVoice button not found")
                    shoot("04-voice")
                }
            } else { print("SHOT-SKIP: voice channel not found") }
            back(app)
            back(app)
        } else { print("SHOT-SKIP: server not reachable") }

        // 4 — an incoming call in a DM.
        if let dmId = ids["dmId"] {
            let dm = app.buttons["hub.conversation.\(dmId)"]
            if dm.waitForExistence(timeout: 10) {
                dm.tap()
                Thread.sleep(forTimeInterval: 2.0)
                shoot("05-dm")
                if requestRing(app) {
                    shoot("06-incoming-call")
                    if app.buttons["call.decline"].exists { app.buttons["call.decline"].tap() }
                } else {
                    print("SHOT-SKIP: the ring never arrived")
                }
                Thread.sleep(forTimeInterval: 1.0)
                back(app)
            } else { print("SHOT-SKIP: dm row not found") }
        }

        // 5 — friends.
        let friends = app.buttons["hub.friends"]
        if friends.waitForExistence(timeout: 10) {
            friends.tap()
            Thread.sleep(forTimeInterval: 2.0)
            if app.buttons[t("All")].exists {
                app.buttons[t("All")].tap()
            } else if app.staticTexts[t("All")].exists {
                app.staticTexts[t("All")].tap()
            }
            shoot("07-friends")
            back(app)
        } else { print("SHOT-SKIP: friends button not found") }

        // 6 — the profile / settings screen.
        let profile = app.buttons["hub.profile"]
        if profile.waitForExistence(timeout: 10) {
            profile.tap()
            Thread.sleep(forTimeInterval: 2.0)
            shoot("08-profile")
            let settings = app.buttons[t("Settings")]
            if settings.waitForExistence(timeout: 5) {
                settings.tap()
                Thread.sleep(forTimeInterval: 2.0)
                shoot("09-settings")
            } else { print("SHOT-SKIP: settings button not found") }
        } else { print("SHOT-SKIP: profile button not found") }
    }

    /// The onboarding hero, captured from a fresh install state.
    func testCaptureOnboarding() {
        let app = XCUIApplication()
        app.launchArguments += ["-pqp.hasCompletedOnboarding", "NO",
                               "-pqp.lastVisited", ""] + localeLaunchArguments
        app.launch()
        if app.buttons[t("Skip")].waitForExistence(timeout: 15) {
            shoot("00-onboarding")
        } else {
            print("SHOT-SKIP: onboarding did not appear")
        }
    }
}
