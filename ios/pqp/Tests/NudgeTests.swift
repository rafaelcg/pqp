import XCTest
@testable import pqp

/// Chamar a atenção on iOS: the wire shapes from `packages/shared/src/nudge.ts`
/// and the client's own rules (freshness, the button, the refusal lines). The
/// freshness table mirrors `isFreshNudge` in `nudge.test.ts`.
@MainActor
final class NudgeTests: XCTestCase {
    private let me = "22222222-2222-4222-8222-222222222222"
    private let lu = "33333333-3333-4333-8333-333333333333"

    private func message(
        id: String = "44444444-4444-4444-8444-444444444444",
        author: String? = nil,
        kind: String? = "nudge",
        createdAt: String = "2026-10-11T12:00:00.000Z"
    ) throws -> Message {
        let kindJSON = kind.map { #","systemKind":"\#($0)""# } ?? ""
        let json = """
        {"id":"\(id)","channelId":"c","authorId":"\(author ?? lu)","authorName":"Lu",
         "body":"📳","createdAt":"\(createdAt)"\(kindJSON)}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }

    private let now = ISO8601DateFormatter().date(from: "2026-10-11T12:00:05Z")!

    // MARK: - Decoding

    func testSystemKindDecodes() throws {
        XCTAssertTrue(try message().isNudge)
        XCTAssertFalse(try message(kind: nil).isNudge)
    }

    /// `.catch(null)` in the shared schema: a kind added later is an ordinary
    /// message, and never costs the decode.
    func testAnUnknownSystemKindIsAnOrdinaryMessage() throws {
        let unknown = try message(kind: "confetti")
        XCTAssertNil(unknown.systemKind)
        XCTAssertEqual(unknown.body, "📳")
    }

    func testFunConfigIsOffUnlessExplicitlyTrue() throws {
        XCTAssertTrue(try Coding.decoder.decode(FunConfig.self, from: Data(#"{"nudge":true,"retroLook":true}"#.utf8)).nudge)
        XCTAssertFalse(try Coding.decoder.decode(FunConfig.self, from: Data(#"{"nudge":false}"#.utf8)).nudge)
        XCTAssertFalse(try Coding.decoder.decode(FunConfig.self, from: Data("{}".utf8)).nudge)
        XCTAssertFalse(try Coding.decoder.decode(FunConfig.self, from: Data(#"{"nudge":"yes"}"#.utf8)).nudge)
    }

    func testAllowNudgesRoundTripsInPreferences() throws {
        let prefs = try Coding.decoder.decode(UserPreferences.self, from: Data(#"{"allowNudges":false}"#.utf8))
        XCTAssertEqual(prefs.allowNudges, false)
        XCTAssertFalse(NudgeRules.allowed(prefs))
        XCTAssertTrue(NudgeRules.allowed(UserPreferences()))
        XCTAssertTrue(NudgeRules.allowed(nil))
    }

    // MARK: - Freshness (isFreshNudge)

    func testShakesForAFreshNudgeFromSomebodyElse() throws {
        XCTAssertTrue(NudgeRules.isFresh(try message(), viewerId: me, now: now))
    }

    func testNeverForMyOwn() throws {
        XCTAssertFalse(NudgeRules.isFresh(try message(author: me), viewerId: me, now: now))
    }

    func testNeverForHistory() throws {
        let old = try message(createdAt: "2026-10-11T11:59:49.000Z")
        XCTAssertFalse(NudgeRules.isFresh(old, viewerId: me, now: now))
    }

    func testNeverForAnOrdinaryMessageThatSaysTheEmoji() throws {
        XCTAssertFalse(NudgeRules.isFresh(try message(kind: nil), viewerId: me, now: now))
    }

    /// A little slack below zero: the server's clock may be ahead of ours.
    func testToleratesAServerClockAhead() throws {
        let ahead = try message(createdAt: "2026-10-11T12:00:15.000Z")
        XCTAssertTrue(NudgeRules.isFresh(ahead, viewerId: me, now: now))
    }

    // MARK: - The button

    func testTheButtonIsForAFriendInAOneToOneWithTheFlagOn() {
        XCTAssertTrue(NudgeRules.offersButton(flagOn: true, conversationKind: "dm", otherIsFriend: true, preferences: nil))
        XCTAssertFalse(NudgeRules.offersButton(flagOn: false, conversationKind: "dm", otherIsFriend: true, preferences: nil))
        XCTAssertFalse(NudgeRules.offersButton(flagOn: true, conversationKind: "group", otherIsFriend: true, preferences: nil))
        XCTAssertFalse(NudgeRules.offersButton(flagOn: true, conversationKind: "dm", otherIsFriend: false, preferences: nil))
        var off = UserPreferences()
        off.allowNudges = false
        XCTAssertFalse(NudgeRules.offersButton(flagOn: true, conversationKind: "dm", otherIsFriend: true, preferences: off))
    }

    // MARK: - Refusals

    func testEveryReasonHasALineAndUnknownReadsAsUnavailable() {
        let reasons = ["cooldown", "unanswered", "busy", "self-off", "unavailable"]
        let lines = Set(reasons.map { NudgeRules.refusalCopy($0, name: "Lu") })
        XCTAssertEqual(lines.count, reasons.count, "Each reason says something different")
        XCTAssertEqual(NudgeRules.refusalCopy("something-new", name: "Lu"),
                       NudgeRules.refusalCopy("unavailable", name: "Lu"))
    }

    func testRefusalFrameDecodes() async throws {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(#"{"type":"nudge-refused","channelId":"c","nonce":"n1","reason":"cooldown","retryAfterMs":4200}"#.utf8))
        var iterator = stream.makeAsyncIterator()
        let event = await iterator.next()
        guard case .nudgeRefused(let refusal) = event else {
            return XCTFail("Expected nudgeRefused, got \(String(describing: event))")
        }
        XCTAssertEqual(refusal, NudgeRefusal(channelId: "c", nonce: "n1", reason: "cooldown", retryAfterMs: 4200))
    }

    func testARefusalLeavesALineAndACooldownRests() {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.nudgeTargetName = "Lu"
        model.apply(.nudgeRefused(NudgeRefusal(channelId: "c", nonce: nil, reason: "busy", retryAfterMs: nil)))
        XCTAssertEqual(model.nudgeNotice, NudgeRules.refusalCopy("busy", name: "Lu"))
        XCTAssertFalse(model.nudgeResting)
        model.apply(.nudgeRefused(NudgeRefusal(channelId: "c", nonce: nil, reason: "cooldown", retryAfterMs: 5000)))
        XCTAssertTrue(model.nudgeResting)
    }

    /// A late refusal, or one meant for another of this account's devices,
    /// does not touch the button.
    func testARefusalForAnotherNudgeIsIgnored() {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.expectNudgeAnswer(nonce: "mine")
        model.apply(.nudgeRefused(NudgeRefusal(channelId: "c", nonce: "someone-else", reason: "busy", retryAfterMs: nil)))
        XCTAssertNil(model.nudgeNotice)
        model.apply(.nudgeRefused(NudgeRefusal(channelId: "c", nonce: "mine", reason: "busy", retryAfterMs: nil)))
        XCTAssertNotNil(model.nudgeNotice)
        XCTAssertNil(model.pendingNudgeNonce)
    }

    func testARefusalForAnotherConversationIsIgnored() {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.apply(.nudgeRefused(NudgeRefusal(channelId: "other", nonce: nil, reason: "busy", retryAfterMs: nil)))
        XCTAssertNil(model.nudgeNotice)
    }

    // MARK: - The shake counter

    func testAFreshNudgeShakesOnceAndAReplayDoesNot() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        let fresh = try message(createdAt: ISO8601DateFormatter().string(from: Date()))
        model.apply(.messageCreated(fresh, nonce: nil))
        XCTAssertEqual(model.freshNudges, 1)
        model.apply(.messageCreated(fresh, nonce: nil))
        XCTAssertEqual(model.freshNudges, 1, "The same message again is not a second nudge")
        XCTAssertEqual(model.messages.count, 1)
    }

    func testAnOldNudgeIsALineOnly() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.apply(.messageCreated(try message(createdAt: "2020-01-01T00:00:00.000Z"), nonce: nil))
        XCTAssertEqual(model.freshNudges, 0)
        XCTAssertEqual(model.messages.count, 1)
    }

    func testCopyReadsLikeTheWeb() {
        XCTAssertEqual(NudgeRules.lineText(mine: true, name: "Lu"), String(localized: "You nudged \("Lu")."))
        XCTAssertEqual(NudgeRules.lineText(mine: false, name: "Lu"), String(localized: "\("Lu") nudged you!"))
    }
}
