import XCTest
@testable import pqp

/// What the phone shows about activities, from data alone: which apps it may run,
/// what the launcher says about each, the strip's states, and the isolation of the
/// frame that runs an app.
@MainActor
final class ActivitiesRulesTests: XCTestCase {
    func app(
        _ id: String, channelTypes: [String] = ["text", "voice"], available: Bool = true,
        reason: AppUnavailableReason? = nil, spectators: Bool = true, shareAllowed: Bool = false,
        start: String = "USE_APPS", max: Int = 8
    ) -> AppEntry {
        AppEntry(
            id: id, channelTypes: channelTypes, players: AppPlayers(min: 1, max: max, spectators: spectators),
            requires: AppRequires(start: start), available: available, reason: reason, shareAllowed: shareAllowed
        )
    }

    // MARK: - What a phone may do

    func testEcoIsPlayableLocadoraIsWatchOnlyWhereItMayShareAndEverythingElseWaits() {
        XCTAssertEqual(AppPhoneSupport.of(app(AppIds.eco)), .participate)
        XCTAssertEqual(AppPhoneSupport.of(app(AppIds.locadora, shareAllowed: true)), .spectate)
        XCTAssertEqual(AppPhoneSupport.of(app(AppIds.locadora, shareAllowed: false)), .none,
                       "with sharing off there is no picture to watch")
        XCTAssertEqual(AppPhoneSupport.of(app("some-future-app")), .none)
    }

    // MARK: - Launcher

    func testTheReasonsComeInTheOrderAPersonMeetsThem() {
        let eco = app(AppIds.eco, channelTypes: ["voice"])
        XCTAssertEqual(LauncherRules.reason(for: eco, channelType: .text, canManageChannels: true, runningHere: nil), .voiceOnly)
        let off = app(AppIds.eco, available: false, reason: .ownerOff)
        XCTAssertEqual(LauncherRules.reason(for: off, channelType: .text, canManageChannels: true, runningHere: nil), .off)
        let community = app(AppIds.eco, available: false, reason: .communityLocked)
        XCTAssertEqual(LauncherRules.reason(for: community, channelType: .text, canManageChannels: true, runningHere: nil), .community)
        XCTAssertEqual(LauncherRules.reason(for: app("future"), channelType: .text, canManageChannels: true, runningHere: nil), .onComputer)
        XCTAssertEqual(LauncherRules.reason(for: app(AppIds.locadora, shareAllowed: true), channelType: .voice, canManageChannels: true, runningHere: nil), .watchOnly)
        let manage = app(AppIds.eco, start: "MANAGE_CHANNELS")
        XCTAssertEqual(LauncherRules.reason(for: manage, channelType: .text, canManageChannels: false, runningHere: nil), .needsManage)
        let other = AppSessionSummary(id: "s", appId: "something-else")
        XCTAssertEqual(LauncherRules.reason(for: app(AppIds.eco), channelType: .text, canManageChannels: true, runningHere: other), .otherRunning,
                       "one activity per channel")
        XCTAssertNil(LauncherRules.reason(for: app(AppIds.eco), channelType: .text, canManageChannels: true, runningHere: nil))
    }

    func testTheEntryIsInvisibleUnlessThePlatformIsOnAndSomethingIsUsable() {
        XCTAssertFalse(LauncherRules.offersEntry(config: nil, live: nil))
        XCTAssertFalse(LauncherRules.offersEntry(config: .off, live: nil))
        let on = AppsConfig(enabled: true, origin: "https://apps.example", apps: [app("future")])
        XCTAssertFalse(LauncherRules.offersEntry(config: on, live: nil), "nothing a phone can show or start")
        let withEco = AppsConfig(enabled: true, origin: "https://apps.example", apps: [app(AppIds.eco)])
        XCTAssertTrue(LauncherRules.offersEntry(config: withEco, live: nil))
        XCTAssertTrue(LauncherRules.offersEntry(config: on, live: AppSessionSummary(id: "s", appId: "future")),
                      "a live one is worth a strip even if the phone cannot run it")
        let noOrigin = AppsConfig(enabled: true, origin: nil, apps: [app(AppIds.eco)])
        XCTAssertFalse(LauncherRules.offersEntry(config: noOrigin, live: nil), "no apps origin means no app can run")
    }

    func testTheRunningTileStartsSelected() {
        let config = AppsConfig(enabled: true, origin: "x", apps: [app(AppIds.eco), app(AppIds.locadora, shareAllowed: true)])
        let tiles = LauncherRules.tiles(
            config: config, channelType: .voice, canManageChannels: true,
            live: AppSessionSummary(id: "s", appId: AppIds.locadora)
        )
        XCTAssertEqual(LauncherRules.initialSelection(tiles), AppIds.locadora)
    }

    // MARK: - Strip

    func input(
        _ live: AppSessionSummary, app: AppEntry? = nil, viewer: String? = "me", online: Bool = true,
        offlineSince: Date? = nil, now: Date = Date(), moderate: Bool = false, left: Bool = false,
        voice: Bool = false, inCall: Bool = false
    ) -> StripInput {
        StripInput(live: live, app: app ?? self.app(AppIds.eco), viewerId: viewer, online: online,
                   offlineSince: offlineSince, now: now, canModerate: moderate, leftLocally: left,
                   channelIsVoice: voice, inCallHere: inCall)
    }

    func session(host: String = "host", people: [(String, AppRole, AppConnection)] = [], players: Int? = nil) -> AppSessionSummary {
        AppSessionSummary(
            id: "s", appId: AppIds.eco, hostUserId: host,
            participants: people.map { AppSummaryParticipant(userId: $0.0, role: $0.1, connection: $0.2) },
            players: players
        )
    }

    func testSomebodyOutsideSeesJoinAndASeatedHostSeesNoButtonAndCanEnd() {
        let outside = StripRules.model(input(session(people: [("a", .player, .present)])))
        XCTAssertEqual(outside.phase, .outside)
        XCTAssertEqual(outside.enter, .join)
        XCTAssertFalse(outside.canEnd)

        let host = StripRules.model(input(session(host: "me", people: [("me", .player, .present)]), viewer: "me"))
        XCTAssertEqual(host.phase, .host)
        XCTAssertNil(host.enter)
        XCTAssertTrue(host.canEnd)

        let moderator = StripRules.model(input(session(), moderate: true))
        XCTAssertTrue(moderator.canEnd, "MANAGE_CHANNELS may end somebody else's")
    }

    func testAFullRoomOffersWatchingOnlyWhereTheAppAdmitsSpectators() {
        let full = session(people: (0..<8).map { ("p\($0)", .player, .present) })
        XCTAssertEqual(full.players, 8)
        let withSpectators = app(AppIds.eco, spectators: true, shareAllowed: true, max: 8)
        XCTAssertEqual(StripRules.model(input(full, app: withSpectators)).enter, .watch)
        let without = app(AppIds.eco, spectators: false, shareAllowed: true, max: 8)
        XCTAssertNil(StripRules.model(input(full, app: without)).enter)
    }

    func testASpectatorAndAReconnectingSeatAndALostOne() {
        let spectating = StripRules.model(input(session(people: [("me", .spectator, .present)])))
        XCTAssertEqual(spectating.phase, .spectator)

        let held = StripRules.model(input(session(people: [("me", .player, .reconnecting)])))
        XCTAssertEqual(held.phase, .reconnecting)

        let now = Date()
        let offline = StripRules.model(input(session(people: [("me", .player, .present)]), online: false,
                                             offlineSince: now.addingTimeInterval(-30), now: now))
        XCTAssertEqual(offline.phase, .reconnecting)
        let lost = StripRules.model(input(session(people: [("me", .player, .present)]), online: false,
                                          offlineSince: now.addingTimeInterval(-91), now: now))
        XCTAssertEqual(lost.phase, .lost, "past the 90 s hold the seat is gone")
        XCTAssertFalse(lost.canEnd)
    }

    func testPressingLeaveHidesTheSeatUntilTheSummaryCatchesUp() {
        let summary = session(people: [("me", .player, .present)])
        XCTAssertEqual(StripRules.model(input(summary, left: true)).phase, .outside)
        XCTAssertEqual(StripRules.model(input(summary, left: true)).enter, .join)
    }

    func testAHandoffNamesWhoTakesOver() {
        var summary = session(host: "gone", people: [("me", .player, .present)])
        summary.handoff = AppHandoff(toUserId: "me", at: Date().addingTimeInterval(60))
        XCTAssertEqual(StripRules.model(input(summary)).phase, .handoffYou)
        summary.handoff = AppHandoff(toUserId: "other", at: Date().addingTimeInterval(60))
        XCTAssertEqual(StripRules.model(input(summary)).phase, .handoffOther)
        XCTAssertEqual(StripRules.secondsUntil(Date().addingTimeInterval(-5), now: Date()), 0)
    }

    func testLocadoraOnAPhoneIsWatchedInTheCallNeverJoinedAndNeverInATextChannel() {
        let locadora = app(AppIds.locadora, shareAllowed: true)
        let live = AppSessionSummary(id: "s", appId: AppIds.locadora, hostUserId: "host")
        XCTAssertEqual(StripRules.model(input(live, app: locadora, voice: true)).enter, .watchInCall)
        XCTAssertNil(StripRules.model(input(live, app: locadora, voice: false)).enter, "a text channel has no call to watch it in")
        XCTAssertNil(StripRules.model(input(live, app: locadora, voice: true, inCall: true)).enter,
                     "already in the call: the picture is on that screen")
    }

    func testAnAppThisPhoneCannotRunGetsAStripButNoButton() {
        let live = AppSessionSummary(id: "s", appId: "future")
        let model = StripRules.model(input(live, app: app("future")))
        XCTAssertEqual(model.support, .none)
        XCTAssertNil(model.enter)
        var unlisted = input(live)
        unlisted.app = nil
        XCTAssertNil(StripRules.model(unlisted).enter, "an app the config does not list")
    }

    func testTheCountLine() {
        func count(_ players: Int, _ watching: Int, max: Int) -> StripCount {
            StripCount.of(model: ActivityStripModel(
                sessionId: "s", appId: "a", phase: .outside, seated: false, isHost: false, players: players,
                watching: watching, maxPlayers: max, hostUserId: nil, enter: nil, support: .participate,
                canEnd: false, channelIsVoice: false, people: []
            ))
        }
        XCTAssertEqual(count(0, 0, max: 8), .none)
        XCTAssertEqual(count(2, 1, max: 8), .of(players: 2, max: 8, watching: 1))
        XCTAssertEqual(count(5, 0, max: 64), .open(players: 5, watching: 0))
    }

    // MARK: - Avatars

    func testOnlyThisDeploymentsAvatarRouteIsFetchedFromTheDevice() {
        let backend = Backend.local
        XCTAssertTrue(AppAvatarCache.isOurAvatarRoute(URL(string: "http://localhost:3001/api/avatars/abc")!, backend: backend))
        XCTAssertFalse(AppAvatarCache.isOurAvatarRoute(URL(string: "https://evil.example/a.png")!, backend: backend),
                       "a user-set avatar URL must not make the phone call its owner")
        XCTAssertFalse(AppAvatarCache.isOurAvatarRoute(URL(string: "http://localhost.evil.example:3001/api/avatars/x")!, backend: backend))
    }

    func testAnAvatarIsDownsampledFromTheEncodedImageToASmallDataURL() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 2000))
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3000, height: 2000))
        }
        let png = try XCTUnwrap(image.pngData())
        let url = try XCTUnwrap(AppAvatarCache.shrunk(png))
        XCTAssertTrue(url.hasPrefix("data:image/jpeg;base64,"))
        XCTAssertLessThanOrEqual(url.count, AppLimits.avatarMaxChars)
        XCTAssertNil(AppAvatarCache.shrunk(Data("not an image".utf8)))
    }

    // MARK: - The frame

    func testAnEntryOffTheAppsOriginIsRefusedWithoutAWebView() {
        XCTAssertNotNil(AppFrameController(entry: "https://apps.example/pqp-eco/1.0.2/index.html", appsOrigin: "https://apps.example", title: "Eco"))
        XCTAssertNil(AppFrameController(entry: "https://evil.example/x.html", appsOrigin: "https://apps.example", title: "Eco"))
        XCTAssertNil(AppFrameController(entry: "http://apps.example/x.html", appsOrigin: "https://apps.example", title: "Eco"), "a different scheme is a different origin")
        XCTAssertNil(AppFrameController(entry: "https://apps.example:8443/x.html", appsOrigin: "https://apps.example", title: "Eco"))
        XCTAssertNil(AppFrameController(entry: "not a url", appsOrigin: "https://apps.example", title: "Eco"))
    }

    func testTheWrapperFramesTheAppSandboxedWithNoSameOriginAndNoScriptOfItsOwn() throws {
        let controller = try XCTUnwrap(AppFrameController(
            entry: "https://apps.example/pqp-eco/1.0.2/index.html", appsOrigin: "https://apps.example", title: "Eco \"quoted\" <b>"
        ))
        let html = controller.wrapperHTML
        XCTAssertTrue(html.contains(#"sandbox="allow-scripts""#))
        XCTAssertFalse(html.contains("allow-same-origin"), "an opaque origin: no cookies, no storage, no reach into the wrapper")
        XCTAssertFalse(html.contains("allow-popups") || html.contains("allow-top-navigation") || html.contains("allow-forms"))
        XCTAssertTrue(html.contains(#"allow="""#))
        XCTAssertTrue(html.contains(#"referrerpolicy="no-referrer""#))
        XCTAssertTrue(html.contains("frame-src https://apps.example;"), "the wrapper's own policy frames only the apps origin")
        XCTAssertTrue(html.contains("default-src 'none'"))
        XCTAssertFalse(html.contains("<script"), "the relay runs in an isolated world, never in the page")
        XCTAssertFalse(html.contains("<b>"), "the title is escaped")
        XCTAssertTrue(html.contains(#"src="https://apps.example/pqp-eco/1.0.2/index.html""#))
    }

    func testTheRelayAnswersOnlyTheFramesOwnWindowAndOnlyAnExactHello() {
        let script = AppFrameController.relayScript
        XCTAssertTrue(script.contains("event.source !== el.contentWindow"))
        XCTAssertTrue(script.contains(#"data.pqp !== "app-hello""#))
        XCTAssertTrue(script.contains("keys.length !== 2"), "an extra key is not a hello")
        XCTAssertTrue(script.contains("answered"), "only the first hello is answered")
        XCTAssertFalse(script.contains("localStorage") || script.contains("document.cookie"))
        XCTAssertFalse(script.contains("pqpToken"))
    }
}
