import XCTest
@testable import pqp

/// Server bots, native v1: how one is recognised, what the limit notice says,
/// and that the frames decode without costing anything else.
final class ServerBotTests: XCTestCase {
    // MARK: - Detection

    func testABotFaceUrlIsABot() {
        XCTAssertTrue(ServerBot.isFaceAvatar("/api/bot-faces/lime/oi.png?v=1"))
        XCTAssertTrue(ServerBot.isFaceAvatar("/api/bot-faces/coral/focado.png"))
        XCTAssertTrue(ServerBot.isFaceAvatar("https://api.pqp.gg/api/bot-faces/sky/kkkk.png?v=1"))
        XCTAssertTrue(ServerBot.isFaceAvatar("http://localhost:3001/api/bot-faces/mint/bravo.png?v=2"))
    }

    func testEverythingElseIsNot() {
        XCTAssertFalse(ServerBot.isFaceAvatar(nil))
        XCTAssertFalse(ServerBot.isFaceAvatar(""))
        XCTAssertFalse(ServerBot.isFaceAvatar("/api/avatars/42"))
        XCTAssertFalse(ServerBot.isFaceAvatar("https://cdn.example.com/avatars/me.png"))
        // The marker somewhere other than the path's start.
        XCTAssertFalse(ServerBot.isFaceAvatar("/uploads/api/bot-faces/lime/oi.png"))
        XCTAssertFalse(ServerBot.isFaceAvatar("https://elsewhere.example/x?u=/api/bot-faces/lime/oi.png"))
        // Wrong shape under the marker.
        XCTAssertFalse(ServerBot.isFaceAvatar("/api/bot-faces/lime"))
        XCTAssertFalse(ServerBot.isFaceAvatar("/api/bot-faces/lime/oi.jpg"))
        XCTAssertFalse(ServerBot.isFaceAvatar("/api/bot-faces/lime/oi/extra.png"))
        XCTAssertFalse(ServerBot.isFaceAvatar("/api/bot-faces//oi.png"))
    }

    func testAMessageAndAMemberReadTheirAvatar() throws {
        let message = try Coding.decoder.decode(Message.self, from: Data("""
        {"id":"m","channelId":"c","authorId":"b","authorName":"Caio",
         "authorAvatarUrl":"/api/bot-faces/lime/oi.png?v=1","body":"oi",
         "createdAt":"2026-08-01T10:00:00.000Z"}
        """.utf8))
        XCTAssertTrue(message.isServerBot)
        let person = try Coding.decoder.decode(Message.self, from: Data("""
        {"id":"m","channelId":"c","authorId":"p","authorName":"Ana","body":"oi",
         "createdAt":"2026-08-01T10:00:00.000Z"}
        """.utf8))
        XCTAssertFalse(person.isServerBot)
    }

    // MARK: - Notice

    private func frame(reason: String, limit: String = "20", retryAt: String = "null") -> Data {
        Data("""
        {"type":"bot-notice","channelId":"c","botUserId":"b","botName":"Caio",
         "reason":"\(reason)","limit":\(limit),"retryAt":\(retryAt)}
        """.utf8)
    }

    func testEveryReasonParses() throws {
        for reason in ["busy", "member-hour", "server-day", "budget"] {
            let notice = try XCTUnwrap(BotNotice.parse(frame(reason: reason)), reason)
            XCTAssertEqual(notice.botName, "Caio")
            XCTAssertEqual(notice.channelId, "c")
            XCTAssertEqual(notice.botUserId, "b")
            XCTAssertFalse(notice.text().isEmpty)
            XCTAssertTrue(notice.text().contains("Caio"))
        }
    }

    func testAnUnknownReasonOrAMissingFieldIsDropped() {
        XCTAssertNil(BotNotice.parse(frame(reason: "full-moon")))
        XCTAssertNil(BotNotice.parse(Data(#"{"type":"bot-notice","reason":"busy"}"#.utf8)))
        XCTAssertNil(BotNotice.parse(Data("not json".utf8)))
    }

    func testNullLimitAndRetryAreFine() throws {
        let notice = try XCTUnwrap(BotNotice.parse(frame(reason: "busy", limit: "null")))
        XCTAssertNil(notice.limit)
        XCTAssertNil(notice.retryAt)
        XCTAssertFalse(notice.isExpired())
    }

    func testRetryTimeParsesAndExpires() throws {
        let notice = try XCTUnwrap(BotNotice.parse(
            frame(reason: "member-hour", retryAt: "\"2026-08-01T10:30:00.000Z\"")
        ))
        let retry = try XCTUnwrap(notice.retryAt)
        XCTAssertFalse(notice.isExpired(at: retry.addingTimeInterval(-1)))
        XCTAssertTrue(notice.isExpired(at: retry))
        // The sentence names the limit.
        XCTAssertTrue(notice.text().contains("20"))
    }

    // MARK: - Activity text

    func testThinkingHasNoToolAndAToolHasItsPhrase() {
        XCTAssertEqual(BotActivityText.line(tool: nil, name: "Caio"), String(localized: "Thinking…"))
        XCTAssertTrue(BotActivityText.line(tool: "create_channel", name: "Caio").contains("Caio"))
        XCTAssertNotEqual(
            BotActivityText.line(tool: "create_channel", name: "Caio"),
            BotActivityText.line(tool: "no_such_tool", name: "Caio")
        )
        XCTAssertEqual(
            BotActivityText.line(tool: "no_such_tool", name: "Caio"),
            String(localized: "Caio is working")
        )
    }

    // MARK: - Wire

    private func firstEvent(from json: String) async -> RealtimeEvent? {
        let client = RealtimeClient(backend: .local, tokenProvider: DevTokenProvider())
        let stream = await client.events()
        await client.ingest(Data(json.utf8))
        var iterator = stream.makeAsyncIterator()
        let waiter = Task { await iterator.next() }
        let timeout = Task {
            try? await Task.sleep(for: .seconds(2))
            waiter.cancel()
        }
        let event = await waiter.value
        timeout.cancel()
        return event
    }

    func testABotNoticeFrameBecomesAnEvent() async {
        let event = await firstEvent(from: String(decoding: frame(reason: "budget"), as: UTF8.self))
        guard case .botNotice(let notice)? = event else {
            return XCTFail("expected botNotice, got \(String(describing: event))")
        }
        XCTAssertEqual(notice.reason, .budget)
    }

    func testTypingWithActivityIsABotAndWithoutIsAPerson() async {
        let bot = await firstEvent(from: """
        {"type":"typing-broadcast","channelId":"c","userId":"b","displayName":"Caio",
         "activity":{"tool":null}}
        """)
        guard case .botActivity(_, let userId, _, let tool)? = bot else {
            return XCTFail("expected botActivity, got \(String(describing: bot))")
        }
        XCTAssertEqual(userId, "b")
        XCTAssertNil(tool)

        let working = await firstEvent(from: """
        {"type":"typing-broadcast","channelId":"c","userId":"b","displayName":"Caio",
         "activity":{"tool":"create_channel"}}
        """)
        guard case .botActivity(_, _, _, let named)? = working else {
            return XCTFail("expected botActivity")
        }
        XCTAssertEqual(named, "create_channel")

        let person = await firstEvent(from: """
        {"type":"typing-broadcast","channelId":"c","userId":"p","displayName":"Ana"}
        """)
        guard case .typing? = person else {
            return XCTFail("expected typing, got \(String(describing: person))")
        }

        // An activity this build cannot read costs the bot's row, not the frame.
        let odd = await firstEvent(from: """
        {"type":"typing-broadcast","channelId":"c","userId":"p","displayName":"Ana","activity":"???"}
        """)
        guard case .typing? = odd else {
            return XCTFail("expected typing, got \(String(describing: odd))")
        }
    }

    // MARK: - The chat model

    private func notice(retryAt: Date? = nil) -> BotNotice {
        BotNotice(channelId: "c", botUserId: "b", botName: "Caio", reason: .busy, limit: nil, retryAt: retryAt)
    }

    @MainActor
    func testTheNoticeIsShownForItsChannelOnlyAndEndsWhenTheBotSpeaks() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.apply(.botNotice(BotNotice(
            channelId: "other", botUserId: "b", botName: "Caio", reason: .busy, limit: nil, retryAt: nil
        )))
        XCTAssertNil(model.botNotice)

        model.apply(.botNotice(notice()))
        XCTAssertNotNil(model.botNotice)

        let reply = try Coding.decoder.decode(Message.self, from: Data("""
        {"id":"m","channelId":"c","authorId":"b","authorName":"Caio","body":"oi",
         "createdAt":"2026-08-01T10:00:00.000Z"}
        """.utf8))
        model.apply(.messageCreated(reply, nonce: nil))
        XCTAssertNil(model.botNotice)
    }

    @MainActor
    func testANoticeAlreadyPastItsRetryTimeIsNotShown() {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.apply(.botNotice(notice(retryAt: Date().addingTimeInterval(-5))))
        XCTAssertNil(model.botNotice)
    }

    @MainActor
    func testABotWorksUntilItsMessageArrives() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.apply(.botActivity(channelId: "c", userId: "b", displayName: "Caio", tool: nil))
        model.apply(.typing(channelId: "c", userId: "p", displayName: "Ana"))
        XCTAssertEqual(model.botWorkRows.map(\.name), ["Caio"])
        // A bot never lands in the people who are typing.
        XCTAssertEqual(Array(model.typingNames.keys), ["Ana"])

        model.apply(.botActivity(channelId: "c", userId: "b", displayName: "Caio", tool: "create_channel"))
        XCTAssertEqual(model.botWorkRows.first?.tool, "create_channel")

        let reply = try Coding.decoder.decode(Message.self, from: Data("""
        {"id":"m","channelId":"c","authorId":"b","authorName":"Caio","body":"feito",
         "createdAt":"2026-08-01T10:00:00.000Z"}
        """.utf8))
        model.apply(.messageCreated(reply, nonce: nil))
        XCTAssertTrue(model.botWorkRows.isEmpty)
    }

    @MainActor
    func testBotActivityInAnotherChannelIsIgnored() {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [])
        model.apply(.botActivity(channelId: "elsewhere", userId: "b", displayName: "Caio", tool: nil))
        XCTAssertTrue(model.botWorkRows.isEmpty)
    }
}
