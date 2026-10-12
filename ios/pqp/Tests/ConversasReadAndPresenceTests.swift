import XCTest
@testable import pqp

/// Conversas, three things the iOS QA pass found: a message that arrives in the
/// conversation you are looking at is read, the presence dot is spoken in words,
/// and the friends read behind "Online agora" has a rhythm.
@MainActor
final class ConversasReadAndPresenceTests: XCTestCase {
    private let me = "22222222-2222-4222-8222-222222222222"
    private let lu = "33333333-3333-4333-8333-333333333333"

    private func message(id: String, author: String, channel: String = "c") throws -> Message {
        let json = """
        {"id":"\(id)","channelId":"\(channel)","authorId":"\(author)","authorName":"Lu",
         "body":"oi","createdAt":"2026-10-12T12:00:00.000Z"}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    // MARK: - Read while open

    func testRuleReadsSomebodyElsesMessageOnlyWithTheAppInFront() throws {
        let theirs = try message(id: "a1", author: lu)
        XCTAssertTrue(ChatReadRules.shouldMarkRead(theirs, viewerId: me, appIsActive: true))
        XCTAssertFalse(ChatReadRules.shouldMarkRead(theirs, viewerId: me, appIsActive: false))
        let mine = try message(id: "a2", author: me)
        XCTAssertFalse(ChatReadRules.shouldMarkRead(mine, viewerId: me, appIsActive: true))
    }

    func testAMessageArrivingInTheOpenConversationMarksItRead() async throws {
        let model = ChatModel()
        var marked: [String] = []
        model.appIsActive = { true }
        model.markReadAction = { marked.append($0) }
        model.stage(channelId: "c", messages: [])
        model.apply(.messageCreated(try message(id: "a1", author: lu), nonce: nil))
        await waitUntil { !marked.isEmpty }
        XCTAssertEqual(marked, ["c"])
    }

    func testBehindTheLockScreenNothingIsMarked() async throws {
        let model = ChatModel()
        var marked: [String] = []
        model.appIsActive = { false }
        model.markReadAction = { marked.append($0) }
        model.stage(channelId: "c", messages: [])
        model.apply(.messageCreated(try message(id: "a1", author: lu), nonce: nil))
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(marked.isEmpty)
    }

    func testAReplayOfAMessageAlreadyOnScreenIsNotAskedAgain() async throws {
        let model = ChatModel()
        var marked: [String] = []
        model.appIsActive = { true }
        model.markReadAction = { marked.append($0) }
        let seen = try message(id: "a1", author: lu)
        model.stage(channelId: "c", messages: [seen])
        model.apply(.messageCreated(seen, nonce: nil))
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(marked.isEmpty)
    }

    func testAMessageForAnotherConversationIsIgnored() async throws {
        let model = ChatModel()
        var marked: [String] = []
        model.appIsActive = { true }
        model.markReadAction = { marked.append($0) }
        model.stage(channelId: "c", messages: [])
        model.apply(.messageCreated(try message(id: "a1", author: lu, channel: "other"), nonce: nil))
        try? await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(marked.isEmpty)
    }

    /// Nine messages while a write is in flight cost that write and one more,
    /// not nine.
    func testABurstIsCoalescedIntoOneFollowUpWrite() async throws {
        let model = ChatModel()
        var calls = 0
        model.appIsActive = { true }
        model.markReadAction = { _ in
            calls += 1
            try? await Task.sleep(for: .milliseconds(60))
        }
        model.stage(channelId: "c", messages: [])
        model.apply(.messageCreated(try message(id: "first", author: lu), nonce: nil))
        await waitUntil { calls == 1 }
        for index in 0..<9 {
            model.apply(.messageCreated(try message(id: "m\(index)", author: lu), nonce: nil))
        }
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(calls, 2)
    }

    // MARK: - The words for a presence dot

    func testPresenceTokensMapToWordsNotTheWireValue() {
        XCTAssertEqual(PresenceLabel("online"), .online)
        XCTAssertEqual(PresenceLabel("idle"), .idle)
        XCTAssertEqual(PresenceLabel("dnd"), .doNotDisturb)
        XCTAssertEqual(PresenceLabel("offline"), .offline)
        XCTAssertEqual(PresenceLabel("something-new"), .offline)
        XCTAssertEqual(PresenceLabel(nil), .offline)
    }

    // MARK: - Presence is refreshed on a rhythm

    func testTheListLooksForOnlineFriendsAtLeastEveryHalfMinute() {
        XCTAssertLessThanOrEqual(ConversasPresence.pollSeconds, 30)
        XCTAssertGreaterThanOrEqual(ConversasPresence.pollSeconds, 10)
    }
}
