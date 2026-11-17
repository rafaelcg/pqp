import XCTest
@testable import pqp

/// The activities wire (`packages/shared/src/apps/{config,frames}.ts`) decoded as
/// the server sends it, and the JSON helpers the bridge measures with.
final class ActivitiesContractTests: XCTestCase {
    static let sessionId = "51b6e4e6-eb87-444c-bde4-33d428704f17"
    static let channelId = "fcf7f5d8-b986-4441-9a2c-88f7f9db080b"
    static let userA = "04ae996c-1d17-4ac7-8b1d-a1b48c150083"
    static let userB = "a6b66f73-fcb5-4fce-9266-332d5cc6807b"

    static let summaryJSON = """
    {"id":"\(sessionId)","appId":"pqp-eco","appVersion":"1.0.2","startedBy":"\(userB)","hostUserId":"\(userB)",
     "startedAt":"2026-11-10T13:18:28.630Z","participants":[
       {"userId":"\(userA)","role":"player","joinedAt":"2026-11-10T13:19:00.000Z","connection":"present"},
       {"userId":"\(userB)","role":"spectator","joinedAt":"2026-11-10T13:19:01.000Z","connection":"reconnecting","extra":1}],
     "players":1,"spectators":1,"handoff":null,"somethingNewer":true}
    """

    func testAConfigDecodesAndOneUnreadableEntryDoesNotTakeTheRestWithIt() throws {
        let json = """
        {"enabled":true,"origin":"http://localhost:5185","apps":[
          {"id":"pqp-eco","version":"1.0.2","category":"tool","icon":"sparkles","name":"name","description":"description",
           "presence":{"phrase":"presence.phrase","short":"presence.short"},"channelTypes":["text","voice"],
           "players":{"min":1,"max":8,"spectators":true,"maxSpectators":50},
           "requires":{"start":"USE_APPS","join":"VIEW_CHANNEL"},
           "state":{"maxBytes":4096,"maxWritesPerSecond":10,"writers":"participants"},
           "events":{"maxPerSecond":10,"maxBytes":256},
           "capabilities":{"identity":"display","share":"none","localFiles":{"allowed":false},"peer":"none"},
           "hostBound":false,"i18n":{"pt-BR":{"name":"Eco","description":"Um teste"},"en":{"name":"Eco","description":"A test"}},
           "entry":{"url":"http://localhost:5185/pqp-eco/1.0.2/index.html"},"assets":[],
           "available":true,"reason":null,"shareAllowed":true,"saveSync":false,"sandbox":{"wasm":false}},
          {"nothing":"useful"},
          {"id":"pqp-new","available":false,"reason":"a-reason-from-the-future"}]}
        """
        let config = try Coding.decoder.decode(AppsConfig.self, from: Data(json.utf8))
        XCTAssertTrue(config.enabled)
        XCTAssertEqual(config.apps.map(\.id), ["pqp-eco", "pqp-new"], "the unreadable entry is dropped, not fatal")
        let eco = config.apps[0]
        XCTAssertEqual(eco.name(locale: "pt-BR"), "Eco")
        XCTAssertEqual(eco.summary(locale: "en"), "A test")
        XCTAssertEqual(eco.summary(locale: "fr"), "A test", "an unknown language reads English")
        XCTAssertEqual(eco.entryURL, "http://localhost:5185/pqp-eco/1.0.2/index.html")
        XCTAssertEqual(config.apps[1].reason, AppUnavailableReason.other, "a newer reason is not a crash")
        XCTAssertFalse(config.apps[1].available)
    }

    func testAConfigWithTheFlagOffAndAnEmptyBodyBothReadAsOff() throws {
        let off = try Coding.decoder.decode(AppsConfig.self, from: Data(#"{"enabled":false,"origin":null,"apps":[]}"#.utf8))
        XCTAssertEqual(off, .off)
        let empty = try Coding.decoder.decode(AppsConfig.self, from: Data("{}".utf8))
        XCTAssertFalse(empty.enabled)
    }

    func testLocaleResolutionMatchesTheWeb() {
        XCTAssertEqual(AppLocale.resolve("pt"), "pt-BR")
        XCTAssertEqual(AppLocale.resolve("pt_PT"), "pt-BR")
        XCTAssertEqual(AppLocale.resolve("es-MX"), "es")
        XCTAssertEqual(AppLocale.resolve("zh-Hans"), "en")
        XCTAssertEqual(AppLocale.resolve(""), "en")
    }

    func testChannelAppCarriesASessionAndANullMeansNoneIsLive() throws {
        let live = #"{"type":"channel-app","channelId":"\#(Self.channelId)","session":\#(Self.summaryJSON)}"#
        guard case .channelApp(let channel, let session)? = AppsFrame.parse(Data(live.utf8)) else { return XCTFail() }
        XCTAssertEqual(channel, Self.channelId)
        XCTAssertEqual(session?.id, Self.sessionId)
        XCTAssertEqual(session?.participants.count, 2)
        XCTAssertEqual(session?.participant(Self.userB)?.role, .spectator)
        XCTAssertEqual(session?.participant(Self.userB)?.connection, .reconnecting)
        XCTAssertTrue(session?.isSeated(Self.userA) == true)

        let none = #"{"type":"channel-app","channelId":"\#(Self.channelId)","session":null}"#
        guard case .channelApp(_, let nothing)? = AppsFrame.parse(Data(none.utf8)) else { return XCTFail() }
        XCTAssertNil(nothing)
    }

    func testAChannelAppWhoseSessionCannotBeReadIsDroppedNotReadAsEnded() {
        let broken = #"{"type":"channel-app","channelId":"\#(Self.channelId)","session":{"id":5}}"#
        XCTAssertNil(AppsFrame.parse(Data(broken.utf8)), "an unreadable session must not end a live one")
        let missing = #"{"type":"channel-app","channelId":"\#(Self.channelId)"}"#
        XCTAssertNil(AppsFrame.parse(Data(missing.utf8)))
    }

    func testTheSeatSnapshotCarriesTheStateWithItsRevision() throws {
        let json = """
        {"type":"app-session","sessionId":"\(Self.sessionId)","seatId":"maIXfX1VOIFNF9TUk0POhw","role":"player","isHost":false,
         "state":{"rev":3,"value":{"count":7,"nested":{"a":[1,2,null]}}},
         "participants":[{"seatId":"maIXfX1VOIFNF9TUk0POhw","userId":"\(Self.userA)","role":"player","isHost":false,"connection":"present"}]}
        """
        guard case .session(let seat)? = AppsFrame.parse(Data(json.utf8)) else { return XCTFail() }
        XCTAssertEqual(seat.stateRev, 3)
        XCTAssertEqual(seat.stateValue["count"]?.intValue, 7)
        XCTAssertEqual(seat.participants.first?.userId, Self.userA)
        XCTAssertFalse(seat.isHost)
    }

    func testStateEventEndedAndErrorFrames() throws {
        let state = #"{"type":"app-state","sessionId":"\#(Self.sessionId)","rev":4,"value":{"count":8}}"#
        guard case .state(_, let rev, let value)? = AppsFrame.parse(Data(state.utf8)) else { return XCTFail() }
        XCTAssertEqual(rev, 4)
        XCTAssertEqual(value["count"]?.intValue, 8)

        let event = #"{"type":"app-event","sessionId":"\#(Self.sessionId)","fromSeatId":"abcdefghijklmnop","name":"ping","data":{"at":1}}"#
        guard case .event(_, let from, let name, let data)? = AppsFrame.parse(Data(event.utf8)) else { return XCTFail() }
        XCTAssertEqual(from, "abcdefghijklmnop")
        XCTAssertEqual(name, "ping")
        XCTAssertEqual(data["at"]?.intValue, 1)

        let ended = #"{"type":"app-ended","sessionId":"\#(Self.sessionId)","channelId":"\#(Self.channelId)","reason":"host-gone","summary":{"participants":2,"durationSeconds":90,"result":{"text":"Raf won"}}}"#
        guard case .ended(_, _, let reason, let summary)? = AppsFrame.parse(Data(ended.utf8)) else { return XCTFail() }
        XCTAssertEqual(reason, .hostGone)
        XCTAssertEqual(summary.durationSeconds, 90)
        XCTAssertEqual(summary.resultText, "Raf won")

        let strange = #"{"type":"app-ended","sessionId":"\#(Self.sessionId)","channelId":"\#(Self.channelId)","reason":"from-the-future","summary":{}}"#
        guard case .ended(_, _, let future, _)? = AppsFrame.parse(Data(strange.utf8)) else { return XCTFail() }
        XCTAssertEqual(future, .unknown)

        let error = #"{"type":"app-error","sessionId":"\#(Self.sessionId)","op":"join","code":"full"}"#
        guard case .error(_, let op, let code)? = AppsFrame.parse(Data(error.utf8)) else { return XCTFail() }
        XCTAssertEqual(op, .join)
        XCTAssertEqual(code, .full)
    }

    func testEveryAppsFrameTypeIsListedForTheSocketToRoute() {
        XCTAssertEqual(AppsFrame.types, ["channel-app", "app-session", "app-state", "app-event", "app-ended", "app-error"])
    }

    // MARK: - JSON helpers

    func testCompactJSONMatchesWhatTheWebMeasures() {
        let value: JSONValue = .object(["b": .array([.number(1), .number(2.5), .null, .bool(true)]), "a": .string("x\"/\n")])
        XCTAssertEqual(AppJSON.compact(value), #"{"a":"x\"/\n","b":[1,2.5,null,true]}"#)
        XCTAssertEqual(AppJSON.byteCount(.string("é")), 4, "bytes are UTF-8: two quotes and a two byte letter")
    }

    func testMergePatchIsRFC7396() {
        let target: JSONValue = .object(["a": .number(1), "b": .object(["c": .number(2), "d": .number(3)])])
        let patch: JSONValue = .object(["a": .null, "b": .object(["c": .number(9)]), "e": .string("new")])
        let merged = AppJSON.mergePatch(target, with: patch)
        XCTAssertNil(merged["a"], "null deletes")
        XCTAssertEqual(merged["b"]?["c"]?.intValue, 9)
        XCTAssertEqual(merged["b"]?["d"]?.intValue, 3, "the rest of an object is kept")
        XCTAssertEqual(AppJSON.mergePatch(target, with: .array([.number(1)])), .array([.number(1)]), "a non-object replaces")
    }

    func testDepthAndSizeAreRefused() {
        var deep: JSONValue = .number(1)
        for _ in 0..<40 { deep = .array([deep]) }
        XCTAssertNotNil(AppJSON.problem(deep, maxBytes: 100_000))
        XCTAssertNotNil(AppJSON.problem(.string(String(repeating: "a", count: 300)), maxBytes: 256))
        XCTAssertNil(AppJSON.problem(.object(["a": .number(1)]), maxBytes: 256))
    }

    func testTheTokenBucketRefillsWithTime() {
        var clock = Date(timeIntervalSince1970: 1000)
        var bucket = AppTokenBucket(perSecond: 2, burst: 2, now: { clock })
        XCTAssertTrue(bucket.take())
        XCTAssertTrue(bucket.take())
        XCTAssertFalse(bucket.take())
        clock = clock.addingTimeInterval(0.5)
        XCTAssertTrue(bucket.take(), "half a second at 2 a second is one token")
        XCTAssertFalse(bucket.take())
    }
}
