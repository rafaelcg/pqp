import XCTest
@testable import pqp

/// The sandbox bridge (docs/APPS.md "The bridge") with a fake session and no
/// webview: what an untrusted app may ask, what the host refuses, and that what
/// goes back to it never carries an id, a token or a server.
@MainActor
final class ActivitiesBridgeTests: XCTestCase {
    final class FakeTransport: AppBridgeTransport {
        var patches: [(JSONValue, Int?)] = []
        var events: [(String, JSONValue)] = []
        var ended = 0
        var patchResult: Result<Int, AppTransportError> = .success(5)
        var endResult: Result<Void, AppTransportError> = .success(())

        func patchState(_ patch: JSONValue, baseRev: Int?) async throws -> Int {
            patches.append((patch, baseRev))
            return try patchResult.get()
        }
        func sendEvent(name: String, data: JSONValue) { events.append((name, data)) }
        func endSession() async throws {
            ended += 1
            try endResult.get()
        }
    }

    var out: [JSONValue] = []
    var transport = FakeTransport()

    func makeBridge(
        app: AppEntry = AppEntry(id: "pqp-eco", state: AppStateCaps(maxBytes: 64, maxWritesPerSecond: 10, writers: "participants"),
                                 events: AppEventCaps(maxPerSecond: 2, maxBytes: 32)),
        role: AppRole = .player, isHost: Bool = true, attach: Bool = true
    ) -> AppBridge {
        out = []
        transport = FakeTransport()
        let bridge = AppBridge(
            options: .init(app: app, locale: "pt-BR", theme: ["--color-text": "rgb(1 2 3)"], reducedMotion: true),
            transport: transport, post: { [unowned self] in self.out.append($0) }
        )
        bridge.applySnapshot(AppSeatSnapshot(
            sessionId: "s", seatId: "AAAAAAAAAAAAAAAAAAAAAA", role: role, isHost: isHost, stateRev: 1,
            stateValue: .object(["count": .number(1)])
        ))
        if attach { bridge.attach() }
        out = []
        return bridge
    }

    /// Sends one request and lets the async handler finish.
    func send(_ bridge: AppBridge, _ json: String) async {
        bridge.receive(json)
        try? await Task.sleep(for: .milliseconds(30))
    }

    func last(_ key: String) -> String? { out.last?[key]?.stringValue }

    // MARK: - hello

    func testHelloCarriesTheSeatTheThemeAndNoIdentifiers() {
        out = []
        let bridge = makeBridge(attach: false)
        out = []
        bridge.attach()
        guard let hello = out.first else { return XCTFail() }
        XCTAssertEqual(hello["type"]?.stringValue, "hello")
        XCTAssertEqual(hello["platformApi"]?.intValue, 1)
        XCTAssertEqual(hello["app"]?["id"]?.stringValue, "pqp-eco")
        XCTAssertEqual(hello["self"]?["seatId"]?.stringValue, "AAAAAAAAAAAAAAAAAAAAAA")
        XCTAssertEqual(hello["self"]?["role"]?.stringValue, "player")
        XCTAssertEqual(hello["self"]?["isHost"]?.boolValue, true)
        XCTAssertEqual(hello["theme"]?["--color-text"]?.stringValue, "rgb(1 2 3)")
        XCTAssertEqual(hello["reducedMotion"]?.boolValue, true)
        XCTAssertEqual(hello["connection"]?.stringValue, "online")
        let text = hello.compactText
        for forbidden in ["userId", "user_id", "email", "token", "serverId", "channelId"] {
            XCTAssertFalse(text.contains(forbidden), "the hello must not carry \(forbidden)")
        }
    }

    func testAnUnusableLocaleFallsBackToEnglish() {
        XCTAssertEqual(AppBridge.safeLocale("pt-BR"), "pt-BR")
        XCTAssertEqual(AppBridge.safeLocale("not a locale"), "en")
    }

    // MARK: - state

    func testStateGetAnswersWithTheRevisionAndEchoesTheRequestType() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"r1","type":"state.get"}"#)
        XCTAssertEqual(out.last?["ok"]?.boolValue, true)
        XCTAssertEqual(last("type"), "state.get", "a success echoes the request type")
        XCTAssertEqual(out.last?["result"]?["rev"]?.intValue, 1)
        XCTAssertEqual(out.last?["result"]?["value"]?["count"]?.intValue, 1)
    }

    func testAStatePatchGoesToTheSessionAndAnswersWithTheServersRevision() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"p1","type":"state.patch","patch":{"count":2},"baseRev":1}"#)
        XCTAssertEqual(transport.patches.count, 1)
        XCTAssertEqual(transport.patches.first?.1, 1)
        XCTAssertEqual(out.last?["result"]?["rev"]?.intValue, 5)
    }

    func testAPatchThatWouldPassTheCapOnTheMERGEDStateIsRefusedBeforeItIsSent() async {
        let bridge = makeBridge()
        let big = String(repeating: "x", count: 80)
        await send(bridge, #"{"id":"p2","type":"state.patch","patch":{"big":"\#(big)"}}"#)
        XCTAssertEqual(last("error"), "too-large")
        XCTAssertTrue(transport.patches.isEmpty)
    }

    func testOnlyTheHostMayWriteWhenTheManifestSaysSo() async {
        let app = AppEntry(id: "x-app", state: AppStateCaps(maxBytes: 64, maxWritesPerSecond: 10, writers: "host"))
        let bridge = makeBridge(app: app, isHost: false)
        await send(bridge, #"{"id":"p3","type":"state.patch","patch":{"a":1}}"#)
        XCTAssertEqual(last("error"), "not-host")
    }

    func testASpectatorWritesAndSendsNothing() async {
        let bridge = makeBridge(role: .spectator, isHost: false)
        await send(bridge, #"{"id":"p4","type":"state.patch","patch":{"a":1}}"#)
        XCTAssertEqual(last("error"), "not-allowed")
        await send(bridge, #"{"id":"e4","type":"events.send","name":"ping","data":null}"#)
        XCTAssertEqual(last("error"), "not-allowed")
        XCTAssertTrue(transport.patches.isEmpty && transport.events.isEmpty)
    }

    func testAStaleRevisionFromTheServerIsPassedOnAsStaleRev() async {
        let bridge = makeBridge()
        transport.patchResult = .failure(AppTransportError(code: .staleRev))
        await send(bridge, #"{"id":"p5","type":"state.patch","patch":{"a":1},"baseRev":0}"#)
        XCTAssertEqual(last("error"), "stale-rev")
    }

    func testARevisionNeverGoesBackwardsAndADuplicateIsNotPushedTwice() {
        let bridge = makeBridge()
        bridge.applyState(rev: 3, value: .object(["a": .number(3)]))
        XCTAssertEqual(out.count, 1)
        bridge.applyState(rev: 3, value: .object(["a": .number(3)]))
        bridge.applyState(rev: 2, value: .object(["a": .number(2)]))
        XCTAssertEqual(out.count, 1, "a resume re-sends the same revision, and an old one is ignored")
        XCTAssertEqual(bridge.state.rev, 3)
    }

    // MARK: - events

    func testEventsAreCappedByBytesAndByRate() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"e1","type":"events.send","name":"ping","data":{"a":1}}"#)
        XCTAssertEqual(out.last?["ok"]?.boolValue, true)
        XCTAssertEqual(transport.events.first?.0, "ping")
        await send(bridge, #"{"id":"e2","type":"events.send","name":"ping","data":"\#(String(repeating: "y", count: 40))"}"#)
        XCTAssertEqual(last("error"), "too-large")
        await send(bridge, #"{"id":"e3","type":"events.send","name":"ping","data":1}"#)
        await send(bridge, #"{"id":"e5","type":"events.send","name":"ping","data":1}"#)
        XCTAssertEqual(last("error"), "rate-limited", "the bucket holds the manifest's two a second")
    }

    // MARK: - strictness

    func testAnUnknownKeyIsARejectionAnsweredInvalid() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"s1","type":"state.get","smuggled":"token"}"#)
        XCTAssertEqual(last("error"), "invalid")
    }

    func testAMalformedNameOrAnUnknownTypeIsInvalidAndNoIdMeansNoAnswer() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"s2","type":"events.send","name":"Bad Name","data":null}"#)
        XCTAssertEqual(last("error"), "invalid")
        out = []
        await send(bridge, #"{"id":"s3","type":"nope"}"#)
        XCTAssertEqual(last("error"), "invalid")
        out = []
        await send(bridge, #"{"type":"state.get"}"#)
        await send(bridge, "not json")
        XCTAssertTrue(out.isEmpty, "a request with no usable id cannot be answered")
    }

    func testAnIdOver32CharactersIsNotAnswered() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"\#(String(repeating: "i", count: 33))","type":"state.get"}"#)
        XCTAssertTrue(out.isEmpty)
    }

    func testAnOversizedMessageIsRefusedBeforeItIsParsedAndAnsweredWhenItsIdCanBeRead() async {
        let bridge = makeBridge()
        let huge = #"{"id":"big1","type":"events.send","name":"ping","data":""# + String(repeating: "z", count: AppBridge.maxMessageBytes) + #""}"#
        await send(bridge, huge)
        XCTAssertEqual(last("error"), "too-large")
        XCTAssertTrue(transport.events.isEmpty)
        XCTAssertEqual(AppBridge.idFragment(huge), "big1")
        XCTAssertNil(AppBridge.idFragment("no id in here"))
    }

    // MARK: - what this phone has no grant for

    func testFilesStoreSyncAssetsAndShareAreNotAllowedNotInvalid() async {
        let bridge = makeBridge()
        let requests = [
            #"{"id":"a1","type":"files.pickLocal"}"#,
            #"{"id":"a2","type":"store.get","key":"prefs"}"#,
            #"{"id":"a3","type":"store.usage"}"#,
            #"{"id":"a4","type":"sync.status"}"#,
            #"{"id":"a5","type":"assets.get","name":"core.bin"}"#,
            #"{"id":"a6","type":"share.request","on":true}"#,
            #"{"id":"a7","type":"store.put","key":"k","bytes":{"$bytes":4}}"#,
        ]
        for request in requests {
            await send(bridge, request)
            XCTAssertEqual(last("error"), "not-allowed", request)
        }
    }

    // MARK: - ui and end

    func testResizeFullscreenAndActivityAreServedAndRangeChecked() async {
        let bridge = makeBridge()
        var resized: Int?
        var activity: String?
        bridge.onResize = { resized = $0 }
        bridge.onActivity = { activity = $0 }
        await send(bridge, #"{"id":"u1","type":"ui.resize","height":400}"#)
        XCTAssertEqual(resized, 400)
        XCTAssertEqual(out.last?["result"]?["height"]?.intValue, 400)
        await send(bridge, #"{"id":"u2","type":"ui.resize","height":50}"#)
        XCTAssertEqual(last("error"), "invalid")
        await send(bridge, #"{"id":"u3","type":"ui.activity","state":"playing"}"#)
        XCTAssertEqual(activity, "playing")
        XCTAssertEqual(out.last?["result"], .null)
        await send(bridge, #"{"id":"u4","type":"ui.activity","state":"dancing"}"#)
        XCTAssertEqual(last("error"), "invalid")
        await send(bridge, #"{"id":"u5","type":"ui.fullscreen","on":true}"#)
        XCTAssertEqual(out.last?["result"]?["on"]?.boolValue, true)
    }

    func testOnlyTheHostEndsTheSession() async {
        let host = makeBridge(isHost: true)
        await send(host, #"{"id":"x1","type":"session.end"}"#)
        XCTAssertEqual(transport.ended, 1)
        XCTAssertEqual(out.last?["ok"]?.boolValue, true)

        let guest = makeBridge(isHost: false)
        await send(guest, #"{"id":"x2","type":"session.end"}"#)
        XCTAssertEqual(last("error"), "not-host")
        XCTAssertEqual(transport.ended, 0)
    }

    func testAfterTheSessionEndsEveryRequestIsEnded() async {
        let bridge = makeBridge()
        bridge.setEnded(.host)
        XCTAssertEqual(last("type"), "session.ended")
        XCTAssertEqual(out.last?["reason"]?.stringValue, "host")
        await send(bridge, #"{"id":"z1","type":"state.get"}"#)
        XCTAssertEqual(last("error"), "ended")
    }

    func testAConnectionDropRefusesWritesUntilItIsBack() async {
        let bridge = makeBridge()
        bridge.setConnection(online: false)
        XCTAssertEqual(out.last?["status"]?.stringValue, "reconnecting")
        await send(bridge, #"{"id":"c1","type":"state.patch","patch":{"a":1}}"#)
        XCTAssertEqual(last("error"), "unavailable")
        bridge.setConnection(online: true)
        await send(bridge, #"{"id":"c2","type":"state.patch","patch":{"a":1}}"#)
        XCTAssertEqual(out.last?["ok"]?.boolValue, true)
    }

    // MARK: - participants

    func testParticipantsAreBuiltFromScratchAndHeldUntilTheRosterIsReady() async {
        let bridge = makeBridge()
        await send(bridge, #"{"id":"g1","type":"participants.get"}"#)
        XCTAssertTrue(out.isEmpty, "waits for the first roster")
        bridge.setParticipants([
            BridgeParticipant(seatId: "AAAAAAAAAAAAAAAAAAAAAA", displayName: "Raf", avatar: nil, role: .player,
                              isHost: true, connection: .present, appUserId: nil),
        ])
        XCTAssertEqual(out.first?["type"]?.stringValue, "participants.get")
        XCTAssertEqual(out.first?["result"]?["participants"]?.compactText.contains("userId"), false)
        XCTAssertTrue(out.contains { $0["type"]?.stringValue == "participants" }, "and the roster is pushed too")
    }

    func testDisplayNamesAreCleanedOfControlAndBidiCharacters() {
        XCTAssertEqual(AppBridge.cleanDisplayName("  Raf\u{202E}evil\u{0007} "), "Rafevil")
        XCTAssertEqual(AppBridge.cleanDisplayName(nil), "?")
        XCTAssertEqual(AppBridge.cleanDisplayName("   "), "?")
        XCTAssertEqual(AppBridge.cleanDisplayName(String(repeating: "a", count: 100)).utf16.count, 64)
    }

    func testAvatarsPastTheRosterBudgetAreDroppedLargestFirst() {
        let small = BridgeParticipant(seatId: "a", displayName: "a", avatar: String(repeating: "x", count: 10),
                                      role: .player, isHost: false, connection: .present, appUserId: nil)
        let huge = BridgeParticipant(seatId: "b", displayName: "b", avatar: String(repeating: "y", count: AppLimits.avatarsBudgetChars),
                                     role: .player, isHost: false, connection: .present, appUserId: nil)
        let fitted = AppBridge.fitAvatarBudget([small, huge, small])
        XCTAssertNotNil(fitted[0].avatar)
        XCTAssertNil(fitted[1].avatar, "the largest goes first")
        XCTAssertNotNil(fitted[2].avatar)
    }
}
