import XCTest
@testable import pqp

/// What `message-rejected` does to the transcript, pinned by feeding the event
/// straight into `ChatModel.apply`.
///
/// The failure this guards against was invisible: the frame decoded to
/// `.other`, the optimistic row stayed dimmed at 55% forever, and the person
/// walked away believing the message had been sent. Nothing crashed, nothing
/// logged, and only a reconnect ever reaped the row.
@MainActor
final class MessageRejectionTests: XCTestCase {
    private func pendingRow(_ body: String, nonce: String) throws -> Message {
        let author = try Coding.decoder.decode(
            CurrentUser.self,
            from: Data(#"{"id":"a","clerkId":"ck","displayName":"Ana"}"#.utf8)
        )
        var row = Message(pendingBody: body, channelId: "c", author: author)
        row.pendingNonce = nonce
        return row
    }

    private func stored(id: String, body: String) throws -> Message {
        let json = """
        {"id":"\(id)","channelId":"c","authorId":"a","authorName":"Ana","body":"\(body)",
         "createdAt":"2026-08-01T10:00:00.000Z"}
        """
        return try Coding.decoder.decode(Message.self, from: Data(json.utf8))
    }

    /// The row whose nonce matches comes out, its text goes back into the
    /// composer, and the composer says why. Every other row stays.
    func testRejectionRemovesTheMatchingRowAndRestoresTheDraft() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [
            try stored(id: "m1", body: "earlier"),
            try pendingRow("hello there", nonce: "n1"),
            try pendingRow("still in flight", nonce: "n2"),
        ])

        model.apply(.messageRejected(MessageRejection(
            channelId: "c", nonce: "n1", reason: "no-access", retryAfterMs: nil
        )))

        XCTAssertEqual(model.messages.map(\.body), ["earlier", "still in flight"])
        XCTAssertEqual(model.draft, "hello there")
        XCTAssertEqual(model.error, ChatModel.rejectionCopy(for: "no-access"))
        XCTAssertFalse(model.isHeldBySlowMode)
    }

    /// Text typed after the send is not thrown away to make room for the
    /// rejected body; the rejected body goes in front of it.
    func testRestoredBodyGoesAheadOfWhatWasTypedSince() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [try pendingRow("first", nonce: "n1")], draft: "second")

        model.apply(.messageRejected(MessageRejection(
            channelId: "c", nonce: "n1", reason: "undeliverable", retryAfterMs: nil
        )))

        XCTAssertEqual(model.draft, "first\nsecond")
        XCTAssertTrue(model.messages.isEmpty)
    }

    /// A slow mode refusal starts the countdown the server named, and the
    /// composer is held for it.
    func testSlowModeRejectionHoldsTheComposerForRetryAfter() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [try pendingRow("too soon", nonce: "n1")])

        model.apply(.messageRejected(MessageRejection(
            channelId: "c", nonce: "n1", reason: "slow-mode", retryAfterMs: 7_400
        )))

        XCTAssertTrue(model.isHeldBySlowMode)
        // Rounded up: 7.4s left reads as 8, never as 7 while the server would
        // still refuse at 7.0.
        XCTAssertEqual(model.slowModeRemaining, 8)
        XCTAssertNotNil(model.slowModeNotice)
        XCTAssertEqual(model.draft, "too soon")
        XCTAssertEqual(model.error, ChatModel.rejectionCopy(for: "slow-mode"))
    }

    /// A refusal for some other channel is not this transcript's business,
    /// and one with no nonce cannot say which row it answers. Both leave the
    /// transcript alone rather than guessing.
    func testRejectionForAnotherChannelOrWithoutANonceIsIgnored() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [try pendingRow("hello", nonce: "n1")])

        model.apply(.messageRejected(MessageRejection(
            channelId: "other", nonce: "n1", reason: "no-access", retryAfterMs: nil
        )))
        model.apply(.messageRejected(MessageRejection(
            channelId: "c", nonce: nil, reason: "no-access", retryAfterMs: nil
        )))

        XCTAssertEqual(model.messages.count, 1)
        XCTAssertEqual(model.draft, "")
        XCTAssertNil(model.error)
    }

    /// A reason this build has never heard of is still a refusal: the row
    /// comes down and the text comes back, under the generic line.
    func testUnknownReasonStillRemovesTheRow() throws {
        let model = ChatModel()
        model.stage(channelId: "c", messages: [try pendingRow("hello", nonce: "n1")])

        model.apply(.messageRejected(MessageRejection(
            channelId: "c", nonce: "n1", reason: "some-future-token", retryAfterMs: nil
        )))

        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertEqual(model.draft, "hello")
        XCTAssertEqual(model.error, ChatModel.rejectionCopy(for: "some-future-token"))
    }

    /// `slowmodeSeconds` is on the channel shape and the API sends it. A
    /// synthesized `Codable` silently ignored the key, which is how a channel
    /// could be in slow mode and this app learn it only from a refusal. Absent
    /// (an older API, or a cached list from an older build) reads as off.
    func testChannelDecodesSlowmodeSecondsAndDefaultsItToOff() throws {
        let with = """
        {"id":"c1","serverId":"s","kind":"server","name":"general","type":"text",
         "position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null,
         "slowmodeSeconds":30}
        """
        let without = """
        {"id":"c2","serverId":"s","kind":"server","name":"general","type":"text",
         "position":0,"isPrivate":false,"topic":null,"imageUrl":null,"parentId":null}
        """
        XCTAssertEqual(try Coding.decoder.decode(Channel.self, from: Data(with.utf8)).slowmodeSeconds, 30)
        XCTAssertEqual(try Coding.decoder.decode(Channel.self, from: Data(without.utf8)).slowmodeSeconds, 0)
    }
}
